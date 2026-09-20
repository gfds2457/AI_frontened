/**
 * 向量化（embedding）封装 —— 步骤 2。
 * 向量模型配置读取自 .front/setting.json 的 embeddingModel / embeddingApiKey / embeddingBaseURL
 * （loadFrontConfig 已合并 全局 + 项目 两级配置）。
 */
import { OpenAIEmbeddings } from '@langchain/openai';
import { loadFrontConfig } from '../fs/pathUtils.js';

/** 读取 embedding 配置并创建 @langchain 的 OpenAIEmbeddings（OpenAI 兼容接口） */
export async function createEmbeddings(cwd = process.cwd()) {
  const { embeddingModel, embeddingApiKey, embeddingBaseURL } = await loadFrontConfig(cwd);
  if (!embeddingModel || !embeddingApiKey || !embeddingBaseURL) {
    throw new Error('setting.json 缺少 embeddingModel / embeddingApiKey / embeddingBaseURL 配置');
  }
  return new OpenAIEmbeddings({
    model: embeddingModel,
    apiKey: embeddingApiKey,
    configuration: { baseURL: embeddingBaseURL },
  });
}

/** 文本数组 → 等长向量数组（入库前 embed 全部块、检索时 embed 查询句均可复用） */
export async function embedTexts(texts, cwd = process.cwd()) {
  const embeddings = await createEmbeddings(cwd);
  return embeddings.embedDocuments(texts);
}
