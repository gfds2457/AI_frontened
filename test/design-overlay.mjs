/**
 * 无头验证 `#` 图片浮层：用假 stdin（isTTY=true）驱动真实的输入控制器，
 * 断言 DESIGN 浮层只画「图片清单」、不再解码图片做终端预览，且选中后能正常插入引用。
 *
 * 为什么要有这个脚本：浮层的预览是异步渲染的（解码 → 缩放 → 逐格上色），
 * 删掉它时改动了列表行数记账与 dpreview 状态，一旦有残留就会在真实终端里表现为
 * 浮层错行 / 卡住。这段逻辑没有其它自动化覆盖，且必须真终端才能人工复现，
 * 所以在这里用假 stdin 覆盖。
 *
 * 用法：node test/design-overlay.mjs
 */
import { PassThrough } from 'node:stream';
import path from 'node:path';

let fail = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' -> ' + extra : ''}`);
};

// ---- 假 stdin：start() 要求 isTTY，且要能 setRawMode ----
const fake = new PassThrough();
fake.isTTY = true;
fake.setRawMode = () => {};
Object.defineProperty(process, 'stdin', { value: fake, configurable: true });

// ---- 截获 stdout：渲染器整块重绘，只留最后一次，便于断言 ----
const chunks = [];
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (s, ...rest) => {
  const str = String(s);
  // 只收渲染器的整块重绘（一律以「隐藏光标」开头），别把本脚本自己的 console.log 也算进去
  if (str.startsWith('\x1b[?25l')) chunks.push(str);
  return realWrite(s, ...rest);
};
// 渲染器每次重绘都以「隐藏光标」开头、以「显示光标」结尾，据此切出一帧
const lastFrameRaw = () => chunks.join('').split('\x1b[?25l').pop();
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const lastFrame = () => stripAnsi(lastFrameRaw());
// 只取浮层那几行（redraw 的第一行恒为输入行）：输入行里的路径 token 带 PATH_CHIP 的真彩色，
// 跟「浮层有没有画图」无关，混在一起判定会误报
const overlayOnlyRaw = () => lastFrameRaw().split('\n').slice(1).join('\n');

const { createInput } = await import('../src/tui/input.js');
const { listDesignImages } = await import('../src/utils/input/image.js');

const input = createInput();
input.start({
  onCommand: () => {},
  onMessage: () => {},
  onExit: () => {},
});

const KEY = { down: { name: 'down' }, enter: { name: 'return' } };
/** 直接抛 keypress 事件：绕过 readline 的字节解析，只测控制器的状态机 */
const press = async (str, key = {}) => {
  fake.emit('keypress', str, key);
  await new Promise((r) => setTimeout(r, 60)); // 触发键有 30ms 延迟确认
};

console.log('=========== `#` 浮层 ===========');
const images = listDesignImages();
ok('design 目录下有可选图片', images.length > 0, `${images.length} 张`);
if (!images.length) {
  // 前置条件不成立就别往下走：images[0] 是 undefined，path.basename 会抛
  // ERR_INVALID_ARG_TYPE，整个脚本崩掉反而看不到上面这行可读的失败原因
  input.stop();
  process.stdout.write = realWrite;
  console.log('\n💥 前置条件不成立：.front/design 下没有图片，浮层无从验证');
  process.exit(1);
}
const first = images[0];

await press('#');
const frame = lastFrame();
ok('输入 # 后进入浮层（显示清单标题）', frame.includes('.front/design 图片'), frame.split('\n')[0]?.trim());
ok('浮层列出了图片名', frame.includes(path.basename(first)), first);
ok(
  '浮层不再画图片（无 24 位真彩色半块字符）',
  // 前后景两种真彩色都要覆盖：半块字符是拿背景色画下半格的，只认 \x1b[3x;2 会漏掉它
  !/\x1b\[[34]8;2;\d+;\d+;\d+m/.test(overlayOnlyRaw()) && !frame.includes('▀'),
);
ok('浮层不残留预览缓存状态（无预览行）', !frame.includes('undefined'));

// 上下键移动 + 过滤词，确认列表逻辑仍然自洽
await press('', KEY.down);
await press('', KEY.down);
ok('↓ 键后列表仍正常渲染', lastFrame().includes('.front/design 图片'));
await press('a');
ok('过滤词只缩列表、不破坏浮层', lastFrame().includes('.front/design 图片'));

console.log('\n=========== 选中与取消 ===========');
await press('', KEY.enter);
const picked = lastFrame();
ok('回车插入 #.front/design/<路径> 引用', picked.includes('#.front/design/'), picked.match(/#\.front\/design\/\S*/)?.[0]);

await press('#');
ok('可再次进入浮层（状态已干净重置）', lastFrame().includes('.front/design 图片'));
await press('', { name: 'escape' });
ok('Esc 取消后回到普通输入行', !lastFrame().includes('.front/design 图片'));

input.stop();
process.stdout.write = realWrite;
console.log(fail === 0 ? '\n🎉 全部通过' : `\n💥 ${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
