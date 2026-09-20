import chalk from 'chalk';
import { marked } from 'marked';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ChatOpenAI } from '@langchain/openai';
import { SystemMessage, HumanMessage, AIMessage, ToolMessage, AIMessageChunk } from '@langchain/core/messages';
import CONFIG from '../../../config.js';
import { printHelp, startSpinner, stopSpinner, printAssistantPrefix } from '../logger/logger.js';
import { isExitCommand, findCommand } from '../command/commands.js';
import { resolveRefs } from '../fs/fileReference.js';
import { resolveImageRefs } from '../input/image.js';
import { generateImage } from '../image/generate.js';
import { matchRulesForRefs } from './rules.js';
import * as term from '../../tui/renderer.js';
import { getTools, invokeTool } from '../../tools/manager.js';
import { buildKnowledgeBase } from '../storage/index.js';
import { buildMemoryPrompt } from '../storage/memories.js';
import { getRagContext } from './context.js';
import { withTimeout } from '../asyncTimeout.js';

// RAG 检索整体超时：embedding 请求 + 向量库检索正常都在秒级，
// 超时即放弃本地资料、静默降级为普通对话，避免卡住整个对话流程
const RAG_TIMEOUT = 15000;

/* ==================== LangChain ChatOpenAI 客户端 ==================== */

// timeout/maxRetries：网络异常时让请求最终失败（而不是无限挂起拖住 TUI 输入锁），
// 失败后由调用方 catch 回滚历史，用户可以重试
const llm = CONFIG.apiKey
  ? new ChatOpenAI({
    apiKey: CONFIG.apiKey,
    configuration: { baseURL: CONFIG.baseURL },
    model: CONFIG.model,
    timeout: 180000,
    maxRetries: 1,
  })
  : null;

// 对话历史（LangChain 消息）：history[0] 固定为 system 提示词，/clear 时只保留它
const history = [new SystemMessage(CONFIG.systemPrompt)];

// 运行时上下文（系统上下文 + 用户上下文）：发送给大模型但不写入 history，
// 因此不会被 getMessages() 保存到对话历史文件中。
let runtimeContext = '';
/** 设置运行时上下文（由 app 启动时注入），空串视为无上下文 */
export function setRuntimeContext(ctx) {
  runtimeContext = (ctx || '').trim();
}

// 规则集（readRules 的返回）：@ 引用文件命中其 glob 时，把对应 content 带进本次对话
let rulesData = [];
/** 设置规则集（由 app 启动时注入） */
export function setRules(rules) {
  rulesData = Array.isArray(rules) ? rules : [];
}

/** 工具调度轮次上限，防止模型反复调用工具陷入死循环 */
const MAX_TOOL_ROUNDS = 250;

/** 把 LangChain 消息映射成 {role, content}，供 app 退出保存对话历史用 */
function toPlainMessage(m) {
  const map = { system: 'system', human: 'user', ai: 'assistant', tool: 'tool' };
  const role = map[m._getType?.()] || 'assistant';
  // 多模态 content（数组）：取文本部分，图片位置用占位符，保证存档可读
  if (Array.isArray(m.content)) {
    const plain = m.content
      .map((p) => (p.type === 'text' ? p.text : '[图片]'))
      .join('')
      .trim();
    return { role, content: plain };
  }
  return { role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) };
}

/** 取当前对话历史（供 app 退出时保存用） */
export function getMessages() {
  return history.map(toPlainMessage);
}

/** 把整段 markdown 渲染成终端行，首行拼上「助手: 」前缀；去掉首尾多余空行 */
function renderAnswerLines(mdText) {
  const rendered = marked.parse(mdText);
  const lines = rendered.split('\n');
  while (lines.length && lines[0] === '') lines.shift();
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) lines.push('');
  lines[0] = chalk.bold.green('助手: ') + lines[0];
  return lines;
}

/**
 * 流式渲染大模型回答到终端。
 *  - 回答行数在可视容量内：整块 markdown 边收边重绘（实时、保留彩色渲染）；
 *  - 超出可视容量：一次性打印当前整块后转为“追加原始文本”，保证长文不花屏；
 *  - 空闲时按 40ms 节流合并多次小 token 的刷新。
 * 输入为「openai chunk 形状」的异步迭代器 { choices:[{delta:{content}}] }（见 adaptChunks）。
 * @returns {Promise<string>} 最终完整文本（写入对话历史用）
 */
