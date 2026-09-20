/**
 * src/server/crewService.js 单元测试（vitest）
 *
 * 设计原则：
 * 1. 只验证 src/server/crewService.js 的导出行为，绝不修改业务源码；
 * 2. 绝不真拉起 uvicorn / python —— 那属于集成测试（test/crew-live.mjs）。
 *    startCrewService 的用例只覆盖「解释器/入口不存在 → 优雅降级」的早退分支，
 *    该分支在 spawn() 之前就返回，不会有任何子进程产生；HTTP 与端口交互统一用
 *    node:http / node:net 的假服务完成，整份用例秒级跑完；
 * 3. 需要改 cwd 的用例（路径基准回归）在 afterEach 里统一复位，保证用例互不污染；
 * 4. 每个 it 都可独立运行 / 独立筛选（npx vitest run -t "关键字"）。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { existsSync, promises as fs } from 'node:fs';

import {
  DEFAULT_CREW_DIR,
  DEFAULT_PYTHON_EXE,
  PACKAGE_ROOT,
  buildCrewArgs,
  buildCrewEnv,
  getCrewStatus,
  pickFreePort,
  probeHealth,
  resolveCrewPaths,
  startCrewService,
  stopCrewService,
} from '../../src/server/crewService.js';

/* ------------------------------------------------------------------ 公共夹具 */

const ORIGINAL_CWD = process.cwd();

/** 任何用例改了 cwd 都在这里复位：避免污染其它用例（尤其是路径基准回归用例） */
afterEach(() => {
  process.chdir(ORIGINAL_CWD);
});

/**
 * 假解释器：只被 resolveCrewPaths 的 fs.access 检查、从不被执行，
 * 所以直接借用当前 node 可执行文件（绝对路径且必然存在）最稳。
 */
const FAKE_PYTHON_EXE = process.execPath;

/** 含 main.py 的临时目录，语义上等价于 python-fastapi/ */
let fakeServiceDir;
/** 不含 main.py 的临时目录（入口缺失的异常场景） */
let emptyDir;

beforeAll(async () => {
  fakeServiceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crew-unit-svc-'));
  await fs.writeFile(path.join(fakeServiceDir, 'main.py'), '# fake uvicorn entry\n');
  emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crew-unit-empty-'));
});

afterAll(async () => {
  process.chdir(ORIGINAL_CWD);
  await fs.rm(fakeServiceDir, { recursive: true, force: true });
  await fs.rm(emptyDir, { recursive: true, force: true });
});

/* -------------------------------------------------------------------- 工具 */

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** 起一个 node:http 假服务（探活用，绝不涉及 python） */
function listenFakeServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** 关假服务：顺手断开残留连接，防止 keep-alive / 永不响应的请求把 close() 卡死 */
function closeFakeServer(server) {
  return new Promise((resolve) => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => resolve());
  });
}

const fakeUrl = (server) => `http://127.0.0.1:${server.address().port}`;

/** 固定 JSON 响应的 handler */
const jsonHandler = (body, status = 200) => (_req, res) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

