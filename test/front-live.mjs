/**
 * 全链路验证：在**别的项目目录**跑真正的 app.js，确认它能拉起 Python、TUI 正常，
 * 并且走一次与真实 Ctrl+C 完全相同的退出路径后不留残余子进程。
 *
 * 为什么要伪 TTY（test/fake-tty.mjs）：stdin 不是 TTY 时 input.js 会立刻 requestExit，
 * 整个进程秒退，什么也验证不到。补上 TTY 特征后，往 stdin 写 \x03 会被 readline 解析成
 * {name:'c', ctrl:true}，与用户真按 Ctrl+C 命中同一条代码分支。
 *
 * 用法：node test/front-live.mjs
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withTimeout } from '../src/utils/asyncTimeout.js';
import { alive, createChecker, portFree, waitFor } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '../app.js');
// --import 在 Windows 上只接受 URL，给绝对路径会报 ERR_UNSUPPORTED_ESM_URL_SCHEME
const FAKE_TTY = pathToFileURL(path.join(HERE, 'fake-tty.mjs')).href;

const STEP_TIMEOUT = 90000;
const { ok, failed } = createChecker();

console.log('=========== front 全链路（伪 TTY + 真 Ctrl+C 路径）===========');
process.chdir(os.tmpdir());
console.log(`（cwd = ${process.cwd()}，模拟在别的项目目录执行 front）`);

const child = spawn(process.execPath, ['--import', FAKE_TTY, APP], {
  cwd: process.cwd(),
  stdio: ['pipe', 'pipe', 'pipe'],
});

let out = '';
let errOut = '';
child.stdout.on('data', (d) => { out += String(d); });
child.stderr.on('data', (d) => { errOut += String(d); });
const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));

try {
  // 只锚定机器可读的部分（URL + pid），别把断言绑在中文措辞和配色上：
  // 就绪行的文案属于展示细节，改一次文案不该让这条进程级契约失效
  const line = await waitFor(
    () => /(http:\/\/127\.0\.0\.1:(\d+)) \(pid (\d+)\)/.exec(out),
    STEP_TIMEOUT,
    'CrewAI 服务就绪行',
  );
  const [, url, port, pid] = line;
  console.log(`   [app] 就绪行：${line[0]}`);

  ok('front 在非包根目录拉起了 CrewAI 服务', true, url);
  ok('工具服务已启动', out.includes('工具服务已启动'));

  // 带超时：服务假死时不该把脚本挂在这儿
  const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) })
    .then((r) => r.json()).catch(() => null);
  ok('独立访问 /health 返回 ok:true', health?.ok === true, JSON.stringify(health));
  ok('pid 存活', alive(Number(pid)), `pid ${pid}`);

  // 与真实 Ctrl+C 同一条路径：\x03 → keypress(ctrl+c) → requestExit → shutdown
  child.stdin.write('\x03');
  // 不能用 waitFor(exitCode !== null) 这类真值判断：退出码 0 是假值，会一直等下去
  const code = await withTimeout(exited, STEP_TIMEOUT, '进程退出');
  ok('退出码为 0（走的是优雅退出）', code === 0, `code ${code}`);
  ok('退出后无残留 python 进程', !alive(Number(pid)), `pid ${pid}`);
  ok('退出后端口已释放', await portFree(Number(port)), `port ${port}`);
  ok('输出中没有启动报错', !/EADDRINUSE|ECONNREFUSED|Unhandled|ModuleNotFound/.test(out + errOut));
} catch (e) {
  ok(e.message, false);
  console.log(`--- stdout ---\n${out.slice(-2000)}\n--- stderr ---\n${errOut.slice(-2000)}`);
  child.kill();
  await exited;
}

console.log(failed() === 0 ? '🎉 全部通过' : `❌ ${failed()} 项失败`);
process.exit(failed() === 0 ? 0 : 1);
