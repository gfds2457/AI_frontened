/**
 * 本地工具 HTTP 服务 —— 供 Python 侧的 CrewAI 调用。
 *
 * 为什么由 Node 起这个服务：confirm/select 直接读 stdin、generate_image 会往终端打进度，
 * Python 进程拿不到用户的终端。让 Node 保留终端所有权、Python 通过 HTTP 回调这里执行
 * 工具，这几类交互工具就能零改动复用。
 *
 * 只监听 127.0.0.1，端口由系统分配，避免和用户其它本地服务撞车。
 */
import path from 'node:path';
import express from 'express';
import chalk from 'chalk';
import { getToolManifests, invokeTool, ROLE_TOOLS } from '../tools/manager.js';
import { getRoleContext } from '../utils/chat/context.js';
import { describeDesign } from '../utils/image/describe.js';

/** 把 handler 里的异常统一转成 500 JSON，避免 express 默认的 HTML 错误页 */
const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    res.status(500).json({ ok: false, text: `工具服务内部错误: ${err.message}`, data: null });
  });

/**
 * 在指定工作目录下执行：临时切过去、执行完切回来。crew 的工具调用是串行的，
 * 此时 TUI 又处于 busy 状态，不存在并发竞争。
 *
 * ⚠️ 覆盖范围有限，别当成「给另一个项目目录跑 crew」的完整方案：
 *   1. 目前只有 /design/describe 会带 cwd；/tool/invoke 的 cwd 传不传由 Python 侧决定
 *      （node_tools.py 的 NodeTool._run 只发 {name, args}）；
 *   2. process.chdir 改不了模块加载时就冻住的相对路径 —— 出图目录、角色上下文里
 *      `BASE = process.cwd()` 这类常量仍指向 front 启动时所在的项目。
 * 要让 crew 真正为别的项目干活，得把这些目录改成显式传参（见 需求规划.md 的多项目支持）。
 */
async function runInCwd(cwd, fn) {
  const prev = process.cwd();
  if (!cwd || path.resolve(cwd) === prev) return fn();
  process.chdir(cwd);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
  }
}

export function createToolApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (req, res) => res.json({ ok: true, roles: Object.keys(ROLE_TOOLS) }));

  // 工具清单：Python 侧据此动态生成 CrewAI Tool（含 interactive / timeout 元信息）
  app.get(
    '/tools',
    wrap(async (req, res) => res.json(await getToolManifests(req.query.for))),
  );

  // 按角色取上下文（systemDoc.md 已按 <!-- role:xxx --> 标记裁剪）
  app.get(
    '/context',
    wrap(async (req, res) => res.json({ context: await getRoleContext(req.query.for || 'engineer') })),
  );

  // 工具调用。interactive 工具会一直阻塞到用户作答，超时在 manager 里单独放宽
  app.post(
    '/tool/invoke',
    wrap(async (req, res) => {
      const { name, args = {}, cwd } = req.body || {};
      if (!name) return res.status(400).json({ ok: false, text: '缺少 name', data: null });
      return res.json(await runInCwd(cwd, () => invokeTool(name, args)));
    }),
  );

  /**
   * 让视觉模型读一张设计图，返回结构化文字说明。
   *
   * 为什么要这个端点：crew 里的 agent 看不到图（工具结果只能是字符串），
   * 设计图必须由 Node 先转成文字再注入任务，否则前端工程师只能凭想象还原。
   * 见 utils/image/describe.js 的说明。
   */
  app.post(
    '/design/describe',
    wrap(async (req, res) => {
      const { path: p, cwd } = req.body || {};
      if (!p) return res.status(400).json({ ok: false, text: '缺少 path', data: null });
      try {
        const text = await runInCwd(cwd, () => describeDesign(p));
        return res.json({ ok: true, text, data: { path: p } });
      } catch (err) {
        // 用 200 + ok:false 返回：这是「这一步没成」，不是服务出错，
        // Python 侧要能拿到可读原因继续走降级逻辑
        return res.json({ ok: false, text: `生成设计说明失败: ${err.message}`, data: null });
      }
    }),
  );

  return app;
}

/**
 * 启动工具服务。
 * @param {number} [port] 监听端口，缺省 0 由系统分配（正常运行时用，避免撞车）
 * @returns {Promise<{port:number, close:()=>Promise<void>}>}
 */
export async function startToolServer(port = 0) {
  const app = createToolApp();
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => {
      // 关掉 Node 默认的请求/头部超时（各 5 分钟）：confirm 可能让用户思考很久，
      // 被默认超时掐断的话用户会看到「工具执行失败」却不知道为什么
      server.requestTimeout = 0;
      server.headersTimeout = 0;
      const { port } = server.address();
      console.log(chalk.gray(`✓ 工具服务已启动 http://127.0.0.1:${port}`));
      resolve({ port, close: () => new Promise((r) => server.close(r)) });
    });
    server.on('error', reject);
  });
}
