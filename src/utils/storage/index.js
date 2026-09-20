/**
 * 向量知识库构建入口 —— 步骤 3（lancedb 存储）+ 三合一集成函数。
 * 供后续「向量存储」指令 / 工具直接调用 buildKnowledgeBase()。
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import * as lancedb from '@lancedb/lancedb';
import { defaultDocDirs, loadDocuments, loadFiles } from './docLoader.js';
import { createEmbeddings, embedTexts } from './embedder.js';
import { loadFrontConfig } from '../fs/pathUtils.js';

/**
 * 向量库根目录。注意：项目所在 E: 盘是 FAT32 可移动盘，无法支撑 lancedb 的原子提交
 * （写入报 “Unable to copy file … 函数不正确 os error 1”），因此落到 NTFS 的 D 盘，
 * 与现有聊天记录目录 D:/frontCode/convert 保持一致。
 */
export const VECTOR_ROOT = path.join('D:/frontCode', 'vector_store');

/**
 * 解析向量库落盘路径，优先级：
 *  1) 显式 dbPath（buildKnowledgeBase 入参）
 *  2) setting.json 里的 vectorStorePath
 *  3) 默认 VECTOR_ROOT/<当前项目目录名>（按项目分子库，互不干扰）
 */
export async function resolveDbPath(cwd = process.cwd()) {
  const cfg = await loadFrontConfig(cwd);
  if (cfg.vectorStorePath) return cfg.vectorStorePath;
  return path.join(VECTOR_ROOT, path.basename(cwd));
}

/** 写入 lancedb：表不存在则建表；已存在按 mode 追加或整体覆盖 */
async function storeRows(dbPath, tableName, rows, mode) {
  const db = await lancedb.connect(dbPath);
  try {
    const tables = await db.tableNames();
    if (tables.includes(tableName)) {
      const table = await db.openTable(tableName);
      await table.add(rows, { mode });
    } else {
      await db.createTable(tableName, rows);
    }
  } finally {
    db.close(); // 同步释放连接句柄，避免长驻进程重复建库时残留
  }
}

/**
 * 三合一：读取 doc 文件并切块 → 向量化 → 存入 lancedb（文本与源文件路径一并入库）。
 * 传入 files 时只索引这些文件，忽略 docDirs。
 * @param {{
 *   docDirs?: string[],                        // 覆盖默认 doc 目录
 *   files?: string[],                          // 只索引指定文件（覆盖 docDirs）
 *   dbPath?: string,                           // 覆盖默认落盘目录
 *   tableName?: string,                        // 表名，默认 knowledge
 *   mode?: 'append' | 'overwrite',             // 已有表时追加或整体重建，默认 overwrite
 *   chunkSize?: number, chunkOverlap?: number,
 * }} [opts]
 * @returns {Promise<{ok: boolean, reason?: string, fileCount?: number, chunkCount?: number, dbPath: string, tableName?: string}>}
 */
export async function buildKnowledgeBase(opts = {}) {
  const {
    docDirs = defaultDocDirs(),
    files,
    dbPath: dbPathOpt,
    tableName = 'knowledge',
    mode = 'overwrite',
    chunkSize,
    chunkOverlap,
  } = opts;
  const dbPath = dbPathOpt || (await resolveDbPath());

  // 1) 读取 + 解析 + 切块（files 优先，其次 doc 目录）
  let docs;
  if (files?.length) {
    for (const f of files) {
      try {
        await fs.access(f);
      } catch {
        return { ok: false, reason: `文件不存在：${f}`, dbPath };
      }
    }
    docs = await loadFiles(files, { chunkSize, chunkOverlap });
  } else {
    docs = await loadDocuments(docDirs, { chunkSize, chunkOverlap });
  }
  const fileCount = new Set(docs.map((d) => d.metadata.source)).size;
  if (!docs.length) return { ok: false, reason: 'doc 目录下没有可索引的文件', dbPath };

  // 2) 向量化全部切块
  const embeddings = await createEmbeddings();
  const vectors = await embeddings.embedDocuments(docs.map((d) => d.pageContent));

  // 3) 存入 lancedb，每行保留文本 + 源文件路径
  const rows = docs.map((d, i) => ({
    text: d.pageContent,
    source: d.metadata.source, // 源文件绝对路径
    vector: Float32Array.from(vectors[i]),
  }));
  await storeRows(dbPath, tableName, rows, mode);

  return { ok: true, fileCount, chunkCount: rows.length, dbPath, tableName };
}

/**
 * 向量检索：把用户问题转向量 → 到 lancedb 最近邻搜索 → 只取命中的文本内容返回。
 * 向量列不会返回（避免把向量喂给大模型），未建库 / 无该表时返回空数组。
 * @param {string} query 用户问题
 * @param {{dbPath?: string, tableName?: string, topK?: number}} [opts]
 * @returns {Promise<string[]>} 命中的文本块数组
 */
export async function searchKnowledgeBase(query, opts = {}) {
  const { dbPath = await resolveDbPath(), tableName = 'knowledge', topK = 5 } = opts;
  if (!query?.trim()) return [];

  // 1) 用户问题 → 向量（复用 embedTexts）
  const [vector] = await embedTexts([query.trim()]);

  // 2) 在 lancedb 中查最近邻
  const db = await lancedb.connect(dbPath);
  try {
    const tables = await db.tableNames();
    if (!tables.includes(tableName)) return [];
    const table = await db.openTable(tableName);
    const rows = await table.search(vector).limit(topK).toArray();
    // 3) 只提取文本，丢向量
    return rows.map((r) => r.text).filter(Boolean);
  } finally {
    db.close();
  }
}

export { defaultDocDirs, loadDocuments, createEmbeddings, embedTexts };
