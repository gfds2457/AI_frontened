#!/usr/bin/env node

import process from 'node:process';
import chalk from 'chalk';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { printBanner, printAssistantPrefix } from './src/utils/logger/logger.js';
import { createSessionId, saveMessages } from './src/utils/fs/storage.js';
import CONFIG from './config.js';
import { askAssistant, handleCommand, getMessages, setRuntimeContext, setRules } from './src/utils/chat/chatService.js';
import { isExitCommand, loadCustomCommands } from './src/utils/command/commands.js';
import { readContext, getUserContext, getSkillContext } from './src/utils/chat/context.js';
import { readRules } from './src/utils/chat/rules.js';
import { closeTools } from './src/tools/manager.js';
import { startToolServer } from './src/server/toolServer.js';
import { startCrewService, stopCrewService } from './src/server/crewService.js';
import * as renderer from './src/tui/renderer.js';
import { createInput } from './src/tui/input.js';

// 配置 marked：把 Markdown 渲染成终端彩色文本
marked.use(markedTerminal());

// 本次会话 ID：启动时用时间戳生成，作为对话记录的文件夹名
const sessionId = createSessionId();
const input = createInput();
let exiting = false;
// TUI 是否已接管终端：异步的就绪/告警提示要先判断它，没接管时直接打印即可
let tuiReady = false;
// 程序结束前一步：保存对话、复原终端，然后退出
async function shutdown() {
  if (exiting) return;
  exiting = true;
  input.stop();
  renderer.teardown();

  // 先停 Python 编排服务：它可能正在跑 crew，也可能握着工具服务的 keep-alive 长连接
  try {
    await stopCrewService();
  } catch {
    /* 忽略关闭错误 */
  }

  // 关闭 MCP 连接，避免残留 npx/chrome 等子进程
  try {
    await closeTools();
  } catch {
    /* 忽略关闭错误 */
  }

  try {
    const filePath = await saveMessages(getMessages(), CONFIG.storagePath, sessionId);
    console.log(chalk.gray(`✓ 对话已保存到 ${filePath}`));
  } catch (err) {
    console.log(chalk.yellow(`✗ 对话保存失败：${err.message}`));
  }
  console.log(chalk.gray('再见，期待下次合作！👋'));
  process.exit(0);
}

/** 指令分发：退出型指令走 shutdown，其余交给既有 handleCommand */
async function handleCommandFromInput(command) {
  if (isExitCommand(command)) {
    await shutdown();
    return;
  }
  await handleCommand(command);
}

// raw 模式兜底：若 keypress 未捕获到 Ctrl+C（例如 raw 尚未开启），靠信号退出。
// 第一次信号走优雅退出（关 MCP、存对话）；若退出流程被卡住，第二次信号直接强退，
// 保证任何情况下用户都能终止程序
function onExitSignal() {
  if (exiting) {
    process.exit(1);
  }
  shutdown();
}
process.on('SIGINT', onExitSignal);
process.on('SIGTERM', onExitSignal);

// 启动：打印横幅、问候语，加载自定义指令，然后进入逐键输入
printBanner();
printAssistantPrefix();
console.log(chalk.white('你好！我是你的 AI 编程助手，有什么可以帮你的吗？'));

await loadCustomCommands();

// ==================== 起本地服务 ====================
// ① 本地工具服务：Python 侧的 crew 拿不到终端，只能通过它回调 Node 执行工具
//    （confirm/select 要读 stdin、generate_image 要往终端打进度）。必须先起它，
//    否则拿不到端口，也就没法把 NODE_TOOL_URL 告诉 Python。
let toolPort = null;
if (CONFIG.crewEnabled) {
  try {
    ({ port: toolPort } = await startToolServer(0));
  } catch (err) {
    console.log(chalk.yellow(`⚠ 工具服务启动失败：${err.message}，CrewAI 编排不可用`));
  }
}

// ② CrewAI 编排服务（Python/uvicorn）：不 await —— 首次 import crewai 要几秒，
//    不能让它挡住输入。起不来只告警不阻塞：普通聊天不依赖 crew，
//    不该被 python 环境问题卡住（配 crewEnabled:false 可整段跳过）。
if (toolPort) {
  startCrewService({
    pythonExe: CONFIG.pythonExe,
    crewDir: CONFIG.crewDir,
    nodeToolUrl: `http://127.0.0.1:${toolPort}`,
    // 就绪/告警是几秒后异步到达的，此刻用户可能正在打字：先抹掉输入行再打印、再重画提示符，
    // 否则 renderer 记的行数会与实际屏幕错位（TUI 还没接管终端时直接打印即可）
    notify: (line) => {
      if (tuiReady) renderer.clear();
      console.log(line);
      if (tuiReady) renderer.showEmptyPrompt();
    },
  }).catch(() => {
    /* 失败已在模块内告警降级，这里只防未捕获的 rejection */
  });
}

// 读取系统上下文、用户上下文、技能上下文与规则集；上下文发给大模型但不写入对话历史
const [systemCtx, userCtx, skillCtx, rules] = await Promise.all([
  readContext(),
  getUserContext(),
  getSkillContext(),
  readRules(),
]);
const combinedCtx = [systemCtx, userCtx, skillCtx].filter(Boolean).join('\n\n');
if (combinedCtx) setRuntimeContext(combinedCtx);
setRules(rules);

tuiReady = true;
input.start({
  onMessage: async (text) => {
    await askAssistant(text);
  },
  onCommand: handleCommandFromInput,
  onExit: shutdown,
});
