/**
 * 工具注册中心 —— 用 @langchain 统一管理两类工具：
 *  1. 本地 functionTool：src/tools/*.js，每个文件 default export { define, handle }
 *     define = { name, description, inputSchema(zod) }，handle(args) 执行并返回结果。
 *  2. MCP 服务：合并 ~/.front 与 <cwd>/.front 的 setting.json 中 mcpServers，
 *     经 @langchain/mcp-adapters 的 MultiServerMCPClient 建连后转成 LangChain 工具。
 *
 * 两者最终都封装成 DynamicStructuredTool，调用方（chatService）统一 bindTools 给大模型、
 * 统一 invokeTool 执行。连接与扫描只做一次（懒加载缓存）。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { globSync } from 'glob';
import chalk from 'chalk';
import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { loadMcpServers } from '../utils/fs/pathUtils.js';
import { withTimeout } from '../utils/asyncTimeout.js';
import { buildDiffReport, localPathsFromArgs, parseImugiNumbers } from '../utils/image/diffReport.js';

// 外部进程/网络调用的超时兜底（毫秒）：TUI 输入锁依赖这些 Promise 最终 settle，
// 永不返回会导致用户按键被 busy 状态永久吞掉
const MCP_CONNECT_TIMEOUT = 30000; // MCP 子进程 spawn + 握手
const TOOL_INVOKE_TIMEOUT = 90000; // 单个工具执行（含 MCP 工具 JSON-RPC 往返）
const MCP_CLOSE_TIMEOUT = 8000; // 退出时关闭 MCP 连接
// 需要等人回答的工具（confirm/select）单独放宽：用户思考两分钟不回，不该被 90s 掐断。
// 仍留一个上限兜底，避免用户直接走人导致请求永久挂起。
// 必须**短于**调用方的 HTTP 读超时（Python 侧 node_tools.py 的 INTERACTIVE_TIMEOUT 30 分钟）：
// 两边同值的话 httpx 会同时断连，用户只看到一句连接错误，而看不到这里「执行超过 … 未响应」的原因
const INTERACTIVE_TIMEOUT = 1740000; // 29 分钟

/**
 * 角色 → 可用工具集。CrewAI 侧的 agent 按角色领取，控制上下文体积。
 * engineer 的工作流工具只有 10 个（表驱动 + 浏览器/对比），但 6 个人工确认点全靠
 * confirm/select，所以这两个必须一并给。
 */
export const ROLE_TOOLS = {
  designer: ['generate_image', 'confirm', 'select', 'skill'],
  engineer: [
    'read_file', 'write_file', 'edit_file', 'Bash', 'grep', 'glob',
    'navigate_page', 'take_screenshot', 'list_console_messages', 'imugi_compare',
    'generate_image', 'confirm', 'select',
  ],
};

/**
 * 把工具的 schema 转成 JSON Schema。两类工具形态不同：
 *  - 本地工具：zod v4 的 ZodObject，用内置 z.toJSONSchema 转
 *  - MCP 工具：@langchain/mcp-adapters 直接给的就是 JSON Schema 对象，原样返回
 * zod 转出来的带 $schema / additionalProperties，OpenAI function schema 不接受，要剔掉。
 */
function schemaToJson(schema) {
  if (!schema) return { type: 'object', properties: {} };
  if (schema instanceof z.ZodType) {
    const json = z.toJSONSchema(schema);
    delete json.$schema;
    delete json.additionalProperties;
    return json;
  }
  return schema;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 本文件位于 src/tools/ 下，扫同目录 *.js 即为本地 functionTool
const TOOLS_DIR = __dirname;

let loaded = false; // 是否已完成加载
let tools = []; // 已注册的全部工具（本地 + MCP）
let mcpClient = null; // MCP 连接（退出时 close 用）
// 工具名 -> 该工具自己的执行超时（仅本地工具可通过 define.timeout 指定，见 loadLocalTools）
const customTimeouts = new Map();
// 需要等人回答的工具名（本地工具通过 define.interactive 声明）
const interactiveTools = new Set();
// 本地工具名 -> 原始 handle。invokeTool 直接调它，避开 LangChain 把返回值压成字符串
const rawHandlers = new Map();

/**
 * 把工具 handle 的返回规整成 { text, data }：
 *  - text：给大模型看的人类可读文本
 *  - data：给编排逻辑用的结构化数据（如设计图路径、用户是否确认）
 * 兼容 string / {content:{type:'text',text}} / {text,data} / 普通对象。
 *
 * MCP 工具会返回**内容块数组**（如 imugi_compare 的 text + base64 热力图）。
 * 数组必须单独处理：落到最后的 JSON.stringify 分支就会把整张图的 base64
 * 当成正文交给模型 —— 1440x900 的实测是 12918 字符 ≈ 4037 tokens，
 * 而模型解码不了 base64，等于白烧上下文（详见 utils/image/diffReport.js）。
 * 所以这里只取 text 块，图片块一律不进 text。
 */
function normalize(out) {
  if (typeof out === 'string') return { ok: true, text: out, data: null };
  if (out && typeof out === 'object') {
    // 工具显式返回 { ok, text, data } 时以它为准（如 select 被取消、素材图生成失败）
    if (typeof out.ok === 'boolean' && typeof out.text === 'string') {
      return { ok: out.ok, text: out.text, data: out.data ?? null };
    }
    // 内容块数组：MCP 工具的原生返回形态
    const blocks = Array.isArray(out) ? out : Array.isArray(out.content) ? out.content : null;
    if (blocks) {
      const texts = [];
      let images = 0;
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue;
        if (typeof b.text === 'string') texts.push(b.text);
        else if (b.type === 'image' || b.type === 'image_url') images += 1;
      }
      return {
        ok: true,
        text: texts.join('\n'),
        data: out.data ?? null,
        // 只报「有几张图」：图片本体（base64）绝不往外带
        images,
      };
    }
    const c = out.content;
    if (c && typeof c === 'object' && 'text' in c) return { ok: true, text: String(c.text), data: out.data ?? null };
    if (typeof c === 'string') return { ok: true, text: c, data: out.data ?? null };
    if (typeof out.text === 'string') return { ok: true, text: out.text, data: out.data ?? null };
  }
  try {
    return { ok: true, text: JSON.stringify(out), data: out };
  } catch {
    return { ok: true, text: String(out), data: null };
  }
}

