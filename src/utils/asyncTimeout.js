/**
 * 给 Promise 加超时兜底：超时后以 Error 拒绝。
 * 注意：超时不会取消底层任务（它会继续在后台运行），只是让调用方不再无限等待——
 * 终端 TUI 的输入锁（busy）依赖业务 Promise 最终 settle，任何永不返回的 await
 * 都会导致用户按键被永久忽略，因此所有外部进程/网络调用都应包一层 withTimeout。
 * @param {Promise<T>} promise 原始任务
 * @param {number} ms 超时毫秒数
 * @param {string} label 错误提示中的任务名
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超过 ${ms}ms 未响应，已跳过`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
