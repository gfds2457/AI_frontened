import { z } from "zod"
import * as fs from "fs"
import path from "path"

export default {
  define: {
    name: "skill",
    description: "加载skill详情使用",
    inputSchema: z.object({
      skillPath: z.string().describe("要加载的skill的路径")
    })
  },
  handle({ skillPath }) {
    return fs.readFileSync(path.resolve(skillPath), 'utf-8')
  }
}