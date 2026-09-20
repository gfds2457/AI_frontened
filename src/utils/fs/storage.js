import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 默认存储根路径：系统用户目录下的 convert 文件夹 */
export const DEFAULT_STORAGE_PATH = path.join(os.homedir(), 'convert');

/** 对话记录文件名：同一个 sessionId 的对话始终存到这一个文件 */
const CONVERSATION_FILE = 'conversation.json';

// 用时间戳生成 sessionId，格式：20260902_153045_123（年月日_时分秒_毫秒）
export function createSessionId() {
  const d = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}` +
    `_${pad(d.getMilliseconds(), 3)}`
  );
}

// 存储对话历史到指定路径下的 sessionId 文件夹中
export async function saveMessages(messages, storagePath, sessionId) {
  // 存储根目录：用户指定路径优先，否则用默认 ~/convert
  const root = storagePath || DEFAULT_STORAGE_PATH;
  // 以 sessionId 命名的会话文件夹
  const sessionDir = path.join(root, sessionId);
  // 不存在则递归新建
  await fs.mkdir(sessionDir, { recursive: true });

  const filePath = path.join(sessionDir, CONVERSATION_FILE);
  const data = {
    sessionId,
    savedAt: new Date().toISOString(),
    messages,
  };
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
  return filePath;
}