/**
 * 个别 MCP 工具的结果要「翻译」成模型能用的文本。目前只有 imugi_compare：
 * 它返回的差异热力图是 base64 图片，模型读不了，改由我们用设计稿与截图
 * 自己算逐格像素差，输出「差异最大的区域」文字报告。
 * @returns {Promise<{ok:boolean,text:string,data:any}|null>} null 表示不需要特殊处理
 */
async function postProcess(name, result, args) {
  if (name !== 'imugi_compare') return null;
  const { designPath, screenshotPath } = localPathsFromArgs(args);
  const { ssim, pixelDiffPercentage } = parseImugiNumbers(result.text);
  const text = await buildDiffReport({ designPath, screenshotPath, ssim, pixelDiffPercentage });
  return { ...result, text };
}


/** 取某工具的生效超时：自定义 > 交互式（等人） > 默认 */
function timeoutOf(name) {
  return customTimeouts.get(name) ?? (interactiveTools.has(name) ? INTERACTIVE_TIMEOUT : TOOL_INVOKE_TIMEOUT);
}

/**
 * 把 zod 校验错误整理成人话。
 * 直接抛原始 ZodError 的话，模型会收到一坨 JSON 而不知道该怎么改；
 * 走 LangChain 时它的格式化版本（✖ 只能传绝对路径 → at filePath）可读得多，手动补回来。
 */
function formatToolError(err) {
  if (Array.isArray(err?.issues) && err.issues.length) {
    return err.issues.map((i) => `${i.path.join('.') || '入参'}: ${i.message}`).join('；');
  }
  return err?.message || String(err);
}

/** 扫描 src/tools/*.js，把每个 { define, handle } 封装成 DynamicStructuredTool */
async function loadLocalTools() {
  const files = globSync('*.js', { cwd: TOOLS_DIR }).filter((f) => f !== 'manager.js');
  const result = [];
  for (const rel of files) {
    const filePath = path.join(TOOLS_DIR, rel);
    try {
      const mod = await import(pathToFileURL(filePath).href);
      const def = mod.default;
      if (!def || typeof def.handle !== 'function' || !def.define) {
        console.warn(`⚠ 工具文件 ${rel} 缺少 define/handle，已跳过`);
        continue;
      }
      result.push(
        new DynamicStructuredTool({
          name: def.define.name,
          description: def.define.description,
          schema: def.define.inputSchema,
          // LangChain 侧只认字符串，取 text 部分（data 只在 HTTP 工具服务里用）
          func: async (args) => normalize(await def.handle(args)).text,
        }),
      );
      // 慢工具（如素材图生成要跑上百秒）可在 define.timeout 单独放宽执行超时
      if (Number.isFinite(def.define.timeout)) customTimeouts.set(def.define.name, def.define.timeout);
      // 需要等人回答的工具（confirm/select）：不能套用默认 90s
      if (def.define.interactive === true) interactiveTools.add(def.define.name);
      rawHandlers.set(def.define.name, def.handle);
    } catch (err) {
      console.warn(chalk.yellow(`⚠ 加载本地工具失败 ${rel} -> ${err.message}`));
    }
  }
  return result;
}

