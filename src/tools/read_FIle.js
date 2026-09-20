import { z } from "zod"
import * as fs from "fs"
import path from "path"

export default {
  define: {
    name: "read_file",
    description: "读取指定文件的内容，返回 UTF-8 字符串",
    outputSchema: z.string().describe("文件的内容"),
    inputSchema: z.object({
      filePath: z.string().describe("要读取的文件的路径").refine((val) => path.isAbsolute(val), "只能传绝对路径")
    })
  },
  handle({ filePath }) {
    return fs.readFileSync(path.resolve(filePath), 'utf-8')
  }
}
