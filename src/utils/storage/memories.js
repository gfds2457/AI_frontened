/**
 * 记忆生成 —— 组装 src/docs/memoryTemplate.md 的提示词。
 * 依次读取 用户级/项目级 记忆文件与自定义上下文，再合并最近对话记录，
 * 把模板里的 5 个占位符替换为实际内容，返回可直接交给大模型生成记忆的完整提示词。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLOBAL_CONFIG_DIR } from '../fs/pathUtils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 本文件位于 src/utils/storage/，上溯两级到 src/ 再进入 docs/
const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'docs', 'memoryTemplate.md');
// 记忆文件目录名与文件名（两级均为 .front/memories/memories.md）
const MEMORIES_DIR = 'memories';
const MEMORIES_FILE = 'memories.md';
// 聊天记录根目录：每个会话一个时间戳文件夹，内含 conversation.json。
// 与 storage/index.js 的 VECTOR_ROOT 注释一致，记录落在 D:/frontCode/convert。
const RECORDS_ROOT = path.join('D:/frontCode', 'convert');
// 默认取最近 N 条对话记录
const RECORD_LIMIT = 20;

/** 读取文件文本；文件不存在或读取失败返回空串，避免中断上层流程 */
async function readTextSafe(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

/**
 * 读取两级记忆内容（步骤1）。
 * @param {string} [cwd] 当前项目目录，默认 process.cwd()
 * @returns {Promise<{userMemory: string, projectMemory: string}>}
 */
export async function getMemories(cwd = process.cwd()) {
  return {
    userMemory: await readTextSafe(path.join(GLOBAL_CONFIG_DIR, MEMORIES_DIR, MEMORIES_FILE)),
    projectMemory: await readTextSafe(path.join(cwd, '.front', MEMORIES_DIR, MEMORIES_FILE)),
  };
}

/**
 * 读取两级自定义上下文（步骤2）：用户级 ~/.front/.front.md 与项目级 <cwd>/.front.md。
 * @param {string} [cwd] 当前项目目录，默认 process.cwd()
 * @returns {Promise<{userMd: string, projectMd: string}>}
 */
export async function getContexts(cwd = process.cwd()) {
  return {
    userMd: await readTextSafe(path.join(GLOBAL_CONFIG_DIR, '.front.md')),
    projectMd: await readTextSafe(path.join(cwd, '.front.md')),
  };
}

/**
 * 读取最近对话记录（步骤3）：扫描 recordsRoot 下各会话 conversation.json，
 * 按 savedAt 从旧到新合并，只取 user / assistant 的非空文本对话，返回最近 limit 条，
 * 每条形如 “role: 内容”。目录不存在、无会话或读取失败时返回空串。
 * @param {string} [recordsRoot] 会话记录根目录，默认 D:/frontCode/convert
 * @param {number} [limit] 取最近多少条，默认 20
 * @returns {Promise<string>}
 */
export async function getRecentRecords(recordsRoot = RECORDS_ROOT, limit = RECORD_LIMIT) {
  let names;
  try {
    names = await fs.readdir(recordsRoot, { withFileTypes: true });
  } catch {
    return '';
  }

  // 1) 读取所有会话文件，按保存时间升序排列（保持同会话内消息原有顺序）
  const sessions = [];
  for (const ent of names) {
    if (!ent.isDirectory()) continue;
    try {
      const raw = await fs.readFile(path.join(recordsRoot, ent.name, 'conversation.json'), 'utf8');
      sessions.push(JSON.parse(raw));
    } catch {
      /* 单个会话文件缺失或损坏则跳过 */
    }
  }
  sessions.sort((a, b) => new Date(a.savedAt) - new Date(b.savedAt));

  // 2) 抽取真实问答，排除 system / tool 角色与空内容
  const turns = [];
  for (const session of sessions) {
    for (const m of session.messages || []) {
      if (
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.trim()
      ) {
        turns.push(`${m.role}: ${m.content.trim()}`);
      }
    }
  }

  // 3) 返回最近 limit 条
  return turns.slice(-limit).join('\n\n');
}

/**
 * 集成入口：读 memoryTemplate.md，把记忆、上下文、对话记录填入占位符后返回完整内容。
 * 模板缺失时返回空串，由调用方决定是否降级。
 * @param {string} [cwd] 当前项目目录，默认 process.cwd()
 * @param {{recordsRoot?: string, recordLimit?: number}} [opts] 覆盖对话记录目录与条数
 * @returns {Promise<string>} 已替换占位符的完整模板内容
 */
export async function buildMemoryPrompt(cwd = process.cwd(), opts = {}) {
  const [template, { userMemory, projectMemory }, { userMd, projectMd }, record] =
    await Promise.all([
      readTextSafe(TEMPLATE_PATH),
      getMemories(cwd),
      getContexts(cwd),
      getRecentRecords(opts.recordsRoot, opts.recordLimit),
    ]);
  if (!template) return '';

  // 占位符沿用模板原文拼写（userMeory / projectMeory 系模板固有写法，勿改动）
  return template
    .replaceAll('${projectMeory}', projectMemory)
    .replaceAll('${userMeory}', userMemory)
    .replaceAll('${projectMd}', projectMd)
    .replaceAll('${userMd}', userMd)
    .replaceAll('${record}', record);
}
