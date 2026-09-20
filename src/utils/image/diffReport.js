/**
 * 把 imugi_compare 的结果整理成「模型能用的文本」。
 *
 * ## 为什么必须有这个文件
 *
 * imugi_compare 是 MCP 工具，它返回的是**两个内容块**：
 *   [{type:'text',  text:'{"ssim":0.86,...}'},
 *    {type:'image_url', image_url:{url:'data:image/png;base64,iVBOR...'}}]
 * 即一张差异热力图。而 crew 这一侧的链路只能把**字符串**交给大模型
 * （Node 的 /tool/invoke 返回 text，Python 的 NodeTool._run 也返回 str），
 * 于是那张图的 base64 会被当成正文灌进模型上下文：
 *
 *   实测 1440x900：base64 12918 字符 ≈ 4037 tokens，整条 text ≈ 4115 tokens。
 *
 * 模型无法解码 base64，这 4000+ tokens 换来的信息量是 **0**；而任务里
 * 「改→截→比」最多跑 3 轮，光这一项就能吃掉约 12000 tokens —— 已经把
 * 单次请求 16000 的预算顶穿，且全是浪费。
 *
 * ## 做法：把「图」换成「话」
 *
 * 1. 热力图的 base64 一律不进 text（manager.js 的 normalize 负责）；
 * 2. 差异信息改由本文件自己算：把设计稿与截图都降采样成网格，逐格求平均像素差，
 *    输出差异最大的若干区域（带网格行列、方位词、原图像素范围）。
 *    不解析 imugi 的热力图配色 —— 那种隐式约定易随版本变，自己算更稳，
 *    而且这里的度量是「差异百分比」，本身就可读、可比较。
 * 3. 顺带保留 imugi 给的 SSIM 原始分数（那是它的强项，不必重算）。
 *
 * 代价：一次对比从 4000+ tokens 降到几百 tokens，且模型真的能据此定位问题。
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

/** 网格划分：8 列 x 5 行。够定位到「哪一块」，又不至于碎到读不下去 */
const GRID_X = 8;
const GRID_Y = 5;
/** 每格内部再放大这么多倍做降采样，避免「格内差异被平均掉」 */
const SUB = 8;
/** 默认只报最差的几个区域，报太多模型会抓不住重点 */
const TOP_N = 6;

const POS_COL = ['左', '中', '右'];
const POS_ROW = ['上', '中', '下'];

/** 网格坐标 -> 方位词（左上 / 正中 / 右下 …） */
function positionWord(cx, cy) {
  const c = POS_COL[Math.min(2, Math.floor((cx * 3) / GRID_X))];
  const r = POS_ROW[Math.min(2, Math.floor((cy * 3) / GRID_Y))];
  return c === '中' && r === '中' ? '正中' : `${r}${c}`;
}

/**
 * 把「最差的若干格」合并成连通区域。
 *
 * 不合并的话报告会退化：整条页头都不一样时，前 6 名全是同一行相邻的格子、
 * 差异值还完全相同，读起来像 6 个独立问题，实际是 1 个。合并后输出的是
 * 「第 1 行第 3-8 列（上中-右上，x 360-1440px，y 0-180px）：平均差异 6.3%」，
 * 这才是模型能照着改的东西。
 */
function mergeRegions(cells, topN) {
  const sorted = [...cells].sort((p, q) => q.diff - p.diff);
  // 取前若干格当种子。多取一些（2 倍）是为了让同一片区域能被连起来
  const seeds = new Set(
    sorted.slice(0, Math.max(topN * 2, 10)).map((c) => `${c.cx},${c.cy}`),
  );
  const byKey = new Map(cells.map((c) => [`${c.cx},${c.cy}`, c]));
  const seen = new Set();
  const regions = [];

  for (const key of seeds) {
    if (seen.has(key)) continue;
    // 四邻连通，广度优先把同一片区域吃干净
    const stack = [key];
    const group = [];
    seen.add(key);
    while (stack.length) {
      const [cx, cy] = stack.pop().split(',').map(Number);
      group.push(byKey.get(`${cx},${cy}`));
      for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
        const nk = `${nx},${ny}`;
        if (seeds.has(nk) && !seen.has(nk)) {
          seen.add(nk);
          stack.push(nk);
        }
      }
    }
    const mean = group.reduce((s, c) => s + c.diff, 0) / group.length;
    regions.push({
      mean,
      count: group.length,
      x0: Math.min(...group.map((c) => c.cx)),
      x1: Math.max(...group.map((c) => c.cx)),
      y0: Math.min(...group.map((c) => c.cy)),
      y1: Math.max(...group.map((c) => c.cy)),
    });
  }
  return regions.sort((a, b) => b.mean - a.mean).slice(0, topN);
}

