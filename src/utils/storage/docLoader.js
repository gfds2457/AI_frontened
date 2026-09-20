/**
 * doc 文档读取器 —— 步骤 1（读取 + 解析 + 切块）。
 *
 * 从 ~/.front/doc 与 <cwd>/.front/doc 两个目录（可覆盖）递归读取
 * .docx / .xlsx / .md / .txt / .text 文件，用对应解析器转成纯文本，
 * 再交给 @langchain 的 RecursiveCharacterTextSplitter 切块，
 * 产出 langchain Document[]，每块的 metadata.source 记录源文件绝对路径。
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Document } from '@langchain/core/documents';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import mammoth from 'mammoth';
import XLSX from 'xlsx';

/** 允许索引的文件后缀（.txt 与 .text 同视为纯文本） */
export const ALLOWED_EXTS = new Set(['.md', '.txt', '.text', '.docx', '.xlsx']);

/** 默认 doc 目录：用户全局 ~/.front/doc + 当前项目 <cwd>/.front/doc */
export function defaultDocDirs(cwd = process.cwd()) {
  return [path.join(os.homedir(), '.front', 'doc'), path.join(cwd, '.front', 'doc')];
}

/** 递归收集目录下所有允许后缀的文件绝对路径（目录不存在/无权限时静默跳过） */
export async function collectDocFiles(dirs) {
  const files = [];
  const walk = async (dir) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && ALLOWED_EXTS.has(path.extname(e.name).toLowerCase())) files.push(p);
    }
  };
  for (const dir of dirs) await walk(dir);
  return files.sort();
}

/** 单个文件按后缀转纯文本：docx→mammoth / xlsx→xlsx / md、txt、text→utf-8 */
export async function fileToText(filePath) {
  const buf = await fs.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.docx') {
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return value;
  }
  if (ext === '.xlsx') {
    const wb = XLSX.read(buf, { type: 'buffer' });
    return wb.SheetNames.map((name) => {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
      return rows.map((r) => (Array.isArray(r) ? r.join('\t') : String(r))).join('\n');
    }).join('\n\n');
  }
  return buf.toString('utf8'); // md / txt / text
}

/** 解析给定文件列表为 Document（解析失败的文件仅告警跳过），空内容不收录 */
async function buildDocuments(files) {
  const docs = [];
  for (const file of files) {
    try {
      const pageContent = (await fileToText(file)).trim();
      if (pageContent) docs.push(new Document({ pageContent, metadata: { source: file } }));
    } catch (err) {
      console.warn(`⚠ 解析失败跳过 ${file} -> ${err.message}`);
    }
  }
  return docs;
}

/** 按块参数切分 Document 列表（中文优先按句末标点切块，减少跨句断句） */
function chunkDocuments(docs, opts = {}) {
  const { chunkSize = 500, chunkOverlap = 50 } = opts;
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
    separators: ['\n\n', '\n', '。', '！', '？', '；', ' ', ''],
  });
  return splitter.splitDocuments(docs);
}

/**
 * 读取 doc 目录下全部文件并切块。
 * @param {string[]} [dirs=defaultDocDirs()] doc 目录列表
 * @param {{chunkSize?: number, chunkOverlap?: number}} [opts]
 * @returns {Promise<import('@langchain/core/documents').Document[]>}
 */
export async function loadDocuments(dirs = defaultDocDirs(), opts = {}) {
  return chunkDocuments(await buildDocuments(await collectDocFiles(dirs)), opts);
}

/**
 * 只对指定文件列表解析并切块（跳过 doc 目录过滤，用于「只存储某文件」）。
 * @param {string[]} files 文件绝对路径列表
 * @param {{chunkSize?: number, chunkOverlap?: number}} [opts]
 * @returns {Promise<import('@langchain/core/documents').Document[]>}
 */
export async function loadFiles(files, opts = {}) {
  return chunkDocuments(await buildDocuments(files), opts);
}
