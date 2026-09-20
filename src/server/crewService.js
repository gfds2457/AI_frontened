/**
 * CrewAI 编排服务（Python / uvicorn）的生命周期管理：拉起、探活、清理。
 *
 * 为什么要有这个模块：Python 侧（python-fastapi/）是纯编排引擎，它自己不碰终端，
 * 由 Node 保留终端所有权并把它作为子进程拉起（见 需求规划.md §2 系统架构）。
 * 用户敲 `front` 时不管身处哪个项目目录，都要能把它拉起来 —— 所以本模块有一条硬规则：
 *
 *   所有路径解析的基准是**包根目录**，绝不是 process.cwd()。
 *
 * `front` 是 npm link 出来的符号链接，Node 默认按 realpath 解析模块，因此 import.meta.url
 * 在任何目录下都指向真实包路径；而 `python-fastapi/.venv/...` 这种配置值的语义只能是
 * 「包内相对路径」。早期版本按 cwd 解析，换个项目目录执行 front 就会找不到解释器。
 *
 * 本模块不 import config.js（config.js 顶层要读 cwd 下的 .front/setting.json，会污染单测），
 * 配置由调用方传参；输出走注入的 notify，不直接依赖 TUI。
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { withTimeout } from '../utils/asyncTimeout.js';

/** 包根目录（src/server/ 往上两级）。见模块头的说明，不要改用 process.cwd() */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** venv 里解释器的相对位置：Windows 是 Scripts/python.exe，POSIX 是 bin/python */
export const DEFAULT_PYTHON_EXE = path.join(
  'python-fastapi',
  '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);

/** Python 服务的相对目录（uvicorn 必须以它为工作目录，同目录模块才进得了 sys.path） */
export const DEFAULT_CREW_DIR = 'python-fastapi';

/**
 * 就绪等待上限。实测冷启动（磁盘缓存全冷）光 `import uvicorn, crewai` 就要 ~49s，
 * 30s 会把一个**健康但慢**的启动误判成失败并 kill 掉，所以这里给到 ~1.8 倍余量。
 * 超时只影响「进程活着却一直不就绪」这种真异常；进程提前退出有 exitCode 检查，
 * 不会被这个值拖慢（见 startCrewService 的探活循环）。
 */
export const READY_TIMEOUT_MS = 90000;

/** 关闭等待上限：与 manager.js 的 MCP_CLOSE_TIMEOUT 同一口径 —— shutdown 绝不能被拖住 */
export const STOP_TIMEOUT_MS = 5000;

/** 探活间隔 */
const PROBE_INTERVAL_MS = 300;

/** 失败时回吐的日志尾部行数：够看清 traceback，又不会淹没终端 */
const LOG_TAIL_LINES = 50;

/** 子进程句柄与状态。句柄存模块级，保证「服务还没就绪就 Ctrl+C」也能杀干净 */
let child = null;
let stderrTail = [];
let stopRequested = false;
let state = { status: 'off', port: null, url: null, pid: null, error: null };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 当前服务状态快照（供调用方判断能否走 crew，而不是等 HTTP 报错） */
export function getCrewStatus() {
  return { ...state };
}

/**
 * 解析解释器与服务工作目录。
 *
 * 绝对路径原样使用（用户把 python 装在别处时写绝对路径）；相对路径一律相对包根解析。
 * 报错信息里带上**解析后的绝对路径**，用户一眼能看出是哪一步找错了。
 */
export async function resolveCrewPaths({
  pythonExe = DEFAULT_PYTHON_EXE,
  crewDir = DEFAULT_CREW_DIR,
} = {}) {
  const toAbs = (p) => (path.isAbsolute(p) ? p : path.resolve(PACKAGE_ROOT, p));
  const exe = toAbs(pythonExe);
  const dir = toAbs(crewDir);

  try {
    await fs.access(exe);
  } catch {
    return { ok: false, pythonExe: exe, crewDir: dir, error: `未找到 Python 解释器：${exe}` };
  }
  try {
    await fs.access(path.join(dir, 'main.py'));
  } catch {
    return { ok: false, pythonExe: exe, crewDir: dir, error: `未找到编排服务入口：${path.join(dir, 'main.py')}` };
  }
  return { ok: true, pythonExe: exe, crewDir: dir };
}

/**
 * 取一个系统分配的空闲端口。
 *
 * 先 listen(0) 拿到端口再立刻关闭，随后把它作为 uvicorn 的 --port 传过去 ——
 * 与 Python 侧既有约定一致（main.py 注释：端口由 Node 分配并通过命令行传入），不用改 Python。
 * 选完到 uvicorn 真正 bind 之间有几十毫秒的竞态窗口，真撞上会以「进程提前退出 + 日志尾部」
 * 明确告警，不会静默失败。
 */
export async function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * 拼 uvicorn 启动参数（纯函数，便于单测）。
 *
 * 返回数组而不是字符串：不经 shell，含空格/中文的路径才安全。
 * 绝不加 --reload：它会多一层 reloader 父进程，kill 不干净会留下残留进程。
 */
export function buildCrewArgs({ port }) {
  return [
    '-m', 'uvicorn', 'main:app',
    '--host', '127.0.0.1',
    '--port', String(port),
    '--log-level', 'warning',
    '--no-access-log',
  ];
}

/**
 * 拼子进程环境变量（纯函数，便于单测）。
 *
 * - NODE_TOOL_URL：Python 侧据此回调 Node 的工具服务（node_tools.py 读它）
 * - PYTHONIOENCODING / PYTHONUTF8：Windows 中文控制台默认 GBK，日志带中文会直接崩
 * - CREWAI_TRACING_ENABLED：关掉 tracing 的首次询问（bootstrap.py 也会兜底设一次）
 */
export function buildCrewEnv({ nodeToolUrl, base = process.env } = {}) {
  return {
    ...base,
    NODE_TOOL_URL: nodeToolUrl,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    CREWAI_TRACING_ENABLED: 'false',
  };
}

/** 探活：能拿到 {ok:true} 才算就绪。任何异常（连不上、超时、非 JSON）都只算「还没好」 */
export async function probeHealth(url, timeoutMs = 1500) {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    return (await res.json())?.ok === true;
  } catch {
    return false;
  }
}

