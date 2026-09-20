/**
 * 图生成 —— 调 DashScope 的 qwen-image-3.0-pro 文生图，把成品下载落盘。
 *
 * 按用途分两个目录落盘，避免设计稿和素材图混在一起：
 *   kind='design' → .front/design/AI-image  整页设计稿（设计师 agent 产出，是「原始设计图」）
 *   kind='asset'  → .front/design/AI-asset  页面里用到的图片素材（图标、插画、背景图……）
 *
 * 走的是 DashScope 原生接口（图像生成不支持 OpenAI 兼容模式），与主对话共用同一个
 * API Key 与业务空间，端点从 baseURL 推导（见 config.js）：
 *   POST {apiBase}/services/aigc/multimodal-generation/generation   同步，优先
 *   POST {apiBase}/services/aigc/image-generation/generation        异步兜底（X-DashScope-Async: enable）
 *   GET  {apiBase}/tasks/{task_id}                                  异步轮询
 * 部分账号只开放异步通道，同步请求会报「不支持同步调用」，这里自动降级重试，对用户透明。
 *
 * 注意：接口返回的是图片 URL，且只有 24 小时有效，必须立刻下载落盘。
 */
import fs from 'node:fs';
import path from 'node:path';
import CONFIG from '../../../config.js';
import { withTimeout } from '../asyncTimeout.js';
import { AI_IMAGE_DIR, ASSET_DIR } from '../input/image.js';

/** kind -> 落盘目录。缺省按素材图走，只有设计师出整页稿时才传 'design' */
const OUT_DIR = { asset: ASSET_DIR, design: AI_IMAGE_DIR };

// 文生图很慢：实测一次同步调用要 100s 左右（提示词改写 + 推理增强都在服务端跑），
// 超时必须给足，否则请求会被中途掐断。生成类的接口不会因为超时就免费重来，宁可多等。
const REQUEST_TIMEOUT = 300000;
/** 异步任务轮询间隔与总时长上限 */
const POLL_INTERVAL = 3000;
const POLL_TIMEOUT = 300000;

/**
 * 文件名里不能出现的字符（Windows 更严格，统一按最严的来），空白也一并换成连字符：
 * 生成的图要靠 `#.front/design/名字.png` 这种以空格分隔的标记来引用，
 * 名字里带空格会把标记截断，索性从一开始就不让空格进文件名。
 */
const ILLEGAL = /[\\/:*?"<>|\s]/g;
const BLANK = '-';

/**
 * 发一次 JSON 请求，失败时抛出带接口原文错误信息的 Error。
 * DashScope 出错时可能返回非 2xx，也可能 2xx 带 code/message，两种都要认。
 */
async function request(url, { method = 'POST', apiKey, body, headers = {} } = {}) {
  const res = await withTimeout(
    fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
    REQUEST_TIMEOUT,
    '图片生成请求',
  );

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // 带上实际请求的地址：404 空响应基本都是 baseURL 拼错（如误用 compatible-mode 地址），
    // 不把地址打出来就只能靠猜
    throw new Error(
      `${method} ${url} 返回了非 JSON 内容（HTTP ${res.status}）：${text.slice(0, 200) || '空响应'}`,
    );
  }
  if (json.code) throw new Error(`${json.code}: ${json.message || '接口返回错误'}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}：${text.slice(0, 200)}`);
  return json;
}

/** 从同步 / 异步两种响应形状里取图片 URL */
function pickUrl(json) {
  const out = json?.output || {};
  return (
    out.choices?.[0]?.message?.content?.[0]?.image || // 同步：多模态生成
    out.results?.[0]?.url || // 异步：图像生成任务
    null
  );
}

/** 错误是否为「该账号不支持同步调用」，是则改用异步通道 */
function needsAsync(err) {
  return /synchronous/i.test(err.message);
}

/**
 * 进程内生效的模型 id。DashScope 的模型 id 一律小写，而配置里很容易按文档标题
 * 写成 Qwen-Image-3.0-Pro，所以首次调用若因模型名报错就换小写重试一次并记住，
 * 不改用户配置。模型名不对时接口不会真的出图，重试不会产生额外计费。
 */
let modelId = CONFIG.imageModel;

async function withModelId(fn) {
  try {
    return await fn(modelId);
  } catch (err) {
    const lower = String(modelId).toLowerCase();
    if (lower === modelId || !/model/i.test(err.message)) throw err;
    const out = await fn(lower);
    modelId = lower;
    return out;
  }
}