/** 读一张图，统一成 3 通道 + 指定尺寸的原始像素 */
async function pixels(file, w, h) {
  return sharp(file)
    .removeAlpha()
    .toColourspace('srgb')
    .resize(w, h, { fit: 'fill', kernel: 'cubic' })
    .raw()
    .toBuffer();
}

/**
 * 逐格像素差。两张图尺寸可能不同（设计稿 1200x800 vs 截图 1440x900），
 * 所以先把截图拉到设计稿的尺寸再一起降采样 —— 直接各自降采样会让网格对不齐。
 * @returns {{W:number,H:number,overall:number,cells:{cx:number,cy:number,diff:number}[]}}
 */
async function gridDiff(designPath, screenshotPath) {
  const meta = await sharp(designPath).metadata();
  const W = meta.width;
  const H = meta.height;
  if (!W || !H) throw new Error('设计稿没有读到尺寸');

  const gw = GRID_X * SUB;
  const gh = GRID_Y * SUB;
  const [a, b] = await Promise.all([
    pixels(designPath, gw, gh),
    pixels(screenshotPath, gw, gh),
  ]);

  // 每格：把 SUB x SUB 的子块求平均，避免格内差异被降采样平均掉
  const cells = [];
  let sum = 0;
  let count = 0;
  for (let cy = 0; cy < GRID_Y; cy += 1) {
    for (let cx = 0; cx < GRID_X; cx += 1) {
      let acc = 0;
      let n = 0;
      for (let sy = 0; sy < SUB; sy += 1) {
        for (let sx = 0; sx < SUB; sx += 1) {
          const px = cx * SUB + sx;
          const py = cy * SUB + sy;
          const i = (py * gw + px) * 3;
          acc += (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
          n += 1;
        }
      }
      const diff = acc / n / 255; // 0~1
      sum += diff;
      count += 1;
      cells.push({ cx, cy, diff });
    }
  }
  return { W, H, overall: sum / count, cells };
}

/**
 * 区域的像素范围。网格是闭区间（第 cx0~cx1 列），所以右/下边界要按
 * 「最后一格的右边缘」算，即 (cx1 + 1)，否则会少报一格。
 */
function pixelRange(x0, x1, y0, y1, W, H) {
  const px0 = Math.round((x0 * W) / GRID_X);
  const px1 = Math.round(((x1 + 1) * W) / GRID_X);
  const py0 = Math.round((y0 * H) / GRID_Y);
  const py1 = Math.round(((y1 + 1) * H) / GRID_Y);
  return `x ${px0}-${px1}px，y ${py0}-${py1}px`;
}

/** 区域的行列描述：单格就写「第 2 行第 5 列」，跨格写「第 1 行第 3-8 列」 */
function spanLabel(r) {
  const row = r.y0 === r.y1 ? `第 ${r.y0 + 1} 行` : `第 ${r.y0 + 1}-${r.y1 + 1} 行`;
  const col = r.x0 === r.x1 ? `第 ${r.x0 + 1} 列` : `第 ${r.x0 + 1}-${r.x1 + 1} 列`;
  return `${row}${col}`;
}

/** 区域方位词取区域中心所在的三分格 */
function regionWord(r) {
  const cx = Math.floor((r.x0 + r.x1) / 2);
  const cy = Math.floor((r.y0 + r.y1) / 2);
  return positionWord(cx, cy);
}

function pct(v) {
  return `${(v * 100).toFixed(1)}%`;
}

/**
 * 生成给模型看的像素对比报告。
 * 截图拿不到（例如只有 URL / 文件不存在）时不编造，直接说明原因并给出补救办法。
 */
export async function buildDiffReport({ designPath, screenshotPath, ssim, pixelDiffPercentage }) {
  const head = [];
  if (Number.isFinite(ssim)) {
    head.push(`相似度 SSIM：${ssim.toFixed(4)}（imugi_compare 的原始分数，1 为完全相同）`);
  }
  if (Number.isFinite(pixelDiffPercentage)) {
    // imugi 这个字段名叫 Percentage，实际给的是 0~1 的比例（0.0039 = 0.39%），
    // 且口径是「被判定为不同的像素占比」，与下面自算的平均差异不是一回事，
    // 两个数不一样很正常，标注清楚免得模型以为哪个算错了
    head.push(
      `imugi_compare 判定为不同的像素占比：${pct(pixelDiffPercentage)}` +
        '（口径是「有多少像素算变了」，与下面的平均差异不同，两者不一致是正常的）',
    );
  }

  if (!designPath || !screenshotPath) {
    return [
      ...head,
      '',
      '⚠ 本次没拿到「设计稿 + 截图」两个本地文件路径，无法生成区域差异报告。',
      designPath ? '' : '  - 缺设计稿路径（designImagePath）',
      screenshotPath ? '' : '  - 缺截图路径：请让 take_screenshot 传 filePath（只给 URL 的话本地读不到图）',
      '',
      '补充说明：imugi_compare 原本还会返回一张差异热力图，但它是 base64 图片，',
      '模型无法读取，只会白白占用上下文，因此已不再传给你。要看热力图请让用户在终端查看。',
    ].filter((l) => l !== null).join('\n');
  }

  try {
    const { W, H, overall, cells } = await gridDiff(designPath, screenshotPath);
    const regions = mergeRegions(cells, TOP_N);

    const lines = [
      '像素对比报告（Node 侧生成，用于定位要改的地方）',
      ...head,
      `整页平均像素差异：${pct(overall)}`,
      `基准尺寸：${W}x${H}（截图已按设计稿尺寸缩放对齐后再比较）`,
      '',
      `差异最大的 ${regions.length} 个区域（页面切成 ${GRID_X} 列 x ${GRID_Y} 行的网格，` +
        '行列从 1 开始数，从上到下、从左到右；相邻的高差异格已合并成一块）：',
    ];
    regions.forEach((r, i) => {
      const size = r.count > 1 ? `，覆盖 ${r.count} 格` : '';
      lines.push(
        `  ${i + 1}. ${spanLabel(r)}（${regionWord(r)}区域，` +
          `${pixelRange(r.x0, r.x1, r.y0, r.y1, W, H)}${size}）：平均差异 ${pct(r.mean)}`,
      );
    });
    lines.push(
      '',
      '怎么用：优先看排在前面的区域，检查那里的布局、配色、元素大小与位置是否与设计稿不一致。',
      '注意：字体抗锯齿、图片内容本身不同都会产生差异，「差异百分比」不等于「错得有多离谱」——',
      '它只告诉你「哪里最不像」，不要为了压低这个数字去做无意义的调整（例如把文字调小去贴合像素）。',
    );
    return lines.join('\n');
  } catch (err) {
    return [
      ...head,
      '',
      `⚠ 生成区域差异报告失败：${err.message}`,
      `  设计稿：${designPath}`,
      `  截图：${screenshotPath}`,
      '请检查这两个路径是否都是可读的图片文件。',
    ].join('\n');
  }
}

/**
 * 从 imugi_compare 的原始返回里抠出 SSIM 等数字。
 * 它的 text 块是一段 JSON 字符串；解析失败不算错，只是没有数字可用。
 */
export function parseImugiNumbers(text) {
  if (!text) return {};
  try {
    const o = JSON.parse(text);
    return {
      ssim: Number.isFinite(o?.ssim) ? o.ssim : undefined,
      pixelDiffPercentage: Number.isFinite(o?.pixelDiffPercentage) ? o.pixelDiffPercentage : undefined,
    };
  } catch {
    return {};
  }
}

/** 把 imugi_compare 的入参规整成两个本地文件路径 */
export function localPathsFromArgs(args = {}) {
  const clean = (v) => {
    const s = String(v ?? '').trim().replace(/^["']|["']$/g, '');
    return s && fs.existsSync(s) && fs.statSync(s).isFile() ? path.resolve(s) : null;
  };
  return {
    designPath: clean(args.designImagePath),
    screenshotPath: clean(args.screenshotPath),
  };
}
