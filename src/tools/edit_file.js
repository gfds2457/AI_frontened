import { z } from "zod"
import * as fs from "fs"
import path from "path"

export default {
  define: {
    name: "edit_file",
    description:
      "对已有文件做精准的字符串替换修改。需要提供 filePath、oldString（文件中已存在、要被替换掉的原文，尽量带上足够上下文以保证唯一匹配）和 newString（替换后的内容）。\n" +
      "oldString 必须与文件中现有内容完全一致（含缩进/空白/换行）；找不到或匹配到多处时不会修改文件并返回说明，请根据返回信息调整后重试。",
    outputSchema: z.string().describe("修改后的文件内容"),
    inputSchema: z.object({
      filePath: z.string().describe("要修改的文件的路径").refine((val) => path.isAbsolute(val), "只能传绝对路径"),
      oldString: z.string().describe("文件中已有的、要替换掉的原文，必须唯一且与文件内容完全一致"),
      newString: z.string().describe("替换后的新内容"),
      replaceAll: z.boolean().optional().describe("是否替换全部匹配；缺省时要求 oldString 唯一匹配")
    })
  },
  handle({ filePath, oldString, newString, replaceAll = false }) {
    const resolved = path.resolve(filePath)
    if (!fs.existsSync(resolved)) {
      return `修改失败：文件不存在 ${resolved}`
    }
    const content = fs.readFileSync(resolved, 'utf-8')
    const count = content.split(oldString).length - 1
    if (count === 0) {
      return "修改失败：文件中未找到与 oldString 完全一致的文本。" +
        "请检查内容是否一致（包括缩进、空白与换行），或先读取文件确认当前内容。"
    }
    if (count > 1 && !replaceAll) {
      return `修改失败：oldString 在文件中有 ${count} 处匹配，不唯一。` +
        "请补充更多上下文使 oldString 唯一，或设置 replaceAll 为 true 替换全部匹配。"
    }
    const updated = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString)
    fs.writeFileSync(resolved, updated, 'utf-8')
    return `已替换 ${count} 处。本次变更内容：\n${updated}`
  }
}
