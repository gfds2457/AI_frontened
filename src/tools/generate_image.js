import { z } from "zod"
import chalk from "chalk"
import CONFIG from "../../config.js"
import { generateImage } from "../utils/image/generate.js"
import { startSpinner, stopSpinner } from "../utils/logger/logger.js"

export default {
  define: {
    name: "generate_image",
    description:
      "按文字描述生成图片。两种用途，用 kind 参数区分：" +
      "kind=design 出「整页设计稿」，保存到 .front/design/AI-image，用于用户没给设计图时需要先设计界面的场合；" +
      "kind=asset（缺省）出「页内图片素材」，保存到 .front/design/AI-asset，" +
      "用于还原页面时页面里要用到图片（图标、插画、背景图、头像、logo、空状态图、装饰图形、占位图等）而项目里没有现成图片的场合。" +
      "不要用纯 CSS 硬凑素材、不要留空占位块、更不要写死外部图床或网图链接。" +
      `当前使用的模型是 ${CONFIG.imageModel}。` +
      "生成完成后你应当用 confirm 工具向用户确认是否满意；" +
      "不满意就补充细节（主体、风格、配色、构图）调整描述重新生成。" +
      "返回的结果里带有图片路径，写代码时按该路径引用即可，后续也可用 # 引用它，或交给 imugi_compare 使用。",
    // 文生图实测要 100s 上下，远超默认的 90s 工具超时，单独放宽。
    // 注意这里要覆盖的是**整条链路的最坏耗时**，不是单次请求：同步出图失败会降级到异步
    // （提交 + 轮询 300s + 下载 300s），按单次请求的 300s 卡的话，图还在生成、费用照扣，
    // 模型却已被告知失败（Python 侧在这个值之上再加 30s 余量）
    timeout: 660000,
    inputSchema: z.object({
      prompt: z
        .string()
        .describe(
          "图片描述。" +
          "画整页设计稿时要写清：页面类型、布局结构（几栏/栅格）、各区块内容、配色、视觉风格、圆角与阴影尺度。" +
          "画素材时要写清：素材类型（图标/插画/背景图/头像/logo/占位图）、画面主体、风格（扁平/线性/拟物/3D/手绘）、配色、构图与留白。" +
          "中文即可，比如「扁平风格的蓝色购物车图标，圆角线条，浅灰背景，主体居中、四周留白充足」",
        ),
      kind: z
        .enum(["asset", "design"])
        .optional()
        .describe(
          "出图用途：design=整页设计稿（存 .front/design/AI-image），asset=页内图片素材（存 .front/design/AI-asset）。不传按 asset 处理",
        ),
      name: z
        .string()
        .optional()
        .describe(
          "保存的文件名（不含扩展名），会存成 <kind 对应目录>/<name>.png。" +
          "建议用中文描述性命名，如 购物车图标、首页背景图，便于辨认和后续引用；不传则用时间戳命名",
        ),
      size: z
        .string()
        .optional()
        .describe(
          "图片尺寸，格式「宽*高」，如 1024*1024。图标、头像这类方形素材传 1024*1024，" +
          "横幅、背景图则用宽扁比例。不传由模型根据描述自动推荐，一般不用传",
        ),
    }),
  },
  async handle({ prompt, kind, name, size }) {
    const label = kind === "design" ? "设计稿" : "素材图"
    startSpinner(`正在生成${label}…`)
    let result
    try {
      result = await generateImage(prompt, {
        name,
        size,
        kind,
        onWait: (status) => startSpinner(`正在生成${label}…（${status}）`),
      })
    } catch (err) {
      stopSpinner()
      return { ok: false, text: `${label}生成失败：${err.message}` }
    }
    stopSpinner()

    console.log(chalk.gray(`🎨 ${label}已保存：${result.rel}`))

    return {
      text: `已生成${label}并保存到 ${result.rel}（模型 ${result.model}）。`,
      // 编排侧要拿路径传给 imugi_compare / 写进代码，不能靠解析中文
      data: { path: result.abs, rel: result.rel, model: result.model },
    }
  },
}
