import { z } from "zod"
import * as fs from "fs"
import path from "path"

export default {
  define: {
    name: "write_file",
    description: "将内容写入指定文件（覆盖写入）",
    inputSchema: z.object({
      filePath: z.string().describe("要写入的文件的路径").refine((val) => path.isAbsolute(val), "只能传绝对路径"),
      content: z.string().describe("要写入的文件内容")
    })
  },
  handle({ filePath, content }) {
    const resolved = path.resolve(filePath)
    fs.mkdirSync(path.dirname(resolved), { recursive: true })
    fs.writeFileSync(resolved, content, 'utf-8')
    return `本次变更内容: ${content}`
  }
}
