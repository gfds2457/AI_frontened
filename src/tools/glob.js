import { z } from "zod"
import * as fs from "node:fs"
import path from "node:path"
import { globSync } from "glob"

// 默认最多返回的匹配条数，防止超大列表灌爆模型上下文
const DEFAULT_MAX_RESULTS = 500
// 默认排除的常见噪音目录，可通过 ignore 参数整体覆盖
const DEFAULT_IGNORES = ["**/node_modules/**", "**/.git/**"]

export default {
  define: {
    name: "glob",
    description:
      "按文件名/glob 模式在指定目录下递归搜索文件或目录，返回匹配的绝对路径列表（每行一个）。\n" +
      "pattern 支持通配：** 匹配任意层目录、* 匹配文件名片段、{a,b} 或 [0-9] 等；" +
      "若 pattern 不含斜杠（如 grep.js 或 *.js），会自动在整棵目录树下按文件名匹配。\n" +
      "默认跳过 node_modules 与 .git，如需检索依赖源码请通过 ignore 传入新的排除列表以覆盖默认。\n" +
      "适合在修改前先按文件名/命名规则定位文件。",
    outputSchema: z.string().describe("匹配到的文件绝对路径列表，每行一个"),
    inputSchema: z.object({
      pattern: z.string().describe("文件名/glob 匹配模式，如 src/**/*.js、**/*test*、grep.js"),
      dir: z
        .string()
        .optional()
        .describe("检索的起始目录（绝对路径），默认当前项目工作目录"),
      ignore: z
        .string()
        .optional()
        .describe("要排除的 glob 列表，多个用逗号分隔；传入即覆盖默认排除项"),
      dotfiles: z
        .boolean()
        .optional()
        .describe("是否匹配以 . 开头的隐藏文件，默认 false"),
      ignoreCase: z.boolean().optional().describe("匹配时忽略大小写，默认 false"),
      maxResults: z
        .number()
        .optional()
        .describe(`最多返回的匹配条数，默认 ${DEFAULT_MAX_RESULTS}`),
    }),
  },
  handle({ pattern, dir, ignore, dotfiles = false, ignoreCase = false, maxResults = DEFAULT_MAX_RESULTS }) {
    const targetDir = path.resolve(dir || process.cwd())
    if (!fs.existsSync(targetDir)) return `检索失败：目录不存在 ${targetDir}`
    if (!fs.statSync(targetDir).isDirectory()) return `检索失败：${targetDir} 不是目录`

    const ignores =
      ignore != null && ignore.trim() !== ""
        ? ignore.split(",").map((s) => s.trim()).filter(Boolean)
        : DEFAULT_IGNORES

    let files
    try {
      files = globSync(pattern, {
        cwd: targetDir,
        matchBase: true, // 无斜杠的 pattern 按文件名在整棵树下匹配
        dot: dotfiles,
        nocase: ignoreCase,
        ignore: ignores,
      })
    } catch (err) {
      return `检索失败：glob 模式 “${pattern}” 非法（${err.message}）`
    }

    if (files.length === 0) {
      return `未在 ${targetDir} 中找到匹配 “${pattern}” 的文件`
    }

    const capped = files.length > maxResults
    const lines = files
      .slice(0, maxResults)
      .map((f) => path.join(targetDir, f).split(path.sep).join("/"))
      .sort()

    let out = lines.join("\n")
    if (capped) {
      out += `\n…共匹配 ${files.length} 条，已超过 ${maxResults} 条上限，仅返回前 ${maxResults} 条`
    }
    return out
  },
}