/** 同步接口：一次请求直接拿到图片 URL */
function callSync(prompt, parameters, model) {
  if (!CONFIG.imageBaseURL) throw new Error('未配置 imageBaseURL');
  return request(`${CONFIG.imageBaseURL}/services/aigc/multimodal-generation/generation`, {
    apiKey: CONFIG.imageApiKey,
    body: {
      model,
      input: { messages: [{ role: 'user', content: [{ text: prompt }] }] },
      parameters,
    },
  }).then((json) => {
    const url = pickUrl(json);
    if (!url) throw new Error('接口未返回图片地址');
    return url;
  });
}

/** 异步接口：提交任务后轮询，直到 SUCCEEDED / FAILED */
async function callAsync(prompt, parameters, model, onWait) {
  if (!CONFIG.imageBaseURL) throw new Error('未配置 imageBaseURL');
  const submit = await request(`${CONFIG.imageBaseURL}/services/aigc/image-generation/generation`, {
    apiKey: CONFIG.imageApiKey,
    headers: { 'X-DashScope-Async': 'enable' },
    body: {
      model,
      input: { messages: [{ role: 'user', content: [{ text: prompt }] }] },
      parameters,
    },
  });
  const taskId = submit?.output?.task_id;
  if (!taskId) throw new Error('异步任务提交失败：未返回 task_id');

  const deadline = Date.now() + POLL_TIMEOUT;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    if (!CONFIG.imageBaseURL) throw new Error('未配置 imageBaseURL');
    const json = await request(`${CONFIG.imageBaseURL}/tasks/${taskId}`, {
      method: 'GET',
      apiKey: CONFIG.imageApiKey,
    });
    const status = json?.output?.task_status;
    if (status === 'SUCCEEDED') {
      const url = pickUrl(json);
      if (!url) throw new Error('异步任务成功但未返回图片地址');
      return url;
    }
    if (status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN') {
      throw new Error(`异步任务${status}：${json?.output?.message || json.message || '无详情'}`);
    }
    if (onWait) onWait(status); // PENDING / RUNNING：把进度交给调用方展示
  }
  throw new Error(`异步任务超过 ${POLL_TIMEOUT / 1000}s 仍未完成`);
}

/**
 * 生成图片并落盘。
 * @param {string} prompt 图片描述（中文即可，接口会自动改写提示词）
 * @param {{name?: string, size?: string, kind?: 'asset'|'design', onWait?: (status: string) => void}} [opts]
 *   name 文件名（可省扩展名）；size 形如 '1024*1024'，不传由模型按提示词推荐；
 *   kind 落盘目录，缺省 'asset'（素材图），'design' 为整页设计稿
 * @returns {Promise<{abs: string, rel: string, model: string}>} 落盘路径
 */
export async function generateImage(prompt, { name, size, kind, onWait } = {}) {
  const text = String(prompt || '').trim();
  if (!text) throw new Error('图片描述为空');
  if (!CONFIG.imageApiKey) throw new Error('未配置 imageApiKey / apiKey，无法调用图片生成接口');

  const dir = OUT_DIR[kind] || ASSET_DIR;

  const parameters = { n: 1, prompt_extend: true, watermark: false };
  if (size) parameters.size = size;

  let url;
  try {
    url = await withModelId((model) => callSync(text, parameters, model));
  } catch (err) {
    if (!needsAsync(err)) throw err;
    url = await withModelId((model) => callAsync(text, parameters, model, onWait));
  }

  // 立刻下载：接口给的 URL 只保留 24 小时
  const res = await withTimeout(fetch(url), REQUEST_TIMEOUT, '图片下载');
  if (!res.ok) throw new Error(`图片下载失败：HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  fs.mkdirSync(dir, { recursive: true });
  const filename = uniqueName(name, dir);
  const abs = path.join(dir, filename);
  fs.writeFileSync(abs, buf);

  // rel 由 abs 反推，不再另写一份目录字面量：否则目录常量一改，写盘位置与
  // 对外引用的 #.front/design/... 就会对不上（BASE 就是 process.cwd()，见 fileBrowser.js）
  return { abs, rel: path.relative(process.cwd(), abs).replace(/\\/g, '/'), model: modelId };
}

/** 文件名：用户给的名字优先，否则用时间戳；同名不覆盖，追加 -2/-3 序号 */
function uniqueName(name, dir) {
  const base = String(name || '')
    .trim()
    .replace(/\.png$/i, '')
    .replace(ILLEGAL, BLANK) || `asset-${timestamp()}`;
  let filename = `${base}.png`;
  for (let i = 2; fs.existsSync(path.join(dir, filename)); i++) {
    filename = `${base}-${i}.png`;
  }
  return filename;
}

/** 本地时间 yyyymmdd-HHMMSS，作为默认文件名 */
function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
