/**
 * test/*.mjs 验证脚本共用的小工具：断言计数、进程存活、端口释放、异步等待。
 *
 * 抽成一份的原因：这几个脚本原本各写一份，语义已经开始漂移 —— portFree 在 crew-live.mjs
 * 里会重试、在 front-live.mjs 里只试一次，而 Windows 上子进程刚被杀时内核可能还占着端口一瞬，
 * 于是同一个判定在两处得到相反结果。共用后不会再分叉。
 */
import net from 'node:net';
import process from 'node:process';

/** 断言器：只累计失败数，不中断执行（沿用本项目 test/*.mjs 的既有风格） */
export function createChecker() {
  let failed = 0;
  const ok = (name, cond, extra = '') => {
    if (!cond) failed++;
    console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' -> ' + extra : ''}`);
  };
  return { ok, failed: () => failed };
}

/** 进程是否还活着（信号 0 只做存在性检查，不真的发信号） */
export const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const portFreeOnce = (port) =>
  new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });

/** 端口是否已被释放（= 能被重新监听）。进程刚退出时内核可能还没放开，重试几次再下结论 */
export async function portFree(port, retries = 10) {
  for (let i = 0; i < retries; i++) {
    if (await portFreeOnce(port)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** 轮询等待条件成立；超时抛错（调用方负责给出可读的失败信息） */
export async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`等待超时：${label}`);
}