/** 连接 setting.json 中配置的全部 MCP 服务；失败只告警，不影响本地工具 */
async function loadMcpTools() {
  const rawServers = await loadMcpServers();
  // stdio 子进程默认丢弃 stderr：MCP server（如 chrome-devtools-mcp）启动时会往 stderr
  // 打横幅/隐私/统计提示，SDK 默认 inherit 会直接灌进主终端，冲乱 spinner 与输入行
  // （多行输出无法被 \r\x1b[2K 擦除）。用户在 setting.json 显式配置 stderr 时尊重其选择。
  const servers = Object.fromEntries(
    Object.entries(rawServers).map(([name, cfg]) => [
      name,
      cfg && typeof cfg.command === 'string' ? { stderr: 'ignore', ...cfg } : cfg,
    ]),
  );
  const names = Object.keys(servers);
  if (names.length === 0) return [];
  try {
    mcpClient = new MultiServerMCPClient({ mcpServers: servers });
    // 自动建连并返回展平的 LangChain 工具；超时则放弃 MCP（子进程可能启动慢/卡死），
    // 保留 mcpClient 引用，退出时由 closeTools 带超时尝试清理
    const mcpTools = await withTimeout(
      mcpClient.getTools(),
      MCP_CONNECT_TIMEOUT,
      'MCP 连接',
    );
    if (mcpTools.length > 0) {
      console.log(chalk.gray(`✓ 已连接 MCP: ${names.join(', ')}，共 ${mcpTools.length} 个工具`));
    }
    return mcpTools;
  } catch (err) {
    console.warn(chalk.yellow(`⚠ MCP 连接失败，本次跳过: ${err.message}`));
    return [];
  }
}

/**
 * 获取全部可用工具（本地 functionTool + MCP），懒加载并缓存。
 * @returns {Promise<import('@langchain/core/tools').DynamicStructuredTool[]>}
 */
export async function getTools() {
  if (loaded) return tools;
  const local = await loadLocalTools();
  const mcp = await loadMcpTools();
  tools = [...local, ...mcp];
  loaded = true;
  return tools;
}

/**
 * 按名字执行工具。异常/超时不抛出，而是返回 { ok:false, text }（作为工具结果回填给模型继续推理）。
 * 超时兜底必不可少：MCP 工具走子进程 JSON-RPC，子进程卡死时请求会永久 pending，
 * 导致对话流程挂起、TUI 输入锁不释放。
 * @returns {Promise<{ok:boolean, text:string, data:any}>}
 */
export async function invokeTool(name, args) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { ok: false, text: `工具不存在: ${name}`, data: null };
  try {
    // 本地工具走原始 handle：DynamicStructuredTool.invoke 会把返回值压成字符串，
    // { ok:false } 和 data 会在到达这里之前就被丢掉，编排侧就没法结构化判断了。
    // 代价是绕过了 LangChain 的入参校验，所以手动补一次 schema.parse。
    const raw = rawHandlers.get(name);
    const out = raw
      ? await withTimeout(raw(tool.schema.parse(args)), timeoutOf(name), `工具 ${name} 执行`)
      : await withTimeout(tool.invoke(args), timeoutOf(name), `工具 ${name} 执行`);
    const norm = normalize(out);
    // 需要「翻译」的工具（目前是 imugi_compare，见 postProcess 注释）。
    // 这一步失败不能连累工具本身：退回原始 text，编排侧至少还能拿到 SSIM 数字。
    try {
      return (await postProcess(name, norm, args)) ?? norm;
    } catch (err) {
      return { ...norm, text: `${norm.text}\n（附加的区域差异报告生成失败：${err.message}）` };
    }
  } catch (err) {
    return { ok: false, text: `工具 ${name} 执行失败: ${formatToolError(err)}`, data: null };
  }
}

/**
 * 取工具清单（供 Python 侧动态生成 CrewAI Tool）。
 * @param {string} [role] 角色名（ROLE_TOOLS 的 key），不传返回全部
 * @returns {Promise<Array<{name:string, description:string, parameters:object, interactive:boolean, timeout:number}>>}
 */
export async function getToolManifests(role) {
  const all = await getTools();
  const allow = role ? ROLE_TOOLS[role] : null;
  const picked = allow ? all.filter((t) => allow.includes(t.name)) : all;
  return picked.map((t) => ({
    name: t.name,
    description: t.description || '',
    parameters: schemaToJson(t.schema),
    interactive: interactiveTools.has(t.name),
    timeout: timeoutOf(t.name),
  }));
}

/** 关闭 MCP 连接（退出程序时调用，避免残留子进程）；带超时防止 shutdown 被拖住 */
export async function closeTools() {
  if (mcpClient) {
    const client = mcpClient;
    mcpClient = null;
    try {
      await withTimeout(client.close(), MCP_CLOSE_TIMEOUT, 'MCP 关闭');
    } catch {
      /* 关闭超时/失败也继续退出，残留子进程随进程结束被 OS 回收 */
    }
  }
}
