import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { globSync } from 'glob';
import { GLOBAL_CONFIG_DIR } from '../fs/pathUtils.js';
import { searchKnowledgeBase } from '../storage/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 本文件位于 src/utils/chat/，上溯两级到 src/ 再进入 docs/（src/docs/…）
const DOC_PATH = path.join(__dirname, '..', '..', 'docs', 'systemDoc.md');
// 补充系统文档（行为规范/注意事项），拼在 systemDoc.md 之后一起进系统上下文
const SYSTEM_DOC_PATH = path.join(__dirname, '..', '..', 'docs', 'system.md');
// 项目自带的技能目录，位于项目根（src/utils/chat/ 上溯三级）
const BUILTIN_SKILL_DIR = path.join(__dirname, '..', '..', '..', 'skills');
const USER_CONTEXT_TEMPLATE = path.join(__dirname, '..', '..', 'docs', 'userContest.md');
const SKILL_TEMPLATE = path.join(__dirname, '..', '..', 'docs', 'skillTemplate.md');
const RAG_TEMPLATE = path.join(__dirname, '..', '..', 'docs', 'ragContext.md');

/** 获取操作系统信息：平台 + 架构 + 主机名 + 系统版本（若可读取） */
function getSystemInfo() {
  const platform = os.platform();
  const arch = os.arch();
  const hostname = os.hostname();
  const release = os.release();
  let version = '';
  try {
    version = os.version ? os.version() : '';
  } catch {
    /* 某些平台不支持 os.version() */
  }
  const parts = [`${platform}/${arch}`, `hostname=${hostname}`, `release=${release}`];
  if (version) parts.push(`version=${version}`);
  return parts.join(', ');
}

/**
 * 按角色裁剪 systemDoc.md：
 *  - 被 <!-- role:xxx --> ... <!-- /role --> 包住的段落，只有列出的角色保留
 *  - 没有标记的段落视为共用，所有角色都保留
 * 文档里一处标记都没有时等于全文，行为与加标记前完全一致。
 */
function filterByRole(md, role) {
  return md.replace(
    /[ \t]*<!--\s*role:([\w,]+)\s*-->([\s\S]*?)<!--\s*\/role\s*-->[ \t]*\r?\n?/g,
    (_, roles, body) => (roles.split(',').includes(role) ? body : ''),
  );
}

/**
 * 清掉残留的 role 标记与因裁剪产生的多余空行；标记本身不该泄漏给大模型。
 * 注意闭合标记写作 <!-- /role -->，没有冒号，正则必须把 role:xxx 和 /role 两种都覆盖。
 */
function cleanupMarkers(md) {
  return md
    .replace(/[ \t]*<!--\s*\/?role(?::[\w,]*)?\s*-->[ \t]*\r?\n?/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 读取单个文档，文件不存在时静默返回空串
async function readDoc(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`警告: 读取系统文档失败 ${file} -> ${err.message}`);
    }
    return '';
  }
}

// 读取 systemDoc.md + system.md 并填充其中的占位符：
// role 缺省时不裁剪（返回全文），保持原有调用方行为不变。
export async function readContext(role) {
  const docs = await Promise.all([DOC_PATH, SYSTEM_DOC_PATH].map(readDoc));
  const content = docs.filter(Boolean).join('\n\n');
  if (!content) return '';
  const filled = content
    .replaceAll('${systemInfo}', getSystemInfo())
    .replaceAll('${workPath}', process.cwd());
  return cleanupMarkers(role ? filterByRole(filled, role) : filled);
}

/**
 * 取某个角色的完整上下文（系统文档按角色裁剪 + 用户上下文 + 技能清单），
 * 供 Python 侧的 crew 按 agent 领取。
 */
export async function getRoleContext(role = 'engineer', cwd = process.cwd()) {
  const [sys, user, skill] = await Promise.all([
    readContext(role),
    getUserContext(cwd),
    getSkillContext(cwd),
  ]);
  return [sys, user, skill].filter(Boolean).join('\n\n');
}

