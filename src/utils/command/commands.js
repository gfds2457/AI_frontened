/**
 * 指令注册表 —— 指令清单的唯一数据源。
 * /help 与输入框里的斜杠指令浮层都从这里取数，保证永远一致。
 *
 * 指令分两类：
 *  - 系统指令：写死在 SYSTEM_COMMANDS 里（/help /clear /exit 等）。
 *  - 自定义指令：启动时由 loadCustomCommands() 从文件系统加载。
 *    目录结构：<base>/<group>/<name>.md → 触发 /<group>:<name>
 *    base 取两处：~/.front/commands 与 <cwd>/.front/commands，项目级覆盖全局级。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { GLOBAL_CONFIG_DIR } from '../fs/pathUtils.js';

// 扁平系统指令列表。trigger 为可输入指令原文（含 /）；
// exit 标记该指令会退出程序（由 app 层统一走 shutdown，见 app.js）。
const SYSTEM_COMMANDS = [
  { trigger: '/help', desc: '显示本帮助信息' },
  { trigger: '/?', desc: '同 /help' },
  { trigger: '/clear', desc: '清空当前对话历史' },
  { trigger: '/asset', desc: '手动生成素材图存到 .front/design/AI-asset，如 /asset 蓝色购物车图标' },
  { trigger: '/vector', desc: '将 doc 文档向量化入库，可后跟文件路径只存该文件' },
  { trigger: '/memory', desc: '结合上下文与近期对话，让 AI 整理并保存项目级/用户级记忆' },
  { trigger: '/exit', desc: '退出程序', exit: true },
  { trigger: '/quit', desc: '退出程序（同 /exit）', exit: true },
  { trigger: '/bye', desc: '退出程序（同 /exit）', exit: true },
];

/**
 * 合并后的指令清单（系统 + 自定义）。
 * 自定义指令在 loadCustomCommands() 完成后以 in-place 方式填充进来，
 * 这样持有旧引用的 logger.js 等模块无需改动即可看到最新列表。
 */
export const COMMANDS = [...SYSTEM_COMMANDS];

/** 获取合并后的完整指令清单 */
export function getCommands() {
  return COMMANDS;
}

/** 归一化指令文本：小写 + 去首尾空白（与旧 handleCommand 的 toLowerCase 对齐） */
export function normalize(trigger) {
  return (trigger || '').trim().toLowerCase();
}

/**
 * 按前缀过滤指令。
 * @param {string} word 可带 `/`（如 `/cl`），也可只给 `/` 后的内容（如 `cl`），
 *   两者都能命中 `/clear`；空串表示「只输入了 /」，返回全部指令。
 */
export function filterCommands(word) {
  let w = (word || '').trim();
  // 输入框里存的是 / 之后的部分，过滤时统一补回前导 /，使匹配对两种情况都成立
  if (!w.startsWith('/')) w = `/${w}`;
  w = w.toLowerCase();
  return COMMANDS.filter((c) => c.trigger.startsWith(w));
}

/** 某段文本是否为退出型指令（如 /exit /quit /bye） */
export function isExitCommand(trigger) {
  const t = normalize(trigger);
  return COMMANDS.some((c) => c.trigger === t && c.exit);
}

/** 是否为已注册指令 */
export function isKnownCommand(trigger) {
  const t = normalize(trigger);
  return COMMANDS.some((c) => c.trigger === t);
}

/** 按 trigger 精确查找指令对象（含自定义指令的元信息） */
export function findCommand(trigger) {
  const t = normalize(trigger);
  return COMMANDS.find((c) => c.trigger === t);
}

/**
 * 加载自定义指令：合并全局 ~/.front/commands 与项目 <cwd>/.front/commands。
 * 目录约定：每个子文件夹是一个分组，文件夹内的每个 .md 文件是一条指令，
 * 触发名为 /<文件夹名>:<文件名(去 .md)>。项目级同名指令覆盖全局级。
 * 加载完成后 in-place 更新 COMMANDS。
 * @param {string} [cwd=process.cwd()]
 * @returns {Promise<typeof COMMANDS>}
 */
export async function loadCustomCommands(cwd = process.cwd()) {
  const bases = [
    path.join(GLOBAL_CONFIG_DIR, 'commands'),
    path.join(cwd, '.front', 'commands'),
  ];
  // 用 Map 按 trigger 去重，后加载的 base（项目级）覆盖先加载的（全局级）
  const map = new Map();
  for (const base of bases) {
    let groups;
    try {
      groups = await fs.readdir(base, { withFileTypes: true });
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`警告: 读取指令目录失败 ${base} -> ${err.message}`);
      }
      continue;
    }
    for (const g of groups) {
      if (!g.isDirectory()) continue;
      const groupDir = path.join(base, g.name);
      let files;
      try {
        files = await fs.readdir(groupDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.isFile() || !f.name.endsWith('.md')) continue;
        const name = f.name.slice(0, -3); // 去掉 .md
        const trigger = `/${g.name}:${name}`;
        map.set(trigger, {
          trigger,
          desc: '自定义指令',
          custom: true,
          filePath: path.join(groupDir, f.name),
        });
      }
    }
  }
  // in-place 更新 COMMANDS，保证所有引用都能看到最新列表
  COMMANDS.length = 0;
  COMMANDS.push(...SYSTEM_COMMANDS, ...map.values());
  return COMMANDS;
}
