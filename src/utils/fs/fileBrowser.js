/**
 * 目录树浏览 —— 供 @ 选文件的浮层使用。
 * 只列出项目根目录（process.cwd()）内的相对目录，跨出根目录一律视为空。
 */
import fs from 'node:fs';
import path from 'node:path';

// 项目根目录 = 进程工作目录，@ 引用仅在该范围内生效
export const BASE = process.cwd();

// 需要整层跳过的目录
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.front']);

const isHidden = (name) => name.startsWith('.');
const isSkip = (name) => isHidden(name) || SKIP.has(name);

/** rel 统一用正斜杠；这里把所有分隔符归一到 / */
export function toSlash(p) {
  return p.replace(/\\/g, '/');
}

/** 相对目录 -> 绝对路径；若越界返回 null */
export function resolveRel(rel) {
  const target = path.resolve(BASE, rel || '');
  return target.startsWith(BASE) ? target : null;
}

/**
 * 列出某个相对目录下的直接子项。
 * @param {string} relDir 相对根目录的路径，'' 表示根目录
 * @returns {{ dirs: string[], files: string[] }} 已排序、已过滤隐藏项
 */
export function listDir(relDir = '') {
  const target = resolveRel(relDir);
  if (!target) return { dirs: [], files: [] };

  let names;
  try {
    names = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    return { dirs: [], files: [] };
  }

  const dirs = [];
  const files = [];
  for (const d of names) {
    if (isSkip(d.name)) continue;
    if (d.isDirectory()) dirs.push(d.name);
    else if (d.isFile()) files.push(d.name);
  }

  dirs.sort((a, b) => a.localeCompare(b));
  files.sort((a, b) => a.localeCompare(b));
  return { dirs, files };
}

/** 拼接相对路径：dir 为空则直接返回 name */
export function joinRel(dir, name) {
  const d = toSlash(dir || '');
  return d ? `${d}/${name}` : name;
}

/** 取上一级相对目录；已是根目录返回 ''（调用方据此判断是否显示「上一级」） */
export function parentOf(rel) {
  if (!rel) return '';
  const parts = toSlash(rel).split('/');
  parts.pop();
  return parts.join('/');
}
