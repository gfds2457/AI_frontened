import path from "node:path"
import { fileURLToPath } from "node:url"
import { promises as fs } from "node:fs"
import { z } from "zod"
import { GLOBAL_CONFIG_DIR } from "../utils/fs/pathUtils.js"

export default {
  define: {
    name: "memory_save",
    description:
      "保存项目级记忆和用户全局记忆。不要使用通用writeFile，必须调用本工具。" +
      "会自动写到固定路径：项目记忆写入项目目录下 .front/memories/memories.md；" +
      "用户记忆写入用户主目录 ~/.front/memories/memories.md。" +
      "传入完整更新后的markdown文本，不要传片段。" +
      "保存成功后会把最新记忆同步填入 src/docs/userContest.md 的 ${projectMemory}/${userMemory} 占位符。",
    inputSchema: z.object({
      projectMem: z
        .string()
        .describe("完整更新后的项目级记忆markdown全部内容，传完整文本，不能传片段。没有项目记忆就传空字符串"),
      userMem: z
        .string()
        .describe("完整更新后的用户全局记忆markdown全部内容，传完整文本，不能传片段。没有用户记忆就传空字符串"),
    }),
  },
  async handle({ projectMem, userMem }) {
    // 写死固定路径，AI不能改；与 src/utils/storage/memories.js 的读取路径保持一致，
    // 保证 /memory 生成的记忆下一轮能被 buildMemoryPrompt 读回
    const projectPath = path.resolve("./.front/memories/memories.md")
    const userPath = path.join(GLOBAL_CONFIG_DIR, "memories", "memories.md")

    // 兜底：读取磁盘旧记忆，做简单防护
    let oldProject = ""
    let oldUser = ""
    try {
      oldProject = await fs.readFile(projectPath, "utf-8")
      oldUser = await fs.readFile(userPath, "utf-8")
    } catch (e) {/* 文件不存在就为空 */ }

    // 简单校验：新内容大量清空旧内容，给警告，可根据自己需求调整严格程度
    const isProjectWipe = oldProject.length > 100 && projectMem.length < oldProject.length * 0.3
    const isUserWipe = oldUser.length > 100 && userMem.length < oldUser.length * 0.3
    if (isProjectWipe || isUserWipe) {
      return { success: false, error: "检测到记忆几乎被清空，拒绝写入，请检查记忆合并结果" }
    }

    // 校验通过才覆盖写入原文件；目录不存在时先创建（writeFile 不会自动建父目录）
    if (projectMem) {
      await fs.mkdir(path.dirname(projectPath), { recursive: true })
      await fs.writeFile(projectPath, projectMem, "utf-8")
    }
    if (userMem) {
      await fs.mkdir(path.dirname(userPath), { recursive: true })
      await fs.writeFile(userPath, userMem, "utf-8")
    }

    // 同步用户上下文模板：把最新记忆填入 src/docs/userContest.md 的占位符。
    // 模板路径基于本文件定位，不依赖 cwd；用标签正则定位而非只匹配占位符，
    // 这样重复保存时也能覆盖上一次已填入的旧内容
    if (projectMem || userMem) {
      const contestPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "userContest.md")
      try {
        let contest = await fs.readFile(contestPath, "utf-8")
        if (projectMem) {
          contest = contest.replace(
            /当前项目有关记忆：[\s\S]*?(?=\n当前用户有关记忆：|$)/,
            `当前项目有关记忆：${projectMem}`
          )
        }
        if (userMem) {
          contest = contest.replace(/当前用户有关记忆：[\s\S]*$/, `当前用户有关记忆：${userMem}`)
        }
        await fs.writeFile(contestPath, contest, "utf-8")
      } catch (e) {/* 模板缺失时跳过，不影响记忆保存 */ }
    }

    return { success: true, msg: "记忆保存完成", projectPath, userPath }
  }
}
