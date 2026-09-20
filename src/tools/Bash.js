import { z } from "zod"
import { spawn } from "node:child_process"
import os from "node:os"
import path from "node:path"

const isWindows = os.platform() === "win32"

// 输出最大保留长度，超出截断，避免超大输出灌回模型上下文
const MAX_OUTPUT = 30000
const DEFAULT_TIMEOUT = 120000

/**
 * 按平台启动 shell 子进程：
 *  - Windows：powershell.exe 执行（模型需生成 PowerShell 语法命令）
 *    参数以数组形式传入，避免跨 shell 的引号转义问题
 *  - 其他平台（macOS/Linux）：bash 直接执行
 */
function spawnShell(command, cwd) {
  if (isWindows) {
    // 前置强制 UTF-8 输出：PowerShell 5.1 在中文系统默认 GBK，Node 按 UTF-8 解码会乱码
    const psCommand = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${command}`
    return spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psCommand],
      { cwd, windowsHide: true }
    )
  }
  return spawn("bash", ["-c", command], { cwd })
}

/** 执行一条 shell 命令，汇总 stdout/stderr/退出码后以字符串返回 */
function exec(command, { cwd, timeout }) {
  return new Promise((resolve, reject) => {
    const child = spawnShell(command, cwd)
    let stdout = ""
    let stderr = ""
    let killed = false

    const timer = setTimeout(() => {
      killed = true
      child.kill("SIGKILL")
    }, timeout)

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (d) => {
      if (stdout.length < MAX_OUTPUT) stdout += d
    })
    child.stderr.on("data", (d) => {
      if (stderr.length < MAX_OUTPUT) stderr += d
    })

    // shell 本身启动失败（如可执行文件不存在）
    child.on("error", (err) => {
      clearTimeout(timer)
      reject(new Error(`无法启动 shell 执行命令: ${err.message}`))
    })

    child.on("close", (code) => {
      clearTimeout(timer)
      if (killed) {
        resolve(`命令执行超时（>${timeout}ms），已被强制终止。\n${stdout}${stderr}`.trim())
        return
      }
      const parts = []
      if (stdout.trim()) parts.push(stdout.trim())
      if (stderr.trim()) parts.push(`[stderr]\n${stderr.trim()}`)
      let out = parts.join("\n") || "(命令无输出)"
      if (out.length >= MAX_OUTPUT) out += "\n...(输出过长已截断)"
      out += `\n[退出码 ${code}]`
      if (code !== 0) out = `命令执行失败：\n${out}`
      resolve(out)
    })
  })
}

export default {
  define: {
    name: "Bash",
    description:
      "在用户机器上执行 shell 命令（命令行工具）。\n" +
      "使用时机：仅当用户明确要求使用命令行/Bash，或没有专用工具能完成该任务时才使用本工具；" +
      "能用内置专用工具完成的事（如读文件、加载 skill 等）不要用 Bash。\n" +
      "操作系统适配：必须先区分用户的操作系统，生成对应语法的命令——" +
      `当前系统为 ${os.platform()}：Windows 系统通过 PowerShell 执行，必须使用 PowerShell 语法，不要使用 bash 专有语法；` +
      "macOS/Linux 系统通过 bash 直接执行，使用标准 bash 语法。\n" +
      "命令默认在用户当前工作目录下执行，返回标准输出、标准错误与退出码。",
    inputSchema: z.object({
      command: z
        .string()
        .describe("要执行的命令。Windows 上使用 PowerShell 语法，macOS/Linux 上使用 bash 语法"),
      cwd: z
        .string()
        .optional()
        .describe("命令执行的工作目录（绝对路径），默认为当前项目工作目录"),
      timeout: z
        .number()
        .optional()
        .describe("超时时间（毫秒），默认 120000，超时后命令会被强制终止"),
    }),
  },
  async handle({ command, cwd, timeout = DEFAULT_TIMEOUT }) {
    const workDir = cwd ? path.resolve(cwd) : process.cwd()
    return exec(command, { cwd: workDir, timeout })
  },
}