// 读取 userContest.md 模板，填充用户级与项目级自定义上下文
export async function getUserContext(cwd = process.cwd()) {
  let template;
  try {
    template = await fs.readFile(USER_CONTEXT_TEMPLATE, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`警告: 读取用户上下文模板失败 ${USER_CONTEXT_TEMPLATE} -> ${err.message}`);
    }
    return '';
  }

  // 用户级：~/.front/.front.md
  const userFilePath = path.join(GLOBAL_CONFIG_DIR, '.front.md');
  let userContent = '';
  try {
    userContent = await fs.readFile(userFilePath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`警告: 读取用户上下文文件失败 ${userFilePath} -> ${err.message}`);
    }
  }

  // 项目级：<cwd>/.front.md
  const projectFilePath = path.join(cwd, '.front.md');
  let projectContent = '';
  try {
    projectContent = await fs.readFile(projectFilePath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`警告: 读取项目上下文文件失败 ${projectFilePath} -> ${err.message}`);
    }
  }

  return template
    .replaceAll('${userPath}', userFilePath)
    .replaceAll('${userContext}', userContent)
    .replaceAll('${projectPath}', projectFilePath)
    .replaceAll('${projectContext}', projectContent);
}

// 截取 SKILL.md 中两个 --- 符号之间包裹的头部内容；无完整头部时返回空串
function parseSkillFrontmatter(raw) {
  const lines = raw.split(/\r?\n/);
  if (!lines[0] || lines[0].trim() !== '---') return '';
  const end = lines.slice(1).findIndex((l) => l.trim() === '---');
  if (end === -1) return '';
  return lines.slice(1, end + 1).join('\n').trim();
}

// 收集技能列表：扫描项目级 <cwd>/.front/skills、用户级 ~/.front/skills 与项目自带 skills 下
// 各技能文件夹中的 SKILL.md，截取头部并拼上 filePath，形如：
//   name: front-design
//   description: ...
//   filePath: /绝对路径/SKILL.md
// 同名技能只保留优先级最高的一个（项目级 > 内置 > 用户级），避免重复占用 token。
// 内置技能随工具版本发布，故优先于用户级目录里的同名旧副本。
async function collectSkillHeaders(cwd = process.cwd()) {
  const blocks = [];
  const seen = new Set();
  const bases = [
    path.join(cwd, '.front', 'skills'),
    BUILTIN_SKILL_DIR,
    path.join(GLOBAL_CONFIG_DIR, 'skills'),
  ];
  for (const base of bases) {
    // glob 递归列出 base 下所有 SKILL.md；目录不存在时 globSync 抛错，返回空数组继续
    let files;
    try {
      files = globSync('**/SKILL.md', { cwd: base, dot: true });
    } catch (err) {
      console.warn(`警告: 读取技能目录失败 ${base} -> ${err.message}`);
      continue;
    }
    for (const rel of files) {
      const file = path.join(base, rel);
      let raw;
      try {
        raw = await fs.readFile(file, 'utf8');
      } catch (err) {
        console.warn(`警告: 读取技能文件失败 ${file} -> ${err.message}`);
        continue;
      }
      const header = parseSkillFrontmatter(raw);
      if (!header) continue;
      const name = (header.match(/^name:\s*(.+)$/m) || [])[1]?.trim() || file;
      if (seen.has(name)) continue;
      seen.add(name);
      blocks.push(`${header}\nfilePath: ${file}`);
    }
  }
  return blocks;
}

// 检索增强上下文：把 query 交给向量库检索，命中文本填入 ragContext.md 的 ${ragContext}
// 占位符，返回「本地资料」上下文交给大模型。模板缺失 / 未建库 / 无命中 / 检索出错
// 一律返回空串，让上游静默降级为普通对话。
export async function getRagContext(query, opts = {}) {
  let texts;
  try {
    texts = await searchKnowledgeBase(query, opts);
  } catch (err) {
    console.warn(`警告: RAG 检索失败 -> ${err.message}`);
    return '';
  }
  if (!texts.length) return '';

  let template;
  try {
    template = await fs.readFile(RAG_TEMPLATE, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`警告: 读取 RAG 模板失败 ${RAG_TEMPLATE} -> ${err.message}`);
    }
    return '';
  }
  return template.replaceAll('${ragContext}', texts.join('\n\n'));
}

// 读取 skillTemplate.md 并填充 ${skillContent} 为全部技能头部列表，返回完整技能上下文。
// 无可用技能或模板缺失时返回空串，方便上游 filter(Boolean) 后拼接给大模型。
export async function getSkillContext(cwd = process.cwd()) {
  let template;
  try {
    template = await fs.readFile(SKILL_TEMPLATE, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`警告: 读取技能模板失败 ${SKILL_TEMPLATE} -> ${err.message}`);
    }
    return '';
  }
  const blocks = await collectSkillHeaders(cwd);
  if (blocks.length === 0) return '';
  return template.replaceAll('${skillContent}', blocks.join('\n\n'));
}

