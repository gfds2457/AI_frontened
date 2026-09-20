/**
 * 回归：confirm/select 借 stdin 问完一行后，必须把 stdin 完整交还给 TUI。
 *
 * 复现用户报告的故障：回答完一次 select 之后，界面照常显示 `你 >`，
 * 但打字没反应、Ctrl+C 也退不掉 —— readline.close() 会把 stdin pause 掉，
 * 而 raw 模式下 Ctrl+C 不再产生 SIGINT（按键全卡在被暂停的流里）。
 */
import { PassThrough } from 'node:stream';
import { emitKeypressEvents } from 'node:readline';
import { withLineInput } from '../src/utils/input/lineInput.js';

let fail = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' -> ' + extra : ''}`);
};

/** 假终端：PassThrough 冒充 TTY，setRawMode 只记录调用 */
function fakeTty() {
  const s = new PassThrough();
  s.isTTY = true;
  s.isRaw = true; // 进入行输入前，TUI 是开着 raw 模式的
  s.rawCalls = [];
  s.setRawMode = (v) => {
    s.isRaw = v;
    s.rawCalls.push(v);
  };
  s.resume();
  return s;
}

const tty = fakeTty();
const out = new PassThrough();

// TUI 侧：与 src/tui/input.js 一样，只靠 stdin 的 keypress 事件收按键
emitKeypressEvents(tty);
let keys = 0;
tty.on('keypress', () => keys++);

console.log('=========== 行输入结束后 stdin 必须还给 TUI ===========');
const answer = await withLineInput((ask) => {
  const p = ask('请选择编号: ');
  setImmediate(() => tty.write('2\n')); // 用户敲的回答
  return p;
}, { stream: tty, out });

ok('读到用户回答', answer === '2', JSON.stringify(answer));
ok('问话期间临时关掉 raw（走行模式）', tty.rawCalls[0] === false, JSON.stringify(tty.rawCalls));
ok('结束后 raw 模式已还原', tty.rawCalls.at(-1) === true);
ok('结束后 stdin 已恢复流动', !tty.isPaused());

// 关键：恢复流动之后按键还能被 TUI 收到 —— 这正是用户丢掉的能力
tty.write('a');
await new Promise((r) => setImmediate(r));
ok('后续普通按键仍能被 TUI 的 keypress 收听到', keys >= 1, `keypress=${keys}`);

tty.write('\x03'); // raw 模式下的 Ctrl+C 就是一个普通字节，必须能收到才能退出
await new Promise((r) => setImmediate(r));
ok('Ctrl+C 能被 TUI 收到（否则退不掉）', keys >= 2, `keypress=${keys}`);

console.log('\n=========== 非交互式终端 ===========');
const pipe = new PassThrough();
ok('非 TTY 返回 null，调用方据此回「无法交互」', (await withLineInput(() => 'x', { stream: pipe, out })) === null);

console.log(fail === 0 ? '\n🎉 全部通过' : `\n💥 ${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
