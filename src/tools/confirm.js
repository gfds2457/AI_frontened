import { z } from "zod"
import chalk from "chalk"
import { withLineInput } from "../utils/input/lineInput.js"

/**
 * 用 withLineInput 借 stdin 问一行：工具执行期间 TUI 输入控制器处于 busy 状态
 * （忽略按键），这里临时接管；结束后由它把 raw 模式与 stdin 流动状态完整还给 TUI。
 * 非 TTY 环境下无法交互，answer 为 null。
 */
export default {
  define: {
    name: "confirm",
    // 会阻塞等人回答：调用方不能用默认 90s 超时掐断
    interactive: true,
    description:
      "向用户确认是否执行后续操作。" +
      "在进行危险操作（如删除文件、覆盖写入、执行可能有副作用的命令等）之前，" +
      "必须先调用此工具询问用户是否同意，拿到确认后再继续。",
    inputSchema: z.object({
      action: z
        .string()
        .describe("要确认的操作描述，例如：删除文件 src/utils/old.js、覆盖写入 config.json"),
      reason: z
        .string()
        .optional()
        .describe("需要确认的原因或风险说明，帮助用户判断"),
    }),
  },
  async handle({ action, reason }) {
    const lines = [
      chalk.yellow("⚠ 需要确认操作"),
      chalk.white(`操作: ${action}`),
    ]
    if (reason) lines.push(chalk.gray(`原因: ${reason}`))
    const prompt = lines.join("\n") + chalk.cyan("\n是否执行？(y/n): ")

    const answer = await withLineInput((ask) => ask(prompt))
    if (answer === null) {
      return { ok: false, text: "无法获取用户输入（非交互式终端），操作已取消" }
    }
    // 直接回车（空回答）视为未确认，不能当成「用户同意」
    const confirmed = /^(y|yes|是|确认|ok)$/i.test(answer.trim())
    return {
      text: confirmed ? `用户已确认执行：${action}` : `用户已拒绝执行：${action}`,
      // 编排侧据此判断走不走下一步，不必再解析中文
      data: { confirmed, action },
    }
  },
}
