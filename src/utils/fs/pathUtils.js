import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 配置文件名 */
const CONFIG_FILE = 'setting.json';

/** 全局配置目录：用户主目录下的 .front 文件夹，如 C:\Users\华为\.front */
export const GLOBAL_CONFIG_DIR = path.join(os.homedir(), '.front');

/**
 * 读取单个配置目录下的 setting.json。
 * 文件不存在返回 {}；存在但解析失败时打印警告并返回 {}，避免程序崩溃。
 */
async function readConfigFile(configDir) {
  const filePath = path.join(configDir, CONFIG_FILE);
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`警告: 配置文件解析失败 ${filePath} -> ${err.message}`);
    }
    return {};
  }
}

/**
 * 读取合并后的配置：全局配置 + 当前项目配置（项目配置优先生效）。
 *
 * 字段与 app.js 第 24 行 OpenAI 客户端配置对应:
 *   { apiKey, baseURL, model, systemPrompt }
 *
 * @param {string} [cwd=process.cwd()] 当前终端目录，默认取进程工作目录
 * @returns {Promise<{apiKey?: string, baseURL?: string, model?: string, systemPrompt?: string}>}
 */
export async function loadFrontConfig(cwd = process.cwd()) {
  // 全局配置：~/.front/setting.json
  const globalConfig = await readConfigFile(GLOBAL_CONFIG_DIR);
  // 项目配置：当前终端目录下 .front/setting.json
  const projectConfig = await readConfigFile(path.join(cwd, '.front'));

  return { ...globalConfig, ...projectConfig };
}

/**
 * 读取合并后的 MCP 服务配置：全局 + 项目 setting.json 的 mcpServers 按 server 名合并，
 * 同名 server 项目级覆盖全局级（与 loadFrontConfig 的顶层浅合并不同，这里按 server 粒度合并）。
 * @param {string} [cwd=process.cwd()] 当前终端目录
 * @returns {Promise<Record<string, object>>} server 名 → { transport, command, args, ... }
 */
export async function loadMcpServers(cwd = process.cwd()) {
  const globalConfig = await readConfigFile(GLOBAL_CONFIG_DIR);
  const projectConfig = await readConfigFile(path.join(cwd, '.front'));
  return { ...(globalConfig.mcpServers || {}), ...(projectConfig.mcpServers || {}) };
}
