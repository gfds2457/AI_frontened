/**
 * 行输入会话 —— 把终端从 TUI 的 raw 模式临时交还给 readline 问一行，问完完整收回。
 *
 * 为什么必须在收尾时 resume：readline 的 close() 内部会调 input.pause()（见
 * node 内置 readline 的 Interface.close → pause → this.input.pause()），而 TUI 的按键
 * 全靠 stdin 处于流动状态时的 keypress 事件（src/tui/input.js）。少了这一步，
 * 用户回答完一次 select/confirm 之后整个程序就再也收不到任何按键 ——
 * 界面看着还在（输入行照常显示），打字没反应，连 Ctrl+C 也退不掉：
 * raw 模式下终端不会把 Ctrl+C 转成 SIGINT，按键又全卡在 pause 掉的流里。
 *
 * 非交互式终端（管道 / 测试）下返回 null，由调用方给出「无法交互」的结论。
 */
import readline from 'node:readline/promises';
import process from 'node:process';

/**
 * 借 stdin 问几行，结束后把 raw 模式与流动状态一并还给 TUI。
 * @param {(ask:(q:string)=>Promise<string>) => Promise<T>} fn 回调内用 ask 提问
 * @param {{stream?: NodeJS.ReadStream, out?: NodeJS.WriteStream}} [io] 默认进程标准输入输出，
 *        可注入假流以便回归测试（test/input-flow.mjs）
 * @returns {Promise<T|null>} 非 TTY 时返回 null
 * @template T
 */
export async function withLineInput(fn, { stream = process.stdin, out = process.stdout } = {}) {
  if (!stream.isTTY) return null;
  const wasRaw = Boolean(stream.isRaw);
  if (wasRaw) stream.setRawMode(false);
  const rl = readline.createInterface({ input: stream, output: out });
  try {
    return await fn((question) => rl.question(question));
  } finally {
    rl.close();
    if (wasRaw) stream.setRawMode(true);
    stream.resume(); // ← 见文件头：readline 在 close() 里留了个 pause，不捞回来 TUI 就聋了
  }
}