async function streamAnswerToTerminal(stream) {
  const maxRows = Math.max(6, (process.stdout.rows || 24) - 1);
  term.resetAnswer();

  let buf = '';
  let spinnerDone = false;
  let managed = true;
  let srcCursor = 0; // 已上屏内容的源码长度
  let timer = null;

  const stopSpinnerOnce = () => {
    if (!spinnerDone) {
      stopSpinner();
      spinnerDone = true;
    }
  };

  const flush = () => {
    if (!buf) return;
    stopSpinnerOnce();
    if (managed) {
      const lines = renderAnswerLines(buf);
      if (term.measureRows(lines) <= maxRows) {
        term.drawAnswer(lines);
      } else {
        term.spillAnswer(lines);
        managed = false;
      }
      srcCursor = buf.length;
    } else {
      const delta = buf.slice(srcCursor);
      if (delta) term.appendAnswerRaw(delta);
      srcCursor = buf.length;
    }
  };

  const schedule = () => {
    if (!timer) timer = setTimeout(() => { timer = null; flush(); }, 40);
  };

  try {
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content ?? '';
      if (!delta) continue;
      buf += delta;
      schedule();
    }
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    flush();
    if (!spinnerDone) stopSpinner(); // 空回答时兜底
    // 受管整块重绘会去掉末尾空行，需补一行换行；raw 追加模式按真实结尾判断
    if (buf) term.endAnswer(managed ? false : buf.endsWith('\n'));
    return buf;
  } catch (err) {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    flush();
    stopSpinnerOnce();
    if (buf) term.endAnswer(managed ? false : buf.endsWith('\n'));
    throw err;
  }
}

/**
 * 把 LangChain 的 AIMessageChunk 流改造成 streamAnswerToTerminal 认识的
 * openai chunk 形状，同时在 onChunk 里把每个 chunk 累加聚合（concat），
 * 用于流结束后取出完整的 content 与 tool_calls。
 */
async function* adaptChunks(lcStream, onChunk) {
  for await (const chunk of lcStream) {
    if (onChunk) onChunk(chunk);
    const text = typeof chunk.content === 'string' ? chunk.content : '';
    yield { choices: [{ delta: { content: text || null } }] };
  }
}

/** 从聚合后的 AIMessage 中提取统一格式的工具调用 [{name, args, id}] */
function extractCalls(msg) {
  if (msg.tool_calls?.length) {
    return msg.tool_calls.map((tc) => ({ name: tc.name, args: tc.args || {}, id: tc.id }));
  }
  const raw = msg.additional_kwargs?.tool_calls;
  if (Array.isArray(raw) && raw.length) {
    return raw.map((r) => ({
      name: r.function?.name,
      args: (() => { try { return JSON.parse(r.function?.arguments || '{}'); } catch { return {}; } })(),
      id: r.id,
    }));
  }
  return [];
}

