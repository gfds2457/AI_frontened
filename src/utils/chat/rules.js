import { promises as fs } from 'node:fs';
import path from 'node:path';
import { globSync } from 'glob';
import { minimatch } from 'minimatch';
import { GLOBAL_CONFIG_DIR } from '../fs/pathUtils.js';

/**
 * 解析规则文件：文件顶部 `---` 包裹的 YAML frontmatter 中的 `paths:` 列表为
 * 「具体匹配规则」，其余部分为「内容」。没有 frontmatter 或 paths 时 rules 为空数组，
 * 整文件作为 content。
 * @param {string} raw
 * @returns {{content: string, rules: string[]}}
 */
function parseRuleFile(raw) {
  const lines = raw.split(/\r?\n/);
  if (lines[0] && lines[0].trim() === '---') {
    const end = lines.slice(1).findIndex((l) => l.trim() === '---');
    if (end !== -1) {
      const content = lines.slice(end + 2).join('\n').trim();
      const frontmatter = lines.slice(1, end + 1).join('\n');
      return { content, rules: parsePaths(frontmatter) };
    }
  }
  return { content: raw.trim(), rules: [] };
}

/** 去掉 YAML 字符串值两侧引号及值尾部的 ` # 注释` */
function unquote(s) {
  const t = s.trim();
  if (!t) return '';
  if (t[0] === '"' || t[0] === "'") {
    const q = t[0];
    const end = t.lastIndexOf(q);
    if (end > 0) return t.slice(1, end).trim();
  }
  return t.split(/\s+#/)[0].trim();
}

/**
 * 从 frontmatter 解析出 paths: 列表（支持换行的 `- item` 与内联 `[...]` 两种写法），
 * 每条即一个规则 glob（如 `*.css`、`src/**\/*.vue`）。不含 `/` 的 basename 写法在
 * 匹配时经 minimatch 的 matchBase 生效为「任意层级下的该文件」，故这里无需改写。
 * @param {string} frontmatter
 * @returns {string[]}
 */
function parsePaths(frontmatter) {
  const rules = [];
  let inPaths = false;
  for (const line of frontmatter.split(/\r?\n/)) {
    const t = line.trim();
    const key = /^([A-Za-z0-9_.-]+):/.exec(t);
    if (inPaths) {
      if (key && key[1] !== 'paths') break; // 遇到其它顶层键，列表结束
      if (t.startsWith('-') && !t.startsWith('---')) {
        const p = t.slice(1).trim();
        if (p && !p.startsWith('#')) rules.push(unquote(p));
      }
      continue;
    }
    if (key && key[1] === 'paths') {
      inPaths = true;
      const rest = t.slice(key[0].length).trim(); // "paths:" 同行剩余内容
      if (rest) {
        if (rest.startsWith('[')) rules.push(...splitInline(rest));
        else if (!rest.startsWith('#')) rules.push(unquote(rest));
      }
    }
  }
  return rules.filter(Boolean);
}

/** 解析内联数组 paths: [a, b]，按顶层逗号切分（忽略引号与 {} 花括号内的逗号） */
function splitInline(s) {
  const inner = s.replace(/^\s*\[/, '').replace(/\]\s*$/, '').trim();
  if (!inner) return [];
  const items = [];
  let cur = '';
  let depth = 0;
  let quote = '';
  for (const ch of inner) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === '{' || ch === '[') {
      depth += 1;
      cur += ch;
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
      cur += ch;
    } else if (ch === ',' && depth === 0) {
      items.push(unquote(cur));
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) items.push(unquote(cur));
  return items;
}

/**
 * 展开单元素花括号：`{js}` 按 bash/minimatch 语义是字面量，但项目里 `*.{js}` 期望
 * 等价于 `*.js`（旧实现即如此），故把无逗号、无嵌套的 `{x}` 还原成 `x`；
 * 含逗号的多选 `{js,ts}` 保留给 minimatch 展开。
 * @param {string} g
 * @returns {string}
 */
function expandSingleBraces(g) {
  return g.replace(/\{([^{}]+)\}/g, (m, inner) => (inner.includes(',') ? m : inner));
}

/**
 * 判断相对路径（正斜杠）是否命中某条规则 glob：
 *  - 不含 `/` 的 basename 写法（*.css）经 minimatch 的 matchBase 在任意目录层级下
 *    匹配 basename（等价于 `**\/*.css`）；
 *  - 含目录分隔的写法（src/**\/*.vue）按 glob 原样整路径匹配。
 * 由 glob 库的匹配引擎 minimatch 负责，不再手写 glob→正则。
 * @param {string} relPath
 * @param {string} rule
 * @returns {boolean}
 */
export function matchGlob(relPath, rule) {
  const p = String(relPath).replace(/\\/g, '/');
  const r = expandSingleBraces(String(rule).trim().replace(/\\/g, '/'));
  if (!p || !r) return false;
  return minimatch(p, r, { matchBase: true });
}

/**
 * 给定被 @ 引用的文件相对路径，返回命中的规则（按 rulesData 顺序、按规则文件去重）。
 * @param {string[]} relPaths 被引用文件的相对路径（相对项目根）
 * @param {Array<Record<string, {content: string, rules: string[]}>>} rulesData readRules() 的返回
 * @returns {{file: string, content: string}[]}
 */
export function matchRulesForRefs(relPaths, rulesData) {
  const paths = (relPaths || []).map((p) => String(p).replace(/\\/g, '/'));
  if (paths.length === 0 || !rulesData || rulesData.length === 0) return [];
  const hits = [];
  const seen = new Set();
  for (const entry of rulesData) {
    for (const [ruleFile, { content, rules }] of Object.entries(entry)) {
      if (seen.has(ruleFile)) continue;
      const matched = (rules || []).some((g) => paths.some((p) => matchGlob(p, g)));
      if (matched) {
        seen.add(ruleFile);
        hits.push({ file: ruleFile, content });
      }
    }
  }
  return hits;
}

/**
 * 加载全部规则文件：全局 ~/.front/rules/ 与项目 <cwd>/.front/rules/ 下的所有文件
 * （含子目录）。每个文件解析为 { content, rules: 规则 glob 数组 }，以文件绝对路径为键。
 * @param {string} [cwd=process.cwd()]
 * @returns {Promise<Array<Record<string, {content: string, rules: string[]}>>>}
 */
export async function readRules(cwd = process.cwd()) {
  const bases = [
    path.join(GLOBAL_CONFIG_DIR, 'rules'),
    path.join(cwd, '.front', 'rules'),
  ];
  const result = [];
  for (const base of bases) {
    // glob 递归列出 base 下所有文件（含隐藏文件、排除目录）；目录不存在时返回空数组
    let files;
    try {
      files = globSync('**/*', { cwd: base, dot: true, nodir: true });
    } catch (err) {
      console.warn(`警告: 读取规则目录失败 ${base} -> ${err.message}`);
      continue;
    }
    for (const rel of files) {
      const file = path.join(base, rel);
      let raw;
      try {
        raw = await fs.readFile(file, 'utf8');
      } catch (err) {
        console.warn(`警告: 读取规则文件失败 ${file} -> ${err.message}`);
        continue;
      }
      result.push({ [file]: parseRuleFile(raw) });
    }
  }
  return result;
}
