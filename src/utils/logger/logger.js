import CONFIG from '../../../config.js';
import chalk from 'chalk';
import { COMMANDS } from '../command/commands.js';
/** 打印启动横幅 */
export function printBanner() {
  console.log('');
  console.log(chalk.bold.cyan('  🤖 AI 终端助手  v0.1.0'));
  console.log(chalk.gray('  ───────────────────────────────'));
  console.log(chalk.gray('  基于 OpenAI 大模型的终端对话界面'));
  console.log(chalk.gray(`  当前模型: ${CONFIG.model}`));
  if (!CONFIG.apiKey) {
    console.log(chalk.yellow('  提示: 未设置 OPENAI_API_KEY，将以演示模式运行'));
  }
  console.log('');
  console.log(chalk.gray('  输入内容后回车即可对话，输入 /help 查看可用命令。'));
  console.log('');
}

/** 打印帮助信息（与斜杠浮层共用同一份指令注册表） */
export function printHelp() {
  const maxLen = Math.max(...COMMANDS.map((c) => c.trigger.length));
  console.log('');
  console.log(chalk.bold('  可用命令:'));
  for (const c of COMMANDS) {
    console.log('  ' + chalk.cyan('  ' + c.trigger.padEnd(maxLen)) + chalk.gray('  ' + c.desc));
  }
  console.log('');
  console.log(chalk.bold('  消息内引用:'));
  console.log('  ' + chalk.cyan('  @文件路径') + chalk.gray('  选文件并把内容带进对话'));
  console.log('  ' + chalk.cyan('  拖入文件') + chalk.gray('  把文件拖进终端，路径自动加浅蓝框并读取内容'));
  console.log('  ' + chalk.cyan('  拖入图片') + chalk.gray('  把图片拖进终端，作为图片随消息发给模型'));
  console.log('  ' + chalk.cyan('  #图片') + chalk.gray('  弹出 .front/design 图片列表，选择后随文字发给模型'));
  console.log(chalk.bold('  素材图:'));
  console.log('  ' + chalk.cyan('  /asset 描述') + chalk.gray('  生成素材图存到 .front/design/AI-asset'));
  console.log(chalk.gray('  也可以直接按 Ctrl+C 退出。'));
  console.log('');
}

let spinnerTimer = null;
/** 在终端显示一个简易的加载动画 */
function startSpinner(text) {
  // 先停掉上一个：调用方会反复调它刷新文案（如出图进度每 3s 一次），不清的话每个都留下
  // 一个定时器，之后 stopSpinner() 只停得掉最后一个，其余会一直往终端写 \r 把输入行搅乱
  if (spinnerTimer) clearInterval(spinnerTimer);
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  spinnerTimer = setInterval(() => {
    process.stdout.write(`\r${chalk.cyan(frames[i % frames.length])} ${chalk.gray(text)}`);
    i += 1;
  }, 80);
}
/** 停止并清掉加载动画所在行 */
function stopSpinner() {
  if (spinnerTimer) {
    clearInterval(spinnerTimer);
    spinnerTimer = null;
    process.stdout.write('\r\x1b[2K');
  }
}
export { startSpinner, stopSpinner };

/** 打印「助手」前缀 */
// //console.log() = 输出内容并且自动换行
// process.stdout.write() = 只输出文字，不会自动敲回车换行
const printAssistantPrefix = () => process.stdout.write(chalk.bold.green('助手: '));

/** 打印用户输入提示符 */
const printUserPrompt = () => process.stdout.write(chalk.bold.cyan('你 > '));
export { printAssistantPrefix, printUserPrompt }; 