/** 在指定端口上 listen，用于验证 pickFreePort 给的端口真的空闲 */
function listenOn(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

const closeNetServer = (server) => new Promise((resolve) => server.close(resolve));

/**
 * 端口是否真的放开了。子进程刚死时监听套接字在 OS 侧还有一个短暂的收尾过程，
 * 单次 listen 会误报 EADDRINUSE，因此给几次重试（与 test/helpers.mjs 的 portFree 同理）。
 */
async function portReleased(port, retries = 10) {
  for (let i = 0; i < retries; i++) {
    try {
      await closeNetServer(await listenOn(port));
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return false;
}

/* ---------------------------------------------------------------- 路径常量 */

describe('路径常量', () => {
  it('PACKAGE_ROOT 是包根（src/server/crewService.js 相对它存在）且为绝对路径', async () => {
    expect(path.isAbsolute(PACKAGE_ROOT)).toBe(true);
    // 包根是 src/server 往上两级，绝不该停在 src 或 src/server
    expect(path.basename(PACKAGE_ROOT)).not.toBe('src');
    expect(path.basename(PACKAGE_ROOT)).not.toBe('server');
    await expect(
      fs.access(path.join(PACKAGE_ROOT, 'src', 'server', 'crewService.js')),
    ).resolves.toBeUndefined();
  });

  it('DEFAULT_CREW_DIR 是包内相对路径 python-fastapi', () => {
    expect(DEFAULT_CREW_DIR).toBe('python-fastapi');
    expect(path.isAbsolute(DEFAULT_CREW_DIR)).toBe(false);
  });

  it('DEFAULT_PYTHON_EXE 是 venv 内的相对路径，且按平台取 Scripts/bin', () => {
    expect(path.isAbsolute(DEFAULT_PYTHON_EXE)).toBe(false);
    const segments = DEFAULT_PYTHON_EXE.split(path.sep);
    const expected =
      process.platform === 'win32'
        ? ['python-fastapi', '.venv', 'Scripts', 'python.exe']
        : ['python-fastapi', '.venv', 'bin', 'python'];
    expect(segments).toEqual(expected);
  });
});

/* ------------------------------------------------------------ buildCrewArgs */

describe('buildCrewArgs', () => {
  it('返回数组而非字符串，且包含 uvicorn 启动必需参数', () => {
    const args = buildCrewArgs({ port: 8000 });
    expect(Array.isArray(args)).toBe(true);
    expect(typeof args).toBe('object'); // 字符串会过不了 Array.isArray，这里再加一道语义断言
    expect(args).toContain('-m');
    expect(args).toContain('uvicorn');
    expect(args).toContain('main:app');
    expect(args).toContain('--host');
    expect(args).toContain('127.0.0.1');
  });

  it('--port 的值是字符串，且紧跟 --port 之后', () => {
    const args = buildCrewArgs({ port: 8000 });
    const index = args.indexOf('--port');
    expect(index).toBeGreaterThan(-1);
    expect(typeof args[index + 1]).toBe('string');
    expect(args[index + 1]).toBe('8000');
  });

  it('边界端口（0 / 1 / 65535）也能正确字符串化', () => {
    for (const port of [0, 1, 65535]) {
      const args = buildCrewArgs({ port });
      expect(args[args.indexOf('--port') + 1]).toBe(String(port));
    }
  });

  it('每个元素都是字符串（不经 shell，含空格/中文路径才安全）', () => {
    expect(buildCrewArgs({ port: 8123 }).every((a) => typeof a === 'string')).toBe(true);
  });

  it('绝不出现 --reload（reloader 父进程会留下杀不干净的残留）', () => {
    const args = buildCrewArgs({ port: 8000 });
    expect(args).not.toContain('--reload');
    expect(args.some((a) => String(a).includes('reload'))).toBe(false);
  });

  it('非数字端口也不会抛异常（String 兜底，保持纯函数）', () => {
    expect(() => buildCrewArgs({ port: undefined })).not.toThrow();
    expect(buildCrewArgs({ port: undefined })).toContain('undefined');
  });
});

/* ------------------------------------------------------------- buildCrewEnv */

describe('buildCrewEnv', () => {
  it('注入 4 个关键环境变量（值均为字符串）', () => {
    const env = buildCrewEnv({ nodeToolUrl: 'http://127.0.0.1:4100' });
    expect(env.NODE_TOOL_URL).toBe('http://127.0.0.1:4100');
    expect(env.PYTHONIOENCODING).toBe('utf-8');
    expect(env.PYTHONUTF8).toBe('1');
    expect(env.CREWAI_TRACING_ENABLED).toBe('false');
  });

  it('继承传入的 base 环境（PATH 等自定义变量不丢）', () => {
    const base = { PATH: '/usr/bin', FOO: 'bar', EMPTY: '' };
    const env = buildCrewEnv({ nodeToolUrl: 'http://127.0.0.1:1', base });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.FOO).toBe('bar');
    expect(env.EMPTY).toBe('');
  });

  it('固定项覆盖 base 里的同名冲突值，且不改动 base 本身', () => {
    const base = {
      NODE_TOOL_URL: 'http://stale:1',
      PYTHONUTF8: '0',
      PYTHONIOENCODING: 'gbk',
      CREWAI_TRACING_ENABLED: 'true',
    };
    const env = buildCrewEnv({ nodeToolUrl: 'http://127.0.0.1:4100', base });

    expect(env.NODE_TOOL_URL).toBe('http://127.0.0.1:4100');
    expect(env.PYTHONUTF8).toBe('1');
    expect(env.PYTHONIOENCODING).toBe('utf-8');
    expect(env.CREWAI_TRACING_ENABLED).toBe('false');

    // base 没被就地改写（纯函数）
    expect(base.NODE_TOOL_URL).toBe('http://stale:1');
    expect(base.PYTHONUTF8).toBe('0');
    expect(base.CREWAI_TRACING_ENABLED).toBe('true');
    expect(env).not.toBe(base);
  });

  it('nodeToolUrl 为空时该键存在但不炸（透传给 Python 的语义由调用方保证）', () => {
    const env = buildCrewEnv({ nodeToolUrl: undefined, base: {} });
    expect(Object.prototype.hasOwnProperty.call(env, 'NODE_TOOL_URL')).toBe(true);
    expect(env.NODE_TOOL_URL).toBeUndefined();
  });

  it('默认 base 为 process.env（继承当前进程环境）', () => {
    const env = buildCrewEnv({ nodeToolUrl: 'http://127.0.0.1:1' });
    // 至少继承一个必然存在的进程环境键（PATH / Path）
    const hasPathLike = Object.keys(process.env).some((k) => k.toLowerCase() === 'path');
    if (hasPathLike) {
      expect(env.PATH ?? env.Path).toBe(process.env.PATH ?? process.env.Path);
    }
    expect(env).not.toBe(process.env);
  });
});

/* ---------------------------------------------------------- resolveCrewPaths */

describe('resolveCrewPaths', () => {
  it('默认相对值解析成 PACKAGE_ROOT 下的绝对路径', async () => {
    const res = await resolveCrewPaths({});

    expect(res.pythonExe).toBe(path.resolve(PACKAGE_ROOT, DEFAULT_PYTHON_EXE));
    expect(res.crewDir).toBe(path.resolve(PACKAGE_ROOT, DEFAULT_CREW_DIR));
    expect(path.isAbsolute(res.pythonExe)).toBe(true);
    expect(path.isAbsolute(res.crewDir)).toBe(true);
    expect(res.pythonExe.startsWith(PACKAGE_ROOT)).toBe(true);
    expect(res.crewDir.startsWith(PACKAGE_ROOT)).toBe(true);

    // ok 取决于本机 venv 是否就绪（test/crew-live.mjs 同样依赖它）：
    // 就绪 → 必须 ok:true 且无 error；未就绪 → 必须是 ok:false 且带可读 error，绝不抛异常
    const ready = (await exists(res.pythonExe)) && (await exists(path.join(res.crewDir, 'main.py')));
    if (ready) {
      expect(res.ok).toBe(true);
      expect(res.error).toBeUndefined();
    } else {
      expect(res.ok).toBe(false);
      expect(typeof res.error).toBe('string');
      expect(res.error.length).toBeGreaterThan(0);
    }
  });

  it('绝对路径原样返回（用户把 python 装在别处时的显式路径）', async () => {
    const res = await resolveCrewPaths({ pythonExe: FAKE_PYTHON_EXE, crewDir: fakeServiceDir });
    expect(res.ok).toBe(true);
    expect(res.pythonExe).toBe(FAKE_PYTHON_EXE);
    expect(res.crewDir).toBe(fakeServiceDir);
    expect(res.error).toBeUndefined();
  });

  it('自定义相对路径也以包根为基准解析', async () => {
    const res = await resolveCrewPaths({ pythonExe: 'some/dir/python', crewDir: 'some/dir' });
    expect(res.pythonExe).toBe(path.resolve(PACKAGE_ROOT, 'some', 'dir', 'python'));
    expect(res.crewDir).toBe(path.resolve(PACKAGE_ROOT, 'some', 'dir'));
  });

  it('【关键回归】cwd 切到系统临时目录后，解析结果与包根目录下完全一致', async () => {
    const atPackageRoot = await resolveCrewPaths({});

    process.chdir(os.tmpdir());
    // 不强制断言 cwd 与 os.tmpdir() 字面相等（macOS 上 /var 是 /private/var 的软链，
    // getcwd() 返回规范路径），只要求确实换到了包根之外的目录，回归语义即成立
    expect(process.cwd().startsWith(PACKAGE_ROOT)).toBe(false);

    const atTmpDir = await resolveCrewPaths({});
    expect(atTmpDir).toEqual(atPackageRoot);
    // 基准是包根，不是 cwd：结果必须仍在 PACKAGE_ROOT 下
    expect(atTmpDir.pythonExe).toBe(path.resolve(PACKAGE_ROOT, DEFAULT_PYTHON_EXE));
    expect(atTmpDir.crewDir).toBe(path.resolve(PACKAGE_ROOT, DEFAULT_CREW_DIR));
  });

  it('【关键回归】cwd 变化不影响自定义相对路径的解析结果', async () => {
    const before = await resolveCrewPaths({ pythonExe: 'rel/python', crewDir: 'rel/dir' });
    process.chdir(os.tmpdir());
    const after = await resolveCrewPaths({ pythonExe: 'rel/python', crewDir: 'rel/dir' });
    expect(after).toEqual(before);
  });

  it('解释器不存在：ok:false，且 error 里含解析后的绝对路径', async () => {
    const rel = 'definitely/not/here/python-xyz';
    const absolute = path.resolve(PACKAGE_ROOT, rel);
    const res = await resolveCrewPaths({ pythonExe: rel, crewDir: fakeServiceDir });

    expect(res.ok).toBe(false);
    expect(res.pythonExe).toBe(absolute);
    expect(path.isAbsolute(res.pythonExe)).toBe(true);
    expect(res.error).toContain(absolute);
  });

  it('解释器存在但 main.py 不存在：ok:false，error 指向入口文件绝对路径', async () => {
    const res = await resolveCrewPaths({ pythonExe: FAKE_PYTHON_EXE, crewDir: emptyDir });

    expect(res.ok).toBe(false);
    expect(res.crewDir).toBe(emptyDir);
    expect(res.error).toContain(path.join(emptyDir, 'main.py'));
  });

  it('解释器与目录都不存在时优先报解释器缺失（先查 exe，报错更贴近原因）', async () => {
    const res = await resolveCrewPaths({ pythonExe: 'nope/python', crewDir: 'nope/dir' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain(path.resolve(PACKAGE_ROOT, 'nope', 'python'));
  });

  it('任何输入都不 reject（返回结构固定，调用方无需 try/catch）', async () => {
    // 刻意用确定不存在的相对路径，避开「空串被 resolve 回包根、包根恰好有 main.py」的歧义
    await expect(
      resolveCrewPaths({ pythonExe: 'no/such/python', crewDir: '' }),
    ).resolves.toMatchObject({ ok: false });
    await expect(resolveCrewPaths()).resolves.toHaveProperty('ok');
  });
});

/* --------------------------------------------------------------- pickFreePort */

describe('pickFreePort', () => {
  it('返回 1024-65535 之间的整数', async () => {
    const port = await pickFreePort();
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThanOrEqual(1024);
    expect(port).toBeLessThanOrEqual(65535);
  });

  it('返回的端口当场可以被重新 listen（说明是真空闲，不是假占位）', async () => {
    const port = await pickFreePort();
    const server = await listenOn(port);
    expect(server.address().port).toBe(port);
    await closeNetServer(server);
  });

  it('连续调用都返回合法端口，且每次都能立刻 bind（不返回脏端口）', async () => {
    for (let i = 0; i < 3; i += 1) {
      const port = await pickFreePort();
      expect(Number.isInteger(port)).toBe(true);
      const server = await listenOn(port);
      await closeNetServer(server);
    }
  });

  it('选完端口后自身不残留监听（unref + close 生效）', async () => {
    const port = await pickFreePort();
    // 能立刻 bind 就说明 pickFreePort 内部的探测 server 已经关掉了
    const server = await listenOn(port);
    await closeNetServer(server);
    // 再绑一次仍然成功，排除「第一次侥幸 / 端口被内部 server 占着」
    const again = await listenOn(port);
    await closeNetServer(again);
  });
});

/* ----------------------------------------------------------------- probeHealth */

describe('probeHealth', () => {
  /** 本用例内创建的假服务，afterEach 统一回收 */
  const servers = [];
  const start = async (handler) => {
    const server = await listenFakeServer(handler);
    servers.push(server);
    return fakeUrl(server);
  };

  afterEach(async () => {
    while (servers.length > 0) {
      await closeFakeServer(servers.pop());
    }
  });

  it('返回 200 且 body 为 {ok:true} 时为 true', async () => {
    const url = await start(jsonHandler({ ok: true }));
    await expect(probeHealth(url)).resolves.toBe(true);
  });

  it('body 为 {ok:false} 时为 false（HTTP 200 但不健康）', async () => {
    const url = await start(jsonHandler({ ok: false }));
    await expect(probeHealth(url)).resolves.toBe(false);
  });

  it('body 是裸 true（非对象）时为 false，不抛异常', async () => {
    const url = await start(jsonHandler('true'));
    await expect(probeHealth(url)).resolves.toBe(false);
  });

  it('HTTP 500 时为 false，不抛异常', async () => {
    const url = await start(jsonHandler({ ok: true }, 500));
    await expect(probeHealth(url)).resolves.toBe(false);
  });

  it('body 不是 JSON 时为 false（res.json() 抛错被吞掉）', async () => {
    const url = await start((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('i am absolutely not json');
    });
    await expect(probeHealth(url)).resolves.toBe(false);
  });

  it('连接被拒绝（ECONNREFUSED）时为 false，不抛异常', async () => {
    const port = await pickFreePort();
    await expect(probeHealth(`http://127.0.0.1:${port}`)).resolves.toBe(false);
  });

  it('地址不可解析时为 false，不抛异常', async () => {
    await expect(probeHealth('http://127.0.0.1:0')).resolves.toBe(false);
  });

  it('带超时参数时不会挂死：服务永不响应也在超时后返回 false', async () => {
    // 只拿到请求、永不 res.end()
    const url = await start(() => {});
    const startedAt = Date.now();
    await expect(probeHealth(url, 300)).resolves.toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it('超时参数对正常响应无副作用', async () => {
    const url = await start(jsonHandler({ ok: true }));
    const startedAt = Date.now();
    await expect(probeHealth(url, 1500)).resolves.toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1500);
  });

  it('拼接路径固定为 /health（换个路径应该探不到）', async () => {
    const hits = [];
    const url = await start((req, res) => {
      hits.push(req.url);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await probeHealth(url);
    expect(hits).toContain('/health');
  });
});

/* --------------------------------------------------------------- getCrewStatus */

describe('getCrewStatus', () => {
  it('返回包含约定字段的快照', () => {
    const snap = getCrewStatus();
    expect(Object.keys(snap).sort()).toEqual(['error', 'pid', 'port', 'status', 'url']);
  });

  it('status 的取值在约定枚举内', () => {
    expect(['off', 'starting', 'ready', 'stopped', 'failed']).toContain(getCrewStatus().status);
  });

  it('返回的是副本：外部改它不会污染内部状态', () => {
    const snap = getCrewStatus();
    snap.status = 'hacked';
    snap.port = -1;
    snap.pid = -1;

    const fresh = getCrewStatus();
    expect(fresh).not.toBe(snap);
    expect(fresh.status).not.toBe('hacked');
    expect(fresh.port).not.toBe(-1);
    expect(fresh.pid).not.toBe(-1);
  });

  it('反复调用结果稳定（纯读取，无副作用）', () => {
    expect(getCrewStatus()).toEqual(getCrewStatus());
  });
});

/* ------------------------------------------------------------- stopCrewService */

describe('stopCrewService', () => {
  it('从未启动时调用不抛错，状态收敛为 stopped 且 pid 清空', async () => {
    await expect(stopCrewService()).resolves.toBeUndefined();
    const snap = getCrewStatus();
    expect(snap.status).toBe('stopped');
    expect(snap.pid).toBeNull();
  });

  it('连续调用两次幂等（可重复进入退出流程）', async () => {
    await expect(stopCrewService()).resolves.toBeUndefined();
    await expect(stopCrewService()).resolves.toBeUndefined();
    expect(getCrewStatus().status).toBe('stopped');
  });

  it('接受自定义超时参数且不抛错（shutdown 不被拖住的兜底）', async () => {
    await expect(stopCrewService(1)).resolves.toBeUndefined();
    await expect(stopCrewService(0)).resolves.toBeUndefined();
  });

  it('stop 之后再 stop 仍是 undefined（返回值稳定，方便 await）', async () => {
    const first = await stopCrewService();
    const second = await stopCrewService();
    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
  });
});

/* ------------------------------------------------------------ startCrewService */
/**
 * 注意：本 describe 只用「必然失败」的路径 —— 要么解释器不存在，要么入口不存在，
 * 两者都在 spawn() 之前就 return，因此不会产生任何真实 python / uvicorn 子进程。
 */
describe('startCrewService（只覆盖失败降级路径，禁止真拉 python）', () => {
  it('pythonExe 不存在：ok:false / status:failed / 无子进程残留', async () => {
    const lines = [];
    const res = await startCrewService({
      pythonExe: 'definitely/not/here/python-xyz',
      crewDir: fakeServiceDir,
      nodeToolUrl: 'http://127.0.0.1:4100',
      notify: (line) => lines.push(line),
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe('failed');
    expect(res.port).toBeNull();
    expect(res.url).toBeNull();
    expect(res.pid).toBeNull();
    expect(res.error).toContain(path.resolve(PACKAGE_ROOT, 'definitely/not/here/python-xyz'));

    // 用户可读的一行告警，且只告警一次
    expect(lines).toHaveLength(1);
    expect(String(lines[0])).toContain('未启动');

    // 没有 spawn 过任何东西：状态失败、pid 为空
    const snap = getCrewStatus();
    expect(snap.status).toBe('failed');
    expect(snap.pid).toBeNull();
    expect(snap.error).toContain('未找到 Python 解释器');
  });

  it('main.py 不存在：ok:false 且错误里含入口的绝对路径', async () => {
    const res = await startCrewService({
      pythonExe: FAKE_PYTHON_EXE,
      crewDir: emptyDir,
      notify: () => {},
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe('failed');
    expect(res.port).toBeNull();
    expect(res.url).toBeNull();
    expect(res.pid).toBeNull();
    expect(res.error).toContain(path.join(emptyDir, 'main.py'));
    expect(getCrewStatus().pid).toBeNull();
  });

  it('失败以 resolve 返回而不是 reject（聊天功能不该被 python 环境卡死）', async () => {
    await expect(
      startCrewService({ pythonExe: 'missing/python', crewDir: fakeServiceDir, notify: () => {} }),
    ).resolves.toMatchObject({ ok: false, status: 'failed' });
  });

  it('并发第二次调用被拦下，不会重复 spawn（state=starting 闸门生效）', async () => {
    const base = { crewDir: fakeServiceDir, notify: () => {} };
    const first = startCrewService({ ...base, pythonExe: 'missing/one' });
    // 第二次调用与第一次在同一个 tick 内发起：state 已被置为 starting
    const second = startCrewService({ ...base, pythonExe: 'missing/two' });

    const [r1, r2] = await Promise.all([first, second]);

    expect(r1.ok).toBe(false);
    expect(r1.status).toBe('failed');
    expect(r2.ok).toBe(false);
    expect(r2.status).toBe('starting'); // 走到的是「已在启动中」的短路分支
    expect(r2.pid).toBeNull();
    expect(r2.port).toBeNull();
  });

  it('失败后不卡死：状态回到 failed 后可以再次发起启动', async () => {
    const res = await startCrewService({
      pythonExe: 'missing/again',
      crewDir: fakeServiceDir,
      notify: () => {},
    });
    expect(res.status).toBe('failed');
    // 再发一次仍应是「真的又跑了一遍解析」，而不是被 starting / ready 短路
    const again = await startCrewService({
      pythonExe: 'missing/again',
      crewDir: fakeServiceDir,
      notify: () => {},
    });
    expect(again.status).toBe('failed');
    expect(again.error).toContain(path.resolve(PACKAGE_ROOT, 'missing/again'));
  });

  it('notify 缺省时走默认输出通道且不抛异常', async () => {
    // 用一个必然失败的路径，保证不会真 spawn；只验证默认 notify=console.log 不炸
    const spy = [];
    const original = console.log;
    console.log = (line) => spy.push(line);
    try {
      const res = await startCrewService({
        pythonExe: 'missing/default-notify',
        crewDir: fakeServiceDir,
      });
      expect(res.ok).toBe(false);
    } finally {
      console.log = original;
    }
    expect(spy.length).toBeGreaterThanOrEqual(1);
  });
});

/* ------------------------------------ startCrewService 就绪路径（真子进程） */

/**
 * 上面两个 describe 刻意一个子进程都不起，于是 spawn → 管道消费 → 探活 → ready → kill
 * 这条**本轮修复的主链路**在单测里是零覆盖（只有集成脚本 test/crew-live.mjs 会跑它）。
 * 这里把它补上：解释器用本项目 venv 里的 python，入口换成临时目录下的
 * **最小裸 ASGI 应用** —— 不 import fastapi / crewai，启动不到 1 秒，
 * 既能真正走到 spawn/kill，又不会把单测拖成慢速集成测试。
 *
 * venv 不存在时整块跳过（skipIf），用例在没装 python 环境的机器上依然可用。
 */
const REAL_PYTHON = path.resolve(PACKAGE_ROOT, DEFAULT_PYTHON_EXE);
const hasRealPython = existsSync(REAL_PYTHON);

/** 最小可用的裸 ASGI 应用：uvicorn 不需要 fastapi 也能跑它 */
const fakeAsgiApp = (body) => `# 裸 ASGI，故意不依赖 fastapi / crewai
import sys

print("fake-asgi-boot", file=sys.stderr)  # 覆盖 stderr 管道的消费路径

_BODY = b'${body}'


async def app(scope, receive, send):
    if scope["type"] != "http":
        return
    await send({
        "type": "http.response.start",
        "status": 200,
        "headers": [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(_BODY)).encode()),
        ],
    })
    await send({"type": "http.response.body", "body": _BODY})
`;

/** 进程存活判定：signal 0 只做权限/存在性检查，不会真的发信号 */
function alivePid(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 轮询等待某个条件成立，返回它的真值（用于等 spawn 出来的 pid 落到状态里） */
async function waitFor(cond, timeoutMs = 8000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = cond();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`waitFor 超时（${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

describe.skipIf(!hasRealPython)('startCrewService（真起子进程，最小 ASGI 假服务）', () => {
  /** 正常就绪的入口目录 */
  let okDir;
  /** 返回 {"ok":false} 的入口目录 —— 端口通但永远不就绪，走超时分支 */
  let neverReadyDir;
  /** import 即抛异常的入口目录 —— 进程提前退出 */
  let crashDir;
  let cleanups = [];

  beforeAll(async () => {
    const write = async (prefix, content) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
      await fs.writeFile(path.join(dir, 'main.py'), content);
      cleanups.push(dir);
      return dir;
    };
    okDir = await write('crew-unit-ok-', fakeAsgiApp('{"ok": true}'));
    neverReadyDir = await write('crew-unit-slow-', fakeAsgiApp('{"ok": false}'));
    // 先灌 60 行 stderr 再抛：uvicorn 的启动日志本来就有这个量级，
    // 顺带把「日志环形缓冲只留尾部」这条分支跑到
    crashDir = await write(
      'crew-unit-crash-',
      [
        'import sys',
        'for i in range(60):',
        '    print("filler-%02d" % i, file=sys.stderr)',
        'raise RuntimeError("boom-on-import")',
        '',
      ].join('\n'),
    );
  });

  afterAll(async () => {
    await stopCrewService(); // 用例失败时也不留活着的子进程
    for (const dir of cleanups) await fs.rm(dir, { recursive: true, force: true });
  });

  // 下面这几个 it 共享同一个子进程生命周期，必须按声明顺序串行执行：
  // 起 → 复用 → 关 → 异常收尾。vitest 同一文件内的 it 默认顺序执行，别改成 concurrent。
  it('拉起真子进程：探活通过、状态 ready、pid 存活、端口被占', async () => {
    const lines = [];
    const res = await startCrewService({
      pythonExe: REAL_PYTHON,
      crewDir: okDir,
      nodeToolUrl: 'http://127.0.0.1:4321',
      notify: (line) => lines.push(String(line)),
    });

    expect(res.ok).toBe(true);
    expect(res.status).toBe('ready');
    expect(res.error).toBeFalsy(); // 就绪分支不带 error 字段
    expect(res.port).toBeGreaterThan(0);
    expect(res.url).toBe(`http://127.0.0.1:${res.port}`);
    expect(res.pid).toBeGreaterThan(0);

    // 就绪行只发一次，且带上 url 与 pid（测试与排障共用的抓手）
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('已就绪');
    expect(lines[0]).toContain(res.url);

    // 独立探活：不是在信 startCrewService 自己的返回值
    expect(await probeHealth(res.url)).toBe(true);
    expect(alivePid(res.pid)).toBe(true);

    // 状态快照与返回值一致
    expect(getCrewStatus()).toMatchObject({
      status: 'ready',
      port: res.port,
      url: res.url,
      pid: res.pid,
      error: null,
    });

    // 端口真的被子进程占着：此刻再 listen 应当 EADDRINUSE
    await expect(listenOn(res.port)).rejects.toThrow();
  });

  it('已就绪时再次调用被短路，不会另起一个进程', async () => {
    const before = getCrewStatus();
    const res = await startCrewService({
      pythonExe: '不该被用到/invalid',
      crewDir: okDir,
      notify: () => {},
    });

    expect(res.ok).toBe(true);
    expect(res.status).toBe('ready');
    expect(res.pid).toBe(before.pid);
    expect(getCrewStatus().pid).toBe(before.pid);
  });

  it('stopCrewService 杀掉子进程并释放端口，且可重复调用', async () => {
    const { pid, port } = getCrewStatus();
    expect(typeof pid).toBe('number');

    await stopCrewService();

    expect(alivePid(pid)).toBe(false);
    expect(getCrewStatus()).toMatchObject({ status: 'stopped', pid: null });
    // 端口能重新 listen，说明确实放开了
    expect(await portReleased(port)).toBe(true);
    // 幂等：已经没有子进程了，再关一次不抛错
    await expect(stopCrewService()).resolves.toBeUndefined();
  });

  it('入口 import 就崩：识别为「进程提前退出」并带上 stderr 尾部，不去傻等超时', async () => {
    const lines = [];
    const startedAt = Date.now();
    const res = await startCrewService({
      pythonExe: REAL_PYTHON,
      crewDir: crashDir,
      readyTimeoutMs: 20000, // 故意给足超时：能在 1s 内返回才说明走的是提前退出分支
      notify: (line) => lines.push(String(line)),
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe('failed');
    expect(res.error).toContain('Python 进程提前退出');
    // stderr 尾部被收集进了错误详情（traceback 里的关键字）
    expect(res.error).toContain('boom-on-import');
    expect(Date.now() - startedAt).toBeLessThan(15000);
    // 降级退出后不留 pid
    expect(res.pid).toBeNull();
    expect(getCrewStatus().pid).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('未启动');
  });

  it('启动途中被打断（等同用户 Ctrl+C）：不报就绪、不留孤儿进程', async () => {
    const pending = startCrewService({
      pythonExe: REAL_PYTHON,
      crewDir: neverReadyDir,
      readyTimeoutMs: 20000, // 给足超时，确保是「被打断」而不是「自己超时」
      notify: () => {},
    });

    // 等 spawn 出来的 pid 落到状态里，再在探活循环途中打断它
    const pid = await waitFor(() => getCrewStatus().pid);
    await stopCrewService();

    const res = await pending;
    expect(res.ok).toBe(false);
    expect(res.status).toBe('stopped');
    // 关键：停止后不许再把状态翻回 ready / 发成功回执
    expect(getCrewStatus()).toMatchObject({ status: 'stopped', pid: null });
    // 本轮修复的核心验收项：打断之后没有留下活着的子进程
    await waitFor(() => !alivePid(pid));
    expect(alivePid(pid)).toBe(false);
  });

  it('端口通但 /health 一直 ok:false：就绪超时后收尸并降级', async () => {
    const lines = [];
    const res = await startCrewService({
      pythonExe: REAL_PYTHON,
      crewDir: neverReadyDir,
      readyTimeoutMs: 1200,
      notify: (line) => lines.push(String(line)),
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe('failed');
    expect(res.error).toContain('就绪超时');
    // 超时不能留一个活着的半成品
    expect(res.pid).toBeNull();
    expect(getCrewStatus()).toMatchObject({ status: 'failed', pid: null });
    expect(lines).toHaveLength(1);
  });
});
