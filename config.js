import { loadFrontConfig } from './src/utils/fs/pathUtils.js';
import { DEFAULT_CREW_DIR, DEFAULT_PYTHON_EXE } from './src/server/crewService.js';

/**
 * 把 baseURL 归一化成 DashScope 原生接口根路径（.../api/v1）。
 *
 * 文生图只有原生接口，而对话走的是兼容模式（.../compatible-mode/v1），两者同域不同
 * 路径前缀。用户很容易把对话用的地址原样填进 imageBaseURL，而生成代码是在这个值后面
 * 直接拼 /services/aigc/... 的，原样用会拼出 .../compatible-mode/v1/services/aigc/...
 * 这种不存在的路径，接口回 404 空响应（表现为「返回了非 JSON 内容」）。所以这里收口：
 *   https://ws-xxx.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
 *     → https://ws-xxx.cn-beijing.maas.aliyuncs.com/api/v1
 *
 * 只改认得出来的形态：兼容模式地址换前缀、DashScope 域名（含 maas 专属域名）按 origin
 * 推导。自建反向代理下的自定义前缀（https://gw.corp.com/aliyun）一律原样保留 —— 猜测式
 * 改写会把本来可用的地址改坏，而正则失配时静默回退公网域名还可能把 API Key 发到别处。
 */
const DASHSCOPE_HOST = /(^|\.)(dashscope[a-z-]*|maas)\.aliyuncs\.com$/i;
const COMPAT_SUFFIX = /\/compatible-mode\/v\d+$/;

function deriveImageBase(baseURL) {
  const url = String(baseURL || '').trim().replace(/\/+$/, '');
  if (!url) return 'https://dashscope.aliyuncs.com/api/v1';
  if (COMPAT_SUFFIX.test(url)) return url.replace(COMPAT_SUFFIX, '/api/v1');
  const m = /^(https?:\/\/)([^/]+)/.exec(url);
  if (m && DASHSCOPE_HOST.test(m[2])) return `${m[1]}${m[2]}/api/v1`;
  return url;
}

// 读取全局 + 项目配置（.front/setting.json），项目配置优先生效
const fileConfig = await loadFrontConfig();
const CONFIG = {
  apiKey: fileConfig.apiKey || '',
  baseURL: fileConfig.baseURL || 'https://api.openai.com/v1',
  model: fileConfig.model || 'gpt-4o-mini',
  systemPrompt:
    fileConfig.systemPrompt || '',
  // 素材图生成：与主对话共用同一账号，缺省沿用 apiKey / baseURL，可单独覆盖。
  // imageBaseURL 一律经 deriveImageBase 归一化，兼容模式地址填进来也能用（见上）
  imageModel: fileConfig.imageModel || 'qwen-image-3.0-pro',
  imageApiKey: fileConfig.imageApiKey || fileConfig.apiKey || '',
  imageBaseURL: deriveImageBase(fileConfig.imageBaseURL || fileConfig.baseURL),
  // 对话记录存储路径（用户可在 setting.json 中指定），默认 ~/convert
  storagePath: 'D:/frontCode/convert',
  // CrewAI 编排服务（Python）：由 Node 启动时自动拉起，工具服务端口由 Node 动态分配后告知它。
  // 下面两项若配成相对路径，一律相对**程序安装目录**解析（见 src/server/crewService.js），
  // 不是当前工作目录 —— 在任意项目目录执行 front 都能据此找到解释器与服务目录；
  // 把 python 装在别处就填绝对路径
  crewEnabled: fileConfig.crewEnabled !== false,
  pythonExe: fileConfig.pythonExe || DEFAULT_PYTHON_EXE,
  crewDir: fileConfig.crewDir || DEFAULT_CREW_DIR,
};
export default CONFIG;