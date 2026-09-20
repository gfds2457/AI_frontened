/**
 * 路径引用解析 —— 消息发送前把正文里出现的「文件路径」读出来拼进消息。
 *
 * 识别规则与输入框的浅蓝框完全一致（都走 pathToken），所以：被框住的路径一定会被读取。
 * 项目内、项目外的路径一视同仁（拖拽进来的通常是项目外的绝对路径），
 * 裸路径（拖进来的一串路径）与 @引用 也一视同仁。
 */
import fs from 'node:fs';
import path from 'node:path';
import { BASE } from './fileBrowser.js';
import { findPathTokens, trimPunct, REF_RE } from './pathToken.js';

// 超过该大小的文件不拼内容，仅提示（避免把超大文件灌给模型）
export const MAX_FILE_SIZE = 500 * 1024;

// 二进制扩展名：按 utf8 读出来是乱码，直接跳过。图片走不到这里——
// resolveImageRefs 会先把图片路径摘出去作为多模态图片发送
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif', '.svg',
  '.pdf', '.zip', '.gz', '.rar', '.7z', '.exe', '.dll', '.node', '.wasm',
  '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.mov', '.avi',
  '.xlsx', '.xls', '.docx', '.doc', '.pptx', '.ppt',
]);

/** 展示用路径：项目内用相对路径，项目外用绝对路径（都用正斜杠） */
function labelOf(abs) {
  const rel = path.relative(BASE, abs);
  const inside = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  return (inside ? rel : abs).replace(/\\/g, '/');
}

/**
 * 解析文本中的路径标记并拼装内容。
 * @param {string} text 用户原始输入
 * @returns {{ text: string, warnings: string[], refs: string[] }}
 *   text：原文本 + 每个命中文件/目录的内容块（追加在末尾）；
 *   warnings：超限/二进制/读取失败的提示（不影响原文本继续发送）；
 *   refs：命中的「项目内相对路径」（正斜杠），供规则匹配使用。
 */
export function resolveRefs(text) {
  const warnings = [];
  const blocks = [];
  const refs = [];
  const seen = new Set();
  const tokens = findPathTokens(text);

  // 手打的 @引用 没命中多半是路径打错了，给一行提示（裸路径是随口提到的，静默处理）
  for (const m of text.matchAll(REF_RE)) {
    if (m[0][0] !== '@') continue;
    if (tokens.some((t) => m.index >= t.start && m.index < t.end)) continue;
    const token = trimPunct(m[1]);
    if (token.includes('/')) warnings.push(`@${token}（未找到该文件，忽略）`);
  }

  for (const t of tokens) {
    if (seen.has(t.abs)) continue; // 同一文件被多次提到（@x 与 x）只读一次
    seen.add(t.abs);
    const label = labelOf(t.abs);

    if (t.isDir) {
      let names;
      try {
        names = fs.readdirSync(t.abs, { withFileTypes: true });
      } catch {
        warnings.push(`${t.raw}（目录读取失败，忽略）`);
        continue;
      }
      const list = names.map((d) => `- ${d.name}${d.isDirectory() ? '/' : ''}`).join('\n');
      blocks.push(`\n\n### 目录：${label}\n${list}`);
      continue;
    }

    if (t.size > MAX_FILE_SIZE) {
      warnings.push(`${t.raw}（文件超过 500KB，未读取）`);
      continue;
    }
    if (BINARY_EXTS.has(path.extname(t.abs).toLowerCase())) {
      warnings.push(`${t.raw}（二进制文件，未按文本读取）`);
      continue;
    }

    let content;
    try {
      content = fs.readFileSync(t.abs, 'utf8');
    } catch {
      warnings.push(`${t.raw}（读取失败，忽略）`);
      continue;
    }

    blocks.push(`\n\n### 文件：${label}\n\`\`\`\n${content}\n\`\`\``);
    if (label !== t.abs.replace(/\\/g, '/')) refs.push(label); // 项目外的路径不参与规则匹配
  }

  return { text: text + blocks.join(''), warnings, refs };
}
