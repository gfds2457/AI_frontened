# round-003 任务总结：删除终端图片展示功能

## 本轮任务目标

删除「在终端里把图片画出来给用户看」这一整条能力（半块字符 + 真彩色渲染），包括：

- `view_image` 工具（让模型要求终端显示某张图）
- `generate_image` / `/asset` 生成完成后自动把成品画到对话流里
- TUI 中 `#` 图片浮层里选中图片的缩略预览

保留「图 → 文字」的其余链路：`utils/image/describe.js`（视觉模型把设计图转成文字说明）、
`utils/image/diffReport.js`（imugi_compare 的像素差异报告）、`generate_image` 出图本身。
即：**不再往终端画图，但图仍然可以生成、被读、被比对**。

删除范围经用户确认选择「全删：连 `#` 浮层预览一起」。

## 执行过程

1. **摸清出口**：`grep` 全仓 `view_image|previewImage|imageToLines|supportsTruecolor`，确认渲染核心是
   `src/utils/image/preview.js`，调用方共 4 处（`view_image` 工具、`generate_image`、`/asset` 指令、TUI 浮层）。
2. **确认范围**：用 AskUserQuestion 给出三档范围（全删 / 只删工具 / 删工具+自动预览），用户选「全删」。
3. **删除核心**：删掉 `preview.js`、`view_image.js` 两个文件。
4. **逐处清理**：改 `input.js`（移掉预览状态与 5 个预览函数，浮层退回纯列表）、
   `generate_image.js`（去预览调用 + 改工具描述）、`chatService.js`（去 `/asset` 预览）、
   `manager.js`（角色工具表去掉 `view_image`）、`renderer.js`（`printLines` 删除后已无调用方，一并删掉）、
   `logger.js`（帮助文案去掉「可预览」「成品在终端里直接显示」）。
5. **同步提示词与文档**：`systemDoc.md` 删掉第 9 条 view_image 规范；`describe.js`、`toolServer.js` 注释里
   对 `view_image` 的引用改成中性表述；`.front/memories/memories.md` 与 `src/docs/userContest.md` 的工具清单同步。
6. **同步 Python crew 侧**：`tasks.yaml` 步骤 1 原来明写「view_image 不会把图返回给你」，
   工具已不存在，改为「你看不到设计图本身，设计说明是你唯一的设计依据」；
   `agent.yaml` 工具数量注释、`node_tools.py` / `runner.py` 注释、`需求规划.md` 的工具清单同步。
   `需求规划.md` 里带日期的实测叙述（§13/§14.1 引用 view_image 的两段）作为历史记录保留未改。
7. **测试**：
   - `npm run smoke` 全通过（同步了写死的工具数量：engineer 14→13、designer 5→4）
   - `npm run test:input` 全通过
   - **新增 `npm run test:overlay`**：用假 stdin（`isTTY=true`）驱动真实输入控制器，
     无头验证 `#` 浮层不再画图、列表/滚动/过滤/回车插入/Esc 取消均正常
   - 全量导入 `src/**/*.js`（38 个模块）无死引用；`test_loop.py` 的 view_image 断言改成有效断言

## 文件变更清单

**新增**
- `test/design-overlay.mjs` —— `#` 浮层的无头回归测试（假 stdin + 截获 stdout 逐帧断言）
- `Claude_complete/round-003-task-summary.md` —— 本文档

**删除**
- `src/utils/image/preview.js` —— 半块字符渲染核心（`imageToLines` / `previewImage` / `supportsTruecolor`）
- `src/tools/view_image.js` —— `view_image` 工具
- `src/tui/renderer.js` 的 `printLines()` —— 唯一用途是贴图片预览块，已无调用方

**修改**
| 文件 | 核心改动 |
| --- | --- |
| `src/tui/input.js` | 删预览状态 `dpreview`/`dpreviewLoading`、常量 `PREVIEW_COLS/ROWS`、5 个预览函数；`designOverlay` 改为纯列表（`listRows` 直接用 `maxRows`） |
| `src/tools/generate_image.js` | 去掉生成后的 `previewImage` 调用；工具描述与返回文案不再提「已在终端显示」和 `view_image` |
| `src/utils/chat/chatService.js` | `/asset` 去掉 `previewImage` 调用与 import |
| `src/tools/manager.js` | `ROLE_TOOLS` 的 designer/engineer 去掉 `view_image` |
| `src/utils/logger/logger.js` | 帮助文案：`#图片` 去掉「可预览」、`/asset` 去掉「成品在终端里直接显示」 |
| `src/utils/image/describe.js` | 注释改为「没有任何把图喂给模型的通道」 |
| `src/server/toolServer.js` | 注释改为「generate_image 会往终端打进度」 |
| `src/docs/systemDoc.md` | 删除第 9 条 view_image 使用规范；第 8 条去掉「生成完自动在终端展示」 |
| `src/docs/userContest.md`、`.front/memories/memories.md` | 工具清单去掉 `view_image`，补上 `skill` |
| `test/smoke.mjs` | 工具数量断言 14→13、5→4 |
| `python-fastapi/config/tasks.yaml` | 步骤 1 改为「agent 看不到设计图，设计说明是唯一依据」 |
| `python-fastapi/config/agent.yaml` | 工具数量与清单注释同步（designer 4 / engineer 13） |
| `python-fastapi/node_tools.py`、`runner.py` | 注释里 `view_image` 的引用去掉 |
| `python-fastapi/test_loop.py` | 原「任务书没让 agent 用 view_image 看图」已失效，改为断言任务书交代了「看不到设计图、以设计说明为唯一依据」 |
| `python-fastapi/需求规划.md` | D1 结论、§4.2 工具表、§14.3 连带修正、工程师步骤表 2 同步 |
| `package.json` | 新增 script `test:overlay` |

依赖未变：`sharp` 仍被 `diffReport.js` 使用，`string-width` 仍被 `renderer.js` 使用。

## 任务结果

**已完成**，测试全绿：`npm run smoke`、`npm run test:input`、`npm run test:overlay` 均「全部通过」；
`src/**/*.js` 38 个模块全部可导入；`tasks.yaml` / `agent.yaml` 用项目 venv 的 pyyaml 解析通过，
三个改动的 Python 文件 `py_compile` 通过。

**遗留与说明**
- 未做真机 TUI 手工验证（`npm start` 需交互式 TTY，当前环境无法驱动）；`#` 浮层的无头测试覆盖了
  进入浮层 / 滚动 / 过滤 / 回车插入 / Esc 取消五条路径，但真机观感仍建议起一次 `npm start` 确认。
- `python-fastapi/需求规划.md` 中带日期标注的实测叙述（§13 token 实测修正、§14.1 硬伤一）
  仍引用 `view_image`，作为当时的设计决策记录**有意保留**，未改写历史结论。
- 已废弃的 `python-fastapi/__pycache__/*.pyc` 未手动删除（源码 mtime 变了，Python 会自动重编）。
- 未提交 git（工作区本来就有大量其它未提交改动）。
