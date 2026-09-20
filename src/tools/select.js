import { z } from "zod"
import chalk from "chalk"
import { withLineInput } from "../utils/input/lineInput.js"

// 首次输入后最多再重试的次数，防止用户一直输错导致无限等待
const MAX_RETRIES = 2

/**
 * 解析用户输入，返回选中的选项编号（1-based 数组）：
 *  - 纯编号（支持逗号/空格分隔，供多选）→ 映射到对应选项
 *  - q / 0 / 取消 等 → 用户取消
 *  - 其余文本 → 视为用户自定义回答
 */
export function parseAnswer(raw, optionCount, multiple) {
  const s = raw.trim()
  if (!s) return { error: "输入为空，请输入选项编号" }
  if (/^(q|exit|quit|0|取消|退出)$/i.test(s)) return { cancel: true }
  if (/^[\d,\s，]+$/.test(s)) {
    const nums = s.split(/[,，\s]+/).map(Number)
    const bad = nums.find((n) => !Number.isInteger(n) || n < 1 || n > optionCount)
    if (bad) return { error: `编号需在 1-${optionCount} 之间` }
    if (!multiple && nums.length > 1) return { error: "单选只需输入一个编号" }
    return { picks: [...new Set(nums)] }
  }
  return { custom: s }
}

export default {
  define: {
    name: "select",
    // 会阻塞等人回答：调用方不能用默认 90s 超时掐断
    interactive: true,
    description:
      "向用户发起一次选择：给出问题与若干候选选项，等待用户在终端输入编号作答。\n" +
      "使用时机：AI 对用户需求理解不明确、或存在多个可行方案/参数需要用户拍板时，调用此工具让用户从中选择，拿到结果后再继续。\n" +
      "返回用户选中的选项文本；用户也可直接输入自定义内容作答，或取消。",
    outputSchema: z.string().describe("用户的选择结果（选项文本或自定义回答）"),
    inputSchema: z.object({
      question: z.string().describe("要抛给用户的问题，尽量具体，例如：需要读取哪个文件的内容？"),
      options: z
        .array(z.string())
        .min(2)
        .describe("候选选项文本列表（至少 2 项），如 [\"方案A：重写\", \"方案B：最小改动\"]"),
      multiple: z
        .boolean()
        .optional()
        .describe("是否允许多选，true 时用户可用逗号分隔输入多个编号，默认 false"),
    }),
  },
  async handle({ question, options, multiple = false }) {
    // 工具执行期间 TUI 输入控制器处于 busy 状态（忽略按键），这里临时接管 stdin；
    // withLineInput 结束后会把 raw 模式与 stdin 流动状态还给 TUI（否则 TUI 从此收不到按键）
    const result = await withLineInput(async (ask) => {
      const lines = [chalk.yellow("❓ 需要你做一个选择"), chalk.white(`问题: ${question}`)]
      options.forEach((o, i) => lines.push(chalk.cyan(`  ${i + 1}. ${o}`)))
      if (multiple) lines.push(chalk.gray("（可多选，编号用逗号分隔）"))
      console.log(lines.join("\n"))

      let answer = await ask(chalk.cyan("\n请选择编号: "))
      let parsed = parseAnswer(answer, options.length, multiple)
      for (let i = 0; parsed.error && i < MAX_RETRIES; i++) {
        answer = await ask(chalk.yellow(`无效输入（${parsed.error}），请重新输入: `))
        parsed = parseAnswer(answer, options.length, multiple)
      }
      return parsed
    })

    if (!result) {
      return {
        ok: false,
        text: `无法交互：当前不是交互式终端，无法向用户发起选择。问题：${question}；选项：${options.join(" / ")}`,
      }
    }

    // data 里带上结构化结果，编排侧可判断"用户取消"而不是去解析中文
    if (result.error) {
      return { text: "用户多次输入无效，本次选择已取消", data: { cancelled: true, reason: "invalid_input" } }
    }
    if (result.cancel) return { text: "用户已取消选择", data: { cancelled: true, reason: "cancelled" } }

    if (result.custom !== undefined) {
      return { text: `用户自定义回答：${result.custom}`, data: { cancelled: false, custom: result.custom } }
    }
    const picks = result.picks || []
    const picked = picks.map((n) => `${n}. ${options[n - 1]}`)
    const data = { cancelled: false, picks: picks.map((n) => options[n - 1]) }
    if (picked.length === 1) return { text: `用户选择了：${picked[0]}`, data }
    return { text: `用户选择了 ${picked.length} 项：${picked.join("；")}`, data }
  },
}