/** 收集子进程输出到环形缓冲。必须立刻消费管道，否则写满会挂住 uvicorn */
function collectLog(chunk) {
  const lines = String(chunk).split(/\r?\n/).filter((l) => l.trim());
  stderrTail.push(...lines);
  if (stderrTail.length > LOG_TAIL_LINES) stderrTail = stderrTail.slice(-LOG_TAIL_LINES);
}

/** 失败时把日志尾部拼成一行可读详情 */
function tailDetail() {
  return stderrTail.slice(-3).join(' | ') || '无输出';
}

/** 启动失败：告警、把子进程收干净，再把状态盖回 failed（stopCrewService 会写成 stopped） */
async function fail(reason, notify) {
  notify(chalk.yellow(`⚠ CrewAI 服务未启动：${reason}`));
  await stopCrewService();
  state = { ...state, status: 'failed', error: reason, pid: null };
  return { ok: false, status: 'failed', error: reason, port: null, url: null, pid: null };
}

/**
 * 拉起 Python 服务并等它就绪。
 *
 * 不 reject：失败与成功都以 resolve 返回（含 ok 字段），调用方只需按用户可读的原因降级 ——
 * 聊天功能不依赖 crew，不该被 python 环境问题卡住。
 *
 * @param {object} opts
 * @param {string} opts.pythonExe venv 解释器路径（相对路径相对包根）
 * @param {string} opts.crewDir 编排服务目录（相对路径相对包根）
 * @param {string} opts.nodeToolUrl Node 工具服务地址，通过 NODE_TOOL_URL 传给 Python
 * @param {(line:string)=>void} [opts.notify] 输出通道（就绪/告警各一行）
 * @param {number} [opts.readyTimeoutMs]
 * @returns {Promise<{ok:boolean, status:string, port:number|null, url:string|null, pid:number|null, error?:string}>}
 */
