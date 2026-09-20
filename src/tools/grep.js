import { z } from "zod"
import { spawn } from "node:child_process"
import * as fs from "node:fs"
import path from "node:path"
import { rgPath } from "@vscode/ripgrep"

// 单条匹配行最大保留长度，避免被压缩的超长行灌爆上下文
const MAX_LINE = 300
// 默认最多返回的匹配条数，防止超大输出回灌模型
const DEFAULT_MAX_RESULTS = 100

/**
 * 执行 ripgrep 的 --json 检索，逐行解析 match 对象，
 * 收集满 maxResults 条后立即终止子进程，避免超大输出。
 */
function search(targetDir, args, maxResults) {
  return new Promise((resolve, reject) => {
    const child = spawn(rgPath, args, {
      cwd: targetDir,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let buf = ""
    let stderr = ""
    const matches = []
    let capped = false

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")

    child.stdout.on("data", (chunk) => {
      buf += chunk
      let idx
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (!line.trim()) continue
        let obj
        try {
          obj = JSON.parse(line)
        } catch {
          continue
        }
        if (obj.type !== "match") continue
        matches.push(obj.data)
        if (matches.length >= maxResults) {
          capped = true
          child.kill()
          resolve({ matches, capped })
          return
        }
      }
    })

    child.stderr.on("data", (d) => {
      if (stderr.length < 2000) stderr += d
    })

    child.on("error", reject)
    child.on("close", () => {
      resolve({ matches, capped, stderr })
    })
  })
}

export default {
  define: {
    name: "grep",
    description:
      "基于 ripgrep 在指定目录下按关键词检索代码，返回每个匹配位置。\n" +
      "返回结果每行格式：文件绝对路径|行号|匹配代码。\n" +
      "默认按字面文本检索（非正则），自动跳过 .gitignore 里的文件与二进制文件。\n" +
      "适合在修改前先定位某符号/关键词出现在哪些文件的哪些行。",
    outputSchema: z.string().describe("检索结果，格式：文件绝对路径|行号|匹配代码"),
    inputSchema: z.object({
      keyword: z.string().describe("要检索的关键词，默认按字面量文本匹配"),
      dir: z
        .string()
        .optional()
        .describe("检索的目标目录（绝对路径），默认当前项目工作目录"),
      useRegex: z.boolean().optional().describe("keyword 是否按正则解析，默认 false"),
      ignoreCase: z.boolean().optional().describe("是否忽略大小写，默认 false"),
      include: z
        .string()
        .optional()
        .describe("只检索匹配该 glob 的文件，多个用逗号分隔，如 *.js、src/**/*.ts"),
      maxResults: z
        .number()
        .optional()
        .describe(`最多返回的匹配条数，默认 ${DEFAULT_MAX_RESULTS}`),
    }),
  },
  async handle({ keyword, dir, useRegex = false, ignoreCase = false, include, maxResults = DEFAULT_MAX_RESULTS }) {
    const targetDir = path.resolve(dir || process.cwd())
    if (!fs.existsSync(targetDir)) return `检索失败：目录不存在 ${targetDir}`
    if (!fs.statSync(targetDir).isDirectory()) return `检索失败：${targetDir} 不是目录`

    // cwd 指向检索目录并检索 "."，让输出路径统一为相对路径，便于拼接成绝对路径
    const args = ["--json", "--no-heading", "--color", "never"]
    if (!useRegex) args.push("--fixed-strings")
    if (ignoreCase) args.push("-i")
    for (const g of (include || "").split(",").map((s) => s.trim()).filter(Boolean)) {
      args.push("--glob", g)
    }
    args.push(keyword, ".")

    const { matches, capped, stderr } = await search(targetDir, args, maxResults)

    // rg 出错（如正则非法、目录无权访问）时向 stderr 输出且无 match；目录是否存在的已在上方校验
    if (matches.length === 0 && stderr.trim()) {
      return `检索失败：${stderr.trim()}`
    }
    if (matches.length === 0) {
      return `未在 ${targetDir} 中找到包含 “${keyword}” 的代码`
    }

    const lines = matches.map((m) => {
      // 路径形如 ".\edit_file.js"，去掉前导 "./" 或 ".\" 后拼绝对路径，再统一为正斜杠
      const rel = (m.path.text || "").replace(/^[.][/\\]/, "")
      const abs = path.join(targetDir, rel).split(path.sep).join("/")
      let code = (m.lines.text || "").replace(/[\r\n]+$/, "")
      if (code.length > MAX_LINE) code = code.slice(0, MAX_LINE) + "…"
      return `${abs}|${m.line_number}|${code}`
    })

    let out = lines.join("\n")
    if (capped) {
      out += `\n…已超过 ${maxResults} 条上限，仅返回前 ${maxResults} 条`
    }
    return out
  },
}
