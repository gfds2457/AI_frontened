/**
 * 让视觉模型「读」一张设计图，输出一份结构化的文字说明。
 *
 * ## 为什么需要它
 *
 * crew 里的 agent 看不到图：工具结果只能是字符串，没有任何把图喂给模型的通道。
 * 如果直接把设计图路径丢给前端工程师，它只能**凭想象**还原 ——
 * 而任务书里明写着「不要凭想象还原」，这是自相矛盾的。
 *
 * 所以由 Node 在开工前做一次视觉调用，把图转成文字，再把这段文字作为
 * 「原始设计图的机器可读说明」注入工程师任务（§10-3「Node 预注入」）。
 * 好处是双向的：
 *   - 工程师拿到的是精确的布局/色值/元素清单，不是想象；
 *   - 这次视觉调用发生在 crew **之外**的一次性调用里，那 2500 上下的 image tokens
 *     不占「单次请求」的 16000 预算，crew 的上下文始终是纯文本、体积可预测。
 *
 * ## 提示词为什么这么写
 *
 * 这段文字是工程师**唯一**的设计依据，所以既要全（区块顺序、逐块元素、色值、
 * 间距尺度），又要防幻觉（看不清就写看不清，不要猜）。少了任何一项，工程师
 * 都只能自己补 —— 那就又回到「凭想象」了。
 */
import fs from 'node:fs';
import path from 'node:path';
import { HumanMessage } from '@langchain/core/messages';
import { createChatModel } from '../llm/client.js';
import { toDataUri, MAX_IMAGE_SIZE } from '../input/image.js';

/** 单次视觉调用超时：一张图 + 一段长输出，给足 2 分钟 */
const VISION_TIMEOUT = 120000;

const SYSTEM = `你是资深 UI 设计稿分析师。用户会给你一张整页设计稿，你要把它转写成一份
**足够让前端工程师不看图也能一比一还原**的文字说明。

要求：
1. 依次描述页面从上到下的每个区块：区块名称、高度占比、内部元素（文案内容、元素数量、
   排列方式、对齐方式）。
2. 配色写具体色值：主色、辅助色、背景色、文字色、边框色，能读到的直接给 hex。
3. 视觉风格写具体尺度：圆角半径、阴影强弱、区块间距、标题/正文字号层级、字体族倾向（衬线/无衬线）。
4. 布局写清栅格：几栏、每栏宽度关系、最大内容宽度、是否居中。
5. 只写你在图上**真实看到**的内容。看不清或无法判断的地方，明确写「看不清」，
   **绝对不要猜**。宁可少写，也不要编造一个不存在的元素或色值。

输出用 Markdown，按「整体 → 区块（从上到下）→ 配色 → 风格尺度」组织，不要任何开场白和总结语。`;

/**
 * @param {string} absPath 设计图绝对路径
 * @returns {Promise<string>} 结构化设计说明（Markdown 文本）
 */
export async function describeDesign(absPath) {
  const abs = path.resolve(String(absPath || '').trim().replace(/^["']|["']$/g, ''));
  if (!abs) throw new Error('没有给出设计图路径');

  let size;
  try {
    size = fs.statSync(abs).size;
  } catch {
    throw new Error(`设计图不存在或读不到：${abs}`);
  }
  if (!fs.statSync(abs).isFile()) throw new Error(`不是文件：${abs}`);
  if (size > MAX_IMAGE_SIZE) {
    throw new Error(`设计图超过 ${MAX_IMAGE_SIZE / 1024 / 1024}MB（${(size / 1024 / 1024).toFixed(1)}MB），视觉模型收不下`);
  }

  const dataUri = toDataUri(abs);
  if (!dataUri) throw new Error(`图片格式无法识别或读取失败：${abs}`);

  const llm = createChatModel({ timeout: VISION_TIMEOUT });
  if (!llm) throw new Error('未配置 apiKey，无法调用视觉模型');

  const res = await llm.invoke([
    new HumanMessage({
      content: [
        { type: 'text', text: SYSTEM },
        { type: 'image_url', image_url: { url: dataUri } },
      ],
    }),
  ]);

  const text = typeof res.content === 'string' ? res.content : JSON.stringify(res.content);
  if (!text || !text.trim()) throw new Error('视觉模型返回了空内容');
  return text.trim();
}
