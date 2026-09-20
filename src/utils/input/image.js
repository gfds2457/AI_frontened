/**
 * # 图片引用 —— 「# 图片选择」浮层的数据源 + 消息发送前的图片解析。
 *
 * 识别规则与输入框的浅蓝框、发送前的读文件共用一套（都走 pathToken），所以：
 * 被框住的图片一定会作为多模态图片发给模型，不会出现「框了不读、读了不框」。
 * 因此下面既认 `#.front/design/x.png` 这种显式引用，也认从资源管理器拖进来的
 * 任意绝对路径（项目外的图片同样有效，拖拽本来就是项目外路径居多）。
 *
 * listDesignImages() 供输入控制器按 # 弹出选择浮层用（返回相对 design 目录的路径）；
 * resolveImageRefs() 把命中的图片读成 base64 图片块，并从正文里摘出、其余文字原样保留。
 *
 * 注意：图片随文字一起发给大模型，要求所配模型具备视觉能力。
 */
import fs from 'node:fs';
import path from 'node:path';
import { BASE } from '../fs/fileBrowser.js';
import { findPathTokens } from '../fs/pathToken.js';

/** .front/design 目录绝对路径（# 浮层在此范围内找图，返回的也是相对它的路径） */
export const DESIGN_DIR = path.join(BASE, '.front', 'design');

/** .front/design/AI-asset 目录绝对路径（AI 生成的素材图都落在这里） */
export const ASSET_DIR = path.join(DESIGN_DIR, 'AI-asset');

/** .front/design/AI-image 目录绝对路径（AI 生成的整页设计稿落在这里，与素材图分开放） */
export const AI_IMAGE_DIR = path.join(DESIGN_DIR, 'AI-image');

/** 支持的图片扩展名（大小写不敏感） */
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.avif']);

/** 扩展名 -> MIME 类型（用于拼 data URI） */
const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  avif: 'image/avif',
};

/** 单张图片体积上限，超过则跳过（base64 会再膨胀 ~33%） */
export const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

/** 递归收集 design 目录下所有图片，返回相对 design 目录的路径（正斜杠，含子目录） */
function walk(relDir) {
  const out = [];
  let names;
  try {
    names = fs.readdirSync(path.join(DESIGN_DIR, relDir), { withFileTypes: true });
  } catch {
    return out; // 目录缺失 / 读取失败都视为无图
  }
  for (const d of names) {
    const rel = relDir ? `${relDir}/${d.name}` : d.name;
    if (d.isDirectory()) out.push(...walk(rel));
    else if (d.isFile() && IMAGE_EXTS.has(path.extname(d.name).toLowerCase())) out.push(rel);
  }
  return out;
}

/** 供 # 浮层使用的图片清单（相对 .front/design，排序稳定） */
export function listDesignImages() {
  return walk('').sort((a, b) => a.localeCompare(b));
}

/** 展示用路径：项目内用相对路径，项目外用绝对路径（都用正斜杠） */
function labelOf(abs) {
  const rel = path.relative(BASE, abs);
  const inside = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  return (inside ? rel : abs).replace(/\\/g, '/');
}

/**
 * 读取一张图片并拼成 data URI；失败返回 null（调用方负责给提示）。
 * 导出给「让视觉模型看一张图」的场景复用（如 utils/image/describe.js）。
 */
export function toDataUri(abs) {
  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return null;
  }
  const ext = path.extname(abs).slice(1).toLowerCase();
  return `data:${MIME[ext] || 'application/octet-stream'};base64,${buf.toString('base64')}`;
}

/**
 * 解析正文中的图片引用。
 * @param {string} text 用户原始输入（可能含 # 引用，也可能是拖进来的图片路径）
 * @returns {{ text: string, images: {path:string, dataUri:string}[], warnings: string[] }}
 *   text：摘除「确实是图片」的路径后保留的正文；
 *   images：命中图片的展示路径与 base64 data URI；
 *   warnings：超限/读取失败等提示。
 * 未指向真实文件的片段（hex 色值、标题、不存在的路径）原样保留，不打扰用户。
 */
export function resolveImageRefs(text) {
  const warnings = [];
  const images = [];
  const cuts = []; // 需要从正文里摘掉的区间
  const seen = new Set();

  for (const t of findPathTokens(text)) {
    if (t.isDir) continue; // 目录交给 fileReference 出清单
    if (!IMAGE_EXTS.has(path.extname(t.abs).toLowerCase())) continue; // 非图片按文本读

    cuts.push(t);
    if (seen.has(t.abs)) continue; // 同一张图提到多次只发一份
    seen.add(t.abs);

    if (t.size > MAX_IMAGE_SIZE) {
      warnings.push(`${t.raw}（图片超过 ${MAX_IMAGE_SIZE / 1024 / 1024}MB，已忽略）`);
      continue;
    }
    const dataUri = toDataUri(t.abs);
    if (!dataUri) {
      warnings.push(`${t.raw}（读取失败，忽略）`);
      continue;
    }
    images.push({ path: labelOf(t.abs), dataUri });
  }

  // 摘除命中的片段：倒序下标才不会互相错位。
  // 拖拽进来的路径常被终端加引号，标记本身不含引号，摘完会剩一对空引号，一并带走；
  // 再顺手吃掉紧跟其后的一个空格，避免正文里留一段突兀的空白。
  let cleaned = text;
  for (const t of [...cuts].sort((a, b) => b.start - a.start)) {
    let start = t.start;
    let end = t.end;
    const quote = text[start - 1];
    if ((quote === '"' || quote === "'") && text[end] === quote) {
      start -= 1;
      end += 1;
    }
    if (text[end] === ' ') end += 1;
    cleaned = cleaned.slice(0, start) + cleaned.slice(end);
  }

  return { text: cleaned, images, warnings };
}
