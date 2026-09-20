/**
 * 真集成验证：Node 能否在**任意目录**拉起 Python（uvicorn）并干净关闭。
 *
 * 这是本次修复的核心场景 —— 先把 cwd 切到系统临时目录（模拟「在别的项目目录敲 front」），
 * 再走完整的「起工具服务 → 起 uvicorn → 探活 → 关闭」链路，最后断言不残留子进程。
 *
 * 用法：node test/crew-live.mjs     （需要 python-fastapi/.venv 已就绪）
 */
import os from 'node:os';
import process from 'node:process';
import { startToolServer } from '../src/server/toolServer.js';
import {
  PACKAGE_ROOT,
  getCrewStatus,
  resolveCrewPaths,
  startCrewService,
  stopCrewService,
} from '../src/server/crewService.js';
import { alive, createChecker, portFree } from './helpers.mjs';

const { ok, failed } = createChecker();

console.log('=========== 跨目录拉起 Python 编排服务 ===========');
process.chdir(os.tmpdir());
console.log(`（已把 cwd 切到 ${process.cwd()}，模拟在别的项目目录执行 front）`);

// 工具服务必须关掉再退：留着未关的 server 直接 process.exit 会在 Windows 上触发 libuv 断言。
// 整段包 try/finally —— 中途任何一步抛异常也要把已经拉起的服务和子进程收拾干净
let closeToolServer = async () => {};
try {
  // 1) 路径解析基准是包根，不是 cwd
  ok('包根指向仓库目录', PACKAGE_ROOT.endsWith('project'), PACKAGE_ROOT);
  const paths = await resolveCrewPaths({});
  ok('在非包根目录下仍能解析出解释器', paths.ok, paths.ok ? paths.pythonExe : paths.error);

  // 2) 起 Node 工具服务（Python 要靠它的地址回调工具）
  const server = await startToolServer(0);
  closeToolServer = server.close;
  const toolPort = server.port;
  ok('工具服务已启动', typeof toolPort === 'number' && toolPort > 0, `port ${toolPort}`);

  // 3) 拉起 Python
  const started = await startCrewService({
    nodeToolUrl: `http://127.0.0.1:${toolPort}`,
    notify: (line) => console.log(`   [服务] ${line}`),
  });
  ok('Python 服务就绪', started.ok, started.error || `${started.url} pid ${started.pid}`);

  if (started.ok) {
    // 一律带超时：不加的话服务假死时脚本会一直挂在这儿，看不出是「没起来」还是「不给响应」
    const health = await fetch(`${started.url}/health`, { signal: AbortSignal.timeout(15000) })
      .then((r) => r.json()).catch((e) => ({ err: e.message }));
    ok('/health 返回 ok:true', health.ok === true, JSON.stringify(health));
    ok('NODE_TOOL_URL 已传给 Python', health.nodeToolUrl === `http://127.0.0.1:${toolPort}`, health.nodeToolUrl);

    // 这两条断言验的是「链路通不通」，不是延迟指标：/tools 会级联一次
    // Python → Node 工具服务的清单请求，机器负载高时几秒到几十秒都属正常，
    // 超时给紧会把「链路其实是通的」误报成失败。失败时把 Python 的原话带出来
    // （502 正文里就是连不上的具体原因），吞掉它只剩一句 “undefined 个”没法排查
    const toolsRes = await fetch(`${started.url}/tools?role=designer`, { signal: AbortSignal.timeout(30000) })
      .catch((e) => ({ status: 0, json: async () => ({ error: e.message }) }));
    const tools = await toolsRes.json().catch(() => null);
    ok('能取到工具清单（Node↔Python 链路通）', Array.isArray(tools?.tools) && tools.tools.length > 0,
      `${tools?.tools?.length} 个；HTTP ${toolsRes.status} ${JSON.stringify(tools)?.slice(0, 300)}`);

    ok('状态快照为 ready', getCrewStatus().status === 'ready', getCrewStatus().status);
    ok('pid 存活', alive(started.pid), `pid ${started.pid}`);

    // 4) 关闭并断言无残留（验收标准 3）
    await stopCrewService();
    ok('关闭后 pid 已不存在', !alive(started.pid), `pid ${started.pid}`);
    ok('关闭后端口已释放', await portFree(started.port), `port ${started.port}`);
    await stopCrewService(); // 幂等
    ok('重复关闭不抛错', true);
  }
} finally {
  await closeToolServer();
}

console.log(failed() === 0 ? '🎉 全部通过' : `❌ ${failed()} 项失败`);
process.exit(failed() === 0 ? 0 : 1);
