import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTools, invokeTool, getToolManifests, closeTools } from '../src/tools/manager.js';
import { readContext } from '../src/utils/chat/context.js';

// 夹具路径一律由 import.meta.url 推导，不从 cwd 取：本项目的主场景就是在任意目录启动 front，
// 测试不该反过来依赖「必须站在仓库根目录跑」
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// select/confirm 这类交互工具在真终端下会开 readline 等用户输入（上限 29 分钟），
// 回归脚本必须显式走非交互分支 —— 否则在开发机的真终端上跑会直接挂住不返回
process.stdin.isTTY = false;

let fail = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' -> ' + extra : ''}`);
};

// 整体包 try/finally：getTools() 会拉起 MCP 的 stdio 子进程，中途抛异常直接退会留下孤儿
try {
  console.log('=========== 回归：原有 LangChain/TUI 路径 ===========');
  const tools = await getTools();
  const byName = (n) => tools.find((t) => t.name === n);

  // 字符串返回型工具：应拿到纯字符串（不是对象、不是 JSON 串）
  const pkgJson = path.join(ROOT, 'package.json');
  const rf = await byName('read_file').invoke({ filePath: pkgJson });
  ok('read_file 经 LangChain 返回字符串', typeof rf === 'string' && rf.includes('"express"'), `长度 ${rf.length}`);

  // 对象返回型工具（select 改成了 {ok,text,data}）：LangChain 侧必须只拿到 text
  const sel = await byName('select').invoke({ question: '测试', options: ['A', 'B'] });
  ok('select 经 LangChain 只返回 text（无 JSON 泄漏）', typeof sel === 'string' && !sel.includes('"ok"'), sel.slice(0, 46));

  // 数组返回型（glob）
  const gl = await byName('glob').invoke({ pattern: 'src/tools/*.js', dir: ROOT });
  ok('glob 经 LangChain 返回可读结果', typeof gl === 'string' && gl.includes('manager.js'), `长度 ${gl.length}`);

  console.log('\n=========== 回归：是否破坏原有调用方 ===========');
  // app.js 用 readContext() 无参调用，必须仍是全文且不含标记
  const appCtx = await readContext();
  ok('readContext() 无参 = 全文', appCtx.includes('write_file工具使用规范'), `${appCtx.length} 字符`);
  ok('readContext() 无参不含 role 标记', !/<!--/.test(appCtx));
  ok('readContext() 无参保留了占位符替换', !appCtx.includes('${systemInfo}') && !appCtx.includes('${workPath}'));

  console.log('\n=========== 契约：结构化返回与角色裁剪 ===========');
  const r = await invokeTool('select', { question: '测试', options: ['A', 'B'] });
  ok('invokeTool 返回 {ok,text,data}', 'ok' in r && 'text' in r && 'data' in r, JSON.stringify(r).slice(0, 70));
  ok('非交互终端下 ok=false', r.ok === false);

  const r2 = await invokeTool('read_file', { filePath: 'not-absolute' });
  ok('校验失败 ok=false 且报错可读', r2.ok === false && r2.text.includes('只能传绝对路径') && !r2.text.includes('"code"'), r2.text.slice(0, 60));

  const r3 = await invokeTool('read_file', { filePath: pkgJson });
  ok('成功时 ok=true', r3.ok === true);

  const eng = await getToolManifests('engineer');
  const des = await getToolManifests('designer');
  // 工具清单的取用一律带可选链：没配 MCP 时 loadMcpTools() 会降级成空数组，
  // 缺工具应当表现为「断言失败」，而不是抛 TypeError 把整个回归脚本带崩
  ok('engineer 工具集 = 13', eng.length === 13, eng.map((t) => t.name).join(','));
  ok('engineer 拿得到 generate_image（补素材要用）', eng.some((t) => t.name === 'generate_image'));
  ok(
    'generate_image 的 kind 只在 engineer 侧要求可选',
    eng.find((t) => t.name === 'generate_image')?.parameters?.properties?.kind?.enum?.join() === 'asset,design',
  );
  ok('designer 工具集 = 4', des.length === 4, des.map((t) => t.name).join(','));
  ok('designer 拿不到文件读写工具', !des.some((t) => ['write_file', 'read_file', 'edit_file', 'Bash'].includes(t.name)));
  ok('engineer 拿得到 6 个确认点所需的 confirm/select', ['confirm', 'select'].every((n) => eng.some((t) => t.name === n)));
  ok('MCP 工具 schema 是合法 JSON Schema', eng.find((t) => t.name === 'navigate_page')?.parameters?.properties !== undefined);
  ok('本地工具 schema 已剔除 $schema', eng.find((t) => t.name === 'read_file')?.parameters?.$schema === undefined);

  const desCtx = await readContext('designer');
  ok('designer 上下文已裁掉文件类规范', !desCtx.includes('write_file工具使用规范') && !desCtx.includes('关于记忆'), `${desCtx.length} 字符`);
  ok('designer 上下文保留了设计规范', desCtx.includes('generate_image工具使用规范'));

  const sizeOf = (list) => list.reduce((s, t) => s + JSON.stringify(t).length, 0);
  const chars = sizeOf(eng);
  console.log(`\n=========== 体积 ===========\nengineer 工具定义 ${chars} 字符 ≈ ${Math.round(chars / 2)} tokens`);
  console.log(`designer 工具定义 ${sizeOf(des)} 字符 ≈ ${Math.round(sizeOf(des) / 2)} tokens`);
} finally {
  // 关掉 MCP 连接再退：否则 npx / chrome 这些 stdio 子进程会变成孤儿留在机器上
  await closeTools().catch(() => {});
}

console.log(fail === 0 ? '\n🎉 全部通过' : `\n💥 ${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
