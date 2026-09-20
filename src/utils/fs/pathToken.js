/**
 * 路径标记识别 —— 输入框的「浅蓝框」与发送前的读文件共用这一套规则，
 * 保证「被框住的路径」= 「会被读进消息的路径」，不会出现框了不读、读了不框。
 *
 * 认得三种写法：
 *   1. @路径 / #路径   —— 项目内的文件引用与设计图引用（@ 选文件、# 选图浮层产出的就是它）
 *   2. "带空格的 路径"  —— 拖拽/粘贴时终端自动补的引号（只框引号里面的部分）
 *   3. 裸路径          —— E:\a\b.js、/e/a/b.js（Git Bash 风格）、src/utils/x.js、~/x.js
 *
 * 只有「确实存在」的候选才算路径标记，所以普通词、URL、不存在的路径都不会被误框误读。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASE } from './fileBrowser.js';

/** 尾部标点（中英文）：避免把「src/app.js，」里的逗号当成路径的一部分 */
const TRAILING = /[，。；：、！？!?.,;:)\]）】}>]+$/;

/** 去掉候选串尾部的标点（读文件与识别路径共用同一条规则） */
export function trimPunct(s) {
  return s.replace(TRAILING, '');
}

/** 抓 @xxx / #xxx 片段（到空白或中英文括号/标点为止），供「引用未命中」提示使用 */
export const REF_RE = /[@#]([^\s，。；：、！？!?（）()【】\[\]<>]+)/g;

/** 汉字：中文里常把路径夹在文字中间（「看下src/app.js文件」），解析失败时剥掉再试一次 */
const HAN_RE = /^[\u3400-\u4dbf\u4e00-\u9fff]+/;
const HAN_TAIL = /[\u3400-\u4dbf\u4e00-\u9fff]+$/;

/**
 * 把路径文本转成「可能存在的绝对路径」列表，按优先级排列。
 * Git Bash 拖拽出来的是 /e/前端... 形式，给出两种解释：E:/前端... 与 项目根下的 e/前端...
 */
function absOf(token) {
  const p = token.replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(p)) return [p]; // E:/a/b.js
  if (p.startsWith('//')) return [p]; // \\server\share（UNC）
  if (p === '~' || p.startsWith('~/')) return [path.join(os.homedir(), p.slice(2))];
  if (/^\/[A-Za-z]\//.test(p)) return [`${p[1]}:${p.slice(2)}`, path.resolve(BASE, p.slice(1))];
  if (p.startsWith('/')) return [path.resolve(p)];
  return [path.resolve(BASE, p)]; // 相对路径按项目根解析
}

/** 依次试各种解释，命中返回 { abs, stat }，全落空返回 null */
function statOf(token) {
  // Git Bash 拖拽会把空格写成「\ 」，识别时按空格还原（不影响高亮框住的原文范围）
  for (const abs of absOf(token.replace(/\\ /g, ' '))) {
    try {
      return { abs, stat: fs.statSync(abs) };
    } catch {
      /* 换下一种解释 */
    }
  }
  return null;
}

/**
 * 把一个候选串解析成确实存在的路径。
 * @returns {{abs: string, stat: fs.Stats, token: string, han: number}|null}
 *   token：真正用作路径的片段；han：token 前面被剥掉的汉字个数
 */
function resolveToken(raw) {
  const cut = trimPunct(raw);
  const hit = statOf(cut);
  if (hit) return { ...hit, token: cut, han: 0 };

  // 中文紧贴路径：剥掉首尾汉字再试（看下src/app.js文件 -> src/app.js）
  const lead = cut.match(HAN_RE);
  const han = lead ? lead[0].length : 0;
  const core = cut.slice(han).replace(HAN_TAIL, '');
  if (!core || core === cut) return null;
  const hit2 = statOf(core);
  return hit2 ? { ...hit2, token: core, han } : null;
}

/**
 * 解析一段候选文本。
 * @param {string} raw 候选原文
 * @param {number} at  raw 在整段文本中的起始下标
 * @returns {{start:number, end:number, abs:string, stat:fs.Stats}|null} 命中范围（含 @ / # 前缀）
 */
function scan(raw, at) {
  // @ / # 是显式引用前缀，框住它才像一枚引用标签
  const pfx = raw[0] === '@' || raw[0] === '#' ? 1 : 0;
  const cand = raw.slice(pfx);
  if (!cand) return null;
  // 裸片段必须含分隔符：普通词不做 stat，避免把一个词当成路径
  if (!pfx && !cand.includes('/') && !cand.includes('\\')) return null;

  const hit = resolveToken(cand);
  if (!hit) return null;

  const body = at + pfx + hit.han; // 路径本体起点
  return {
    start: hit.han ? body : at, // 剥过汉字时前缀不算在内
    end: body + hit.token.length,
    abs: hit.abs,
    stat: hit.stat,
  };
}

/**
 * 扫描文本里的全部路径标记（按出现顺序、互不重叠）。
 * @param {string} text 用户输入
 * @returns {{start:number, end:number, raw:string, abs:string, isDir:boolean, size:number}[]}
 *   start/end：标记在 text 中的区间（含 @ / # 前缀，不含包裹引号）；
 *   raw：区间原文（提示信息用）；abs：解析出的绝对路径；isDir/size：磁盘上的真实情况。
 */
export function findPathTokens(text) {
  if (!text) return [];
  const hits = [];
  const taken = [];

  // 1) 引号包住的路径：拖拽带空格的路径时终端会自动补引号，只框引号里面的部分
  for (const m of text.matchAll(/"([^"\n]+)"|'([^'\n]+)'/g)) {
    taken.push([m.index, m.index + m[0].length]);
    const hit = scan(m[1] ?? m[2], m.index + 1);
    if (hit) hits.push(hit);
  }

  // 2) 其余非空白片段
  const runs = [...text.matchAll(/\S+/g)];
  for (let i = 0; i < runs.length; i++) {
    const at = runs[i].index;
    const raw = runs[i][0];
    if (taken.some(([s, e]) => at >= s && at < e)) continue;

    // Git Bash 拖拽用反斜杠转义空格（/e/my\ docs/a.js）：被空格切开的片段拼回原文再试
    let span = raw;
    let j = i;
    while (span.endsWith('\\') && runs[j + 1] && j - i < 8) {
      j += 1;
      span = text.slice(at, runs[j].index + runs[j][0].length);
    }
    if (j > i) {
      const hit = scan(span, at);
      if (hit) {
        hits.push(hit);
        i = j;
        continue;
      }
    }

    const hit = scan(raw, at);
    if (hit) hits.push(hit);
  }

  return hits
    .sort((a, b) => a.start - b.start)
    .map((h) => ({
      start: h.start,
      end: h.end,
      raw: text.slice(h.start, h.end),
      abs: h.abs,
      isDir: h.stat.isDirectory(),
      size: h.stat.size,
    }));
}