/** 工具执行前打印一行参数摘要 */
function toolArgSummary(args) {
  const s = JSON.stringify(args);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

/** 工具执行后打印一行结果摘要（截断 ~200 字符） */
function toolResultSummary(out) {
  const s = String(out).replace(/\s+/g, ' ').trim();
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

/**
 * 工具代理循环：携带全部工具请求大模型 → 有 tool_calls 就执行并回填结果再问，
 * 直到模型输出纯文字回答（最终回答已在循环内流式渲染到终端）。
 * @param {string} [ragCtx] 本次检索到的本地资料上下文，缺省空串（不进 history）
 */
async function runToolAgent(ragCtx = '') {
  startSpinner('正在加载工具…');
  const tools = await getTools();
  stopSpinner();

  const runner = tools.length ? llm.bindTools(tools) : llm;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    startSpinner('正在思考…');
    // 运行时上下文 + RAG 检索结果作为独立 system 消息前置（不进 history，不写入历史）
    const extraCtx = [runtimeContext, ragCtx].filter(Boolean).join('\n\n');
    const apiMessages = extraCtx
      ? [new SystemMessage(extraCtx), ...history]
      : history;

    // 边收边渲染到终端；agg 累积整轮输出以便读取 tool_calls
    const lcStream = await runner.stream(apiMessages);
    let agg = new AIMessageChunk({ content: '' });
    const text = await streamAnswerToTerminal(adaptChunks(lcStream, (ch) => { agg = agg.concat(ch); }));
    const calls = extractCalls(agg);

    // 本轮模型消息进历史（含 content 与 tool_calls）
    history.push(new AIMessage({ content: text, tool_calls: calls }));

    if (calls.length === 0) return; // 纯文字回答，结束

    for (const tc of calls) {
      console.log(chalk.gray(`⚙ 执行工具 ${tc.name} ${toolArgSummary(tc.args)}`));
      const { text: out } = await invokeTool(tc.name, tc.args);
      console.log(chalk.gray(`✓ 返回: ${toolResultSummary(out)}`));
      history.push(new ToolMessage(out, tc.id || ''));
    }
  }
  console.log(chalk.yellow('（工具调用轮次已达上限，已停止）'));
}

async function askAssistant(userText) {
  // 先摘除 # 图片引用：命中的图片以 base64 块随消息一起发，正文里只留文字
  const { text: plainText, images, warnings: imgWarnings } = resolveImageRefs(userText);
  // 发送前解析 @文件 引用：正文不变，文件内容以代码块拼到消息尾部
  const { text: enriched, warnings, refs } = resolveRefs(plainText);
  const allWarnings = [...imgWarnings, ...warnings];
  if (allWarnings.length) {
    for (const w of allWarnings) console.log(chalk.yellow(`⚠ ${w}`));
  }

  // @ 引用的文件命中规则 glob 时，把对应规则 content 拼到本次用户消息
  const ruleHits = matchRulesForRefs(refs, rulesData);
  const ruleBlocks = ruleHits.map(
    (h) => `\n\n### 适用规则（${h.file}）\n${h.content}`,
  );
  const messageText = enriched + ruleBlocks.join('');

  // 带图时用 content 数组（text + image_url），文字与图片一起发给具备视觉能力的模型
  let humanContent;
  if (images.length) {
    for (const img of images) console.log(chalk.gray(`🖼 已附带图片 ${img.path}`));
    const parts = [];
    if (messageText.trim()) parts.push({ type: 'text', text: messageText });
    for (const img of images) parts.push({ type: 'image_url', image_url: { url: img.dataUri } });
    humanContent = parts;
  } else {
    humanContent = messageText;
  }

  history.push(new HumanMessage(humanContent));

  // 演示模式：未配置 API Key
  if (!llm) {
    const reply =
      '（演示模式：未检测到 API Key，暂未调用大模型）\n' +
      `我已收到你的消息：「${userText}」\n` +
      '请在 setting.json 中配置 apiKey 后重新启动，即可进行真实对话。';
    printAssistantPrefix();
    process.stdout.write(chalk.gray(reply) + '\n');
    history.push(new AIMessage({ content: reply }));
    return getMessages();
  }

  // 记录本次用户消息前的历史长度，失败时回滚，方便用户重试
  const baseLen = history.length;

  // 检索本地知识库：用户问题转向量 → 查 lancedb → 命中文本填 ragContext.md 模板，
  // 得到本地资料上下文；未建库 / 未命中 / 出错 / 超时时返回空串，不影响正常对话
  let ragCtx = '';
  startSpinner('检索本地资料…');
  try {
    ragCtx = await withTimeout(getRagContext(userText), RAG_TIMEOUT, '本地资料检索');
  } catch (err) {
    process.stdout.write(chalk.yellow(`⚠ ${err.message}，本次跳过本地资料\n`));
  } finally {
    stopSpinner();
  }

  try {
    await runToolAgent(ragCtx);
    return getMessages();
  } catch (err) {
    stopSpinner();
    process.stdout.write(chalk.red(`请求失败：${err.message}\n`));
    history.length = baseLen; // 移除未成功的用户消息及可能的中间工具消息
  }
}

/* ==================== 命令处理 ==================== */

async function handleCommand(input) {
  // 退出类指令统一由 app 层 shutdown 处理（raw 模式/会话保存），这里直接忽略
  if (isExitCommand(input)) return;

  // 拆出触发词与可能的参数：/a:d 我的问题 → trigger=/a:d, arg=我的问题
  const trimmed = input.trim();
  const sp = trimmed.indexOf(' ');
  const trigger = sp === -1 ? trimmed : trimmed.slice(0, sp);
  const arg = sp === -1 ? '' : trimmed.slice(sp + 1).trim();
  const lower = trigger.toLowerCase();

  // 自定义指令：读 md 内容拼接到用户输入后，作为一条用户消息发给大模型
  const cmd = findCommand(trigger);
  if (cmd && cmd.custom) {
    let md;
    try {
      md = await fs.readFile(cmd.filePath, 'utf8');
    } catch (err) {
      console.log(chalk.red(`读取指令文件失败：${err.message}`));
      return;
    }
    const combined = arg ? `${md}\n\n${arg}` : md;
    await askAssistant(combined);
    return;
  }

  switch (lower) {
    case '/help':
    case '/?':
      printHelp();
      break;
    case '/clear':
      history.length = 0; // 只保留 system 提示词
      history.push(new SystemMessage(CONFIG.systemPrompt));
      console.log(chalk.yellow('✓ 已清空对话历史，开始新一轮对话。'));
      break;
    case '/asset': {
      // 手动生成素材图：与 generate_image 工具同一条生成链路，只是不经大模型判断
      if (!arg) {
        console.log(chalk.yellow('用法：/asset <素材描述>，例如 /asset 扁平风格的蓝色购物车图标，圆角线条，浅灰背景'));
        break;
      }
      startSpinner('正在生成素材图…');
      let result;
      try {
        result = await generateImage(arg, {
          onWait: (status) => startSpinner(`正在生成素材图…（${status}）`),
        });
      } catch (err) {
        stopSpinner();
        console.log(chalk.red(`素材图生成失败：${err.message}`));
        break;
      }
      stopSpinner();
      console.log(chalk.green(`✓ 素材图已保存到 ${result.rel}`));
      break;
    }
    case '/vector': {
      // 有路径参数只存该文件（相对路径按当前目录解析），否则存 doc 目录全部文档
      const files = arg ? [path.resolve(arg)] : undefined;
      startSpinner('正在向量化并写入向量库…');
      let result;
      try {
        result = await buildKnowledgeBase({ files });
      } catch (err) {
        stopSpinner();
        console.log(chalk.red(`向量化失败：${err.message}`));
        break;
      }
      stopSpinner();
      if (result.ok) {
        console.log(chalk.green(`✓ 已向量化 ${result.fileCount} 个文件 / ${result.chunkCount} 块`));
        console.log(chalk.gray(`  库：${result.dbPath} ｜ 表：${result.tableName}`));
      } else {
        console.log(chalk.red(`✗ ${result.reason}`));
      }
      break;
    }
    case '/memory': {
      // 生成记忆：一次独立于主对话的请求 —— 只携带模板内容（user 消息）与 memory_save 工具，
      // 模板由 buildMemoryPrompt 组装（两级记忆 + 自定义上下文 + 近期对话记录），不进 history。
      if (!llm) {
        console.log(chalk.yellow('（演示模式：未检测到 API Key，暂未调用大模型）'));
        break;
      }
      startSpinner('正在生成记忆…');
      try {
        const prompt = await buildMemoryPrompt();
        if (!prompt) {
          stopSpinner();
          console.log(chalk.red('✗ 记忆模板缺失（src/docs/memoryTemplate.md），无法生成记忆。'));
          break;
        }
        startSpinner('正在思考…');
        const memTool = (await getTools()).find((t) => t.name === 'memory_save');
        if (!memTool) {
          stopSpinner();
          console.log(chalk.red('✗ 未找到 memory_save 工具，无法生成记忆。'));
          break;
        }

        // 独立消息数组：只有模板 user 消息 + memory_save 工具，工具循环结束后整体丢弃
        const runner = llm.bindTools([memTool]);
        const msgs = [new HumanMessage(prompt)];
        let final = '';
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          const res = await runner.invoke(msgs);
          msgs.push(res);
          final = typeof res.content === 'string' ? res.content : '';
          const calls = extractCalls(res);
          if (calls.length === 0) break; // 纯文字总结，结束
          for (const tc of calls) {
            console.log(chalk.gray(`⚙ 执行工具 ${tc.name}`));
            const { text: out } = await invokeTool(tc.name, tc.args);
            console.log(chalk.gray(`✓ 返回: ${toolResultSummary(out)}`));
            msgs.push(new ToolMessage(out, tc.id || ''));
          }
        }
        stopSpinner();
        if (final.trim()) {
          console.log(renderAnswerLines(final.trim()).join('\n'));
        } else {
          console.log(chalk.yellow('（模型未返回总结文本，记忆工具调用结果见上）'));
        }
      } catch (err) {
        stopSpinner();
        console.log(chalk.red(`生成记忆失败：${err.message}`));
      }
      break;
    }
    default:
      console.log(chalk.yellow(`未知命令「${trigger}」，输入 /help 查看可用命令。`));
  }
}
export { askAssistant, handleCommand };