export async function startCrewService({
  pythonExe,
  crewDir,
  nodeToolUrl,
  notify = console.log,
  readyTimeoutMs = READY_TIMEOUT_MS,
} = {}) {
  // 已在跑或正在起就直接返回现状：state 一进来就置 starting，靠它挡住并发的第二次调用
  // （不能用 child 判断 —— child 要等两个 await 之后才赋值，那之前两次调用会各 spawn 一个，
  //  且先 spawn 出来的那个句柄会被后一个覆盖，变成谁也杀不掉的孤儿）
  if (state.status === 'starting' || state.status === 'ready') {
    return { ok: state.status === 'ready', ...getCrewStatus() };
  }

  // 复位：允许「停掉之后再起一次」
  stopRequested = false;
  stderrTail = [];
  state = { status: 'starting', port: null, url: null, pid: null, error: null };

  const paths = await resolveCrewPaths({ pythonExe, crewDir });
  // 每个 await 之后都要复检：非 TTY 下 input.start() 会同步走到 shutdown→process.exit，
  // 若不检查，下面的 spawn 会在退出流程跑完之后才执行，凭空留下一个孤儿 python
  if (stopRequested) return { ok: false, status: 'stopped', error: '启动过程中已退出', port: null, url: null, pid: null };
  if (!paths.ok) return fail(paths.error, notify);

  const port = await pickFreePort();
  if (stopRequested) return { ok: false, status: 'stopped', error: '启动过程中已退出', port: null, url: null, pid: null };

  const url = `http://127.0.0.1:${port}`;
  let spawnError = null;

  try {
    child = spawn(paths.pythonExe, buildCrewArgs({ port }), {
      cwd: paths.crewDir,
      env: buildCrewEnv({ nodeToolUrl }),
      stdio: ['ignore', 'pipe', 'pipe'], // stdin 必须是 ignore：Python 侧硬规则「永不读 stdin」
      windowsHide: true,
    });
  } catch (err) {
    return fail(`无法启动 Python：${err.message}`, notify);
  }

  // 捕获局部句柄：stopCrewService 会把模块级 child 置空，下面的等待里它可能已经被调用
  const proc = child;

  // spawn 失败（ENOENT/EACCES）是异步 'error' 事件，不挂会直接崩掉整个进程
  proc.on('error', (err) => { spawnError = err.message; });
  proc.stdout.on('data', collectLog);
  proc.stderr.on('data', collectLog);
  proc.on('exit', (code) => {
    if (state.status === 'starting') collectLog(`进程退出，code=${code}`);
  });

  state = { ...state, port, url, pid: proc.pid };

  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    if (stopRequested) return { ok: false, status: 'stopped', error: '启动过程中已退出', port: null, url: null, pid: null };
    if (spawnError) return fail(`无法启动 Python：${spawnError}`, notify);
    // 进程提前退出（如没装 uvicorn）时立刻报错，不傻等到超时
    if (proc.exitCode !== null) return fail(`Python 进程提前退出：${tailDetail()}`, notify);

    const healthy = await probeHealth(url);
    // 探活期间可能已经被关掉（用户 Ctrl+C）：此刻不能再报「就绪」，否则等于给一个
    // 已经杀掉的进程发成功回执，state 也会被从 stopped 翻回 ready
    if (stopRequested) return { ok: false, status: 'stopped', error: '启动过程中已退出', port: null, url: null, pid: null };
    if (healthy) {
      state = { ...state, status: 'ready', error: null };
      notify(chalk.gray(`✓ CrewAI 服务已就绪 ${url} (pid ${proc.pid})`));
      return { ok: true, status: 'ready', port, url, pid: proc.pid };
    }
    await sleep(PROBE_INTERVAL_MS);
  }

  // 超时：不能留一个活着的半成品，先收尸再告警
  return fail(`就绪超时（${readyTimeoutMs}ms），日志：${tailDetail()}`, notify);
}

/**
 * 关闭 Python 子进程。幂等，可反复调用。
 *
 * 无 --reload，uvicorn 是单进程，kill 一次就够。带超时兜底：SIGTERM 后仍不退出就强杀，
 * 保证 shutdown 不被拖住（验收标准：退出后无残留子进程）。
 */
export async function stopCrewService(timeoutMs = STOP_TIMEOUT_MS) {
  stopRequested = true;
  const proc = child;
  child = null;
  state = { ...state, status: 'stopped', pid: null };
  if (!proc || proc.exitCode !== null || proc.signalCode) return;

  const exited = new Promise((resolve) => proc.once('exit', resolve));
  try {
    proc.kill();
  } catch {
    /* 进程可能已消失 */
  }
  try {
    await withTimeout(exited, timeoutMs, 'Python 子进程退出');
  } catch {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* 已经死了就算了 */
    }
  }
}

/**
 * 退出兜底：process.exit() 会同步执行 'exit' 回调，这里同步 kill 一次，
 * 覆盖所有退出入口 —— app.js 的 shutdown、连按两次 Ctrl+C 的 forceExit、
 * 以及各测试脚本里各自的 shutdown 实现。
 *
 * 已知限制：Node 被 SIGKILL / 任务管理器强杀时没有回调机会，Python 可能成为孤儿
 * （Windows 无自动父子绑定，要彻底解决得用 Job Object，见 需求规划.md 验收标准 3）。
 */
process.on('exit', () => {
  if (child && child.exitCode === null) {
    try {
      child.kill();
    } catch {
      /* 尽力而为 */
    }
  }
});
