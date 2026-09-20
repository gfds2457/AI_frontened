/**
 * 大模型客户端工厂。
 *
 * 项目里需要「按 setting.json 造一个 ChatOpenAI」的地方不止一处（对话主流程、
 * 让视觉模型看图等），配置项必须完全一致 —— 尤其是 baseURL：本项目走的是
 * DashScope 的 OpenAI 兼容端点，漏配 configuration.baseURL 会静默回落到
 * api.openai.com，报出来的却是含糊的连接错误（本项目踩过一次，见需求规划 §13.7）。
 * 所以统一在这里构造，只此一处。
 *
 * 未配置 apiKey 时返回 null，由调用方自行降级（对话侧是「演示模式」）。
 */
import { ChatOpenAI } from '@langchain/openai';
import CONFIG from '../../../config.js';

/**
 * @param {{timeout?:number, maxRetries?:number, temperature?:number}} [opts]
 * @returns {ChatOpenAI|null} 未配置 apiKey 时为 null
 */
export function createChatModel(opts = {}) {
  if (!CONFIG.apiKey) return null;
  const { timeout = 180000, maxRetries = 1, temperature } = opts;
  return new ChatOpenAI({
    apiKey: CONFIG.apiKey,
    configuration: { baseURL: CONFIG.baseURL },
    model: CONFIG.model,
    timeout,
    maxRetries,
    ...(temperature === undefined ? {} : { temperature }),
  });
}
