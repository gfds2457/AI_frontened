# Round-004 任务总结：修复 CrewAI 服务无法启动（Python venv 损坏）

## 本轮任务目标

启动应用时报错：

```
⚠ CrewAI 服务未启动：Python 进程提前退出：ModuleNotFoundError: No module named 'fastapi' (code=1)
```

目标是让 Node 能正常拉起 `python-fastapi/` 编排服务并完成探活，消除该启动失败。

## 执行过程

### 1. 定位阶段（Agent 推理）

先按 Node 侧的解析规则确认解释器路径：`src/server/crewService.js` 的 `DEFAULT_PYTHON_EXE` 指向
`python-fastapi/.venv/Scripts/python.exe`（相对包根解析，支持跨目录启动）。

依次排除，逐步收敛：

| 探测 | 结果 |
| --- | --- |
| 项目根 `.venv` 是否有 fastapi | 无（根 venv 与 crew 服务无关） |
| `python-fastapi/.venv` 是否有 fastapi | 无，但 `Scripts/fastapi.exe` 存在（残留脚本） |
| `pip` 是否可用 | `.venv/Scripts/python.exe -m pip` → `No module named pip` |
| 对照 `requirements.txt` 全量核对 | **33 个发行版完全缺失** |
| 按 `RECORD` 校验已装包文件完整性 | 5 个包文件被部分删除：numpy 缺 1292/1551、setuptools 缺 86/466、crewai-cli 缺 7/190、jsonref 缺 1/9、pymupdf 元数据损坏 |

**结论**：不是「少装一个 fastapi」，而是整个 venv 处于不一致的半损坏状态（dist-info 及包体被删除）。损坏形态呈「按安装顺序的一段连续缺失 + 个别包文件残缺」，符合安装/清理动作被中断的特征。

故障环境：`E:` 盘为 **FAT32**（剩余 22.6GB），venv 体积 967MB。FAT32 无硬链接、写入慢、且对中断写入的容忍度差（此前 lancedb 也因 E 盘 FAT32 无法运行）。

### 2. 修复阶段

复用 venv 内自带的 `uv 0.11.33`（比 pip 快，且不引入外部依赖），全程只动 venv，不改业务源码：

```bash
UV_LINK_MODE=copy .venv/Scripts/uv.exe pip install \
  --python .venv/Scripts/python.exe \
  --reinstall-package setuptools --reinstall-package numpy \
  --reinstall-package jsonref --reinstall-package crewai-cli \
  --reinstall-package pymupdf \
  -r requirements.txt
```

- 结果：`Prepared 36 packages` → `Uninstalled 4` → 安装完成，退出码 0。
- 顺带用 uv 补回了缺失的 `pip` 模块（26.2.1）。

### 3. 二次排障：pkg_resources 缺失

复检发现 **setuptools 仍缺 86 个文件，且与修复前数量、路径完全一致**（全部为 `pkg_resources/` 目录）——属 uv 未释放该模块，而非随机损坏。改用 pip 强制重装补全：

```bash
.venv/Scripts/python.exe -m pip install --force-reinstall --no-deps setuptools==65.5.0
```

### 4. 验证阶段（工具调用记录）

| 验证动作 | 命令/工具 | 结果 |
| --- | --- | --- |
| 全量文件完整性复检 | 自写 Python 脚本遍历 148 个 dist 的 RECORD | **总缺失文件数：0** |
| 关键依赖导入冒烟 | `importlib` 逐个导入 25 个模块 | 24/25 → 补 `pkg_resources` 后全部通过 |
| 服务独立启动探活 | `uvicorn main:app --port 8799` + `curl /health` | 200，`{"ok":true,"nodeToolUrl":...}` |
| **端到端真集成** | `node test/crew-live.mjs`（复用项目已有测试） | **🎉 全部通过**：跨目录解析解释器 → 拉起 uvicorn → `/health` ok → Node↔Python 工具链路取到 35 个 MCP 工具 → 关闭后 pid 与端口均释放 |
| 单元测试回归 | `npx vitest run` | 57 项通过；1 个历史遗留空占位文件报错（见下） |
| 残留进程检查 | `tasklist` | 无残留 `python.exe`，子进程回收干净 |

### 5. 未处理项（历史遗留，非本轮问题）

`test/unit/context.test.js` 仅 102 字节（只有一行 import 占位注释「由 Aider 生成用例」），vitest 报
`No test suite found`。该文件早于本轮存在且未删除——按规范「清理旧的空测试文件」应在下一轮 Aider
生成用例时覆盖或删除，本轮不擅自删改测试文件。

## 文件变更清单

| 类型 | 路径 | 说明 |
| --- | --- | --- |
| 修改（非源码） | `python-fastapi/.venv/`（被 `.gitignore` 的 `**/.venv/` 忽略） | 补装 33 个缺失发行版，重装 setuptools/numpy/jsonref/crewai-cli/pymupdf，补回 pip、pkg_resources |
| 新增 | `Claude_complete/round-004-task-summary.md` | 本轮总结文档 |

**业务源码零改动**（JS/Python 源码、配置、依赖清单均未修改），`git status` 除既有暂存项外无新增改动。

## 在哪耗费最多 Token

在 **venv 损坏范围的探测阶段**。因为「缺 fastapi」只是表象，必须逐层排除才能避免只装一个包就收工：

- 对照 `requirements.txt` 全量核对缺失发行版（33 个）；
- 自写脚本遍历全部 dist 的 `RECORD` 校验文件级完整性——这是唯一能发现 numpy 残缺 1292 个文件这种隐蔽损坏的手段，而它又因 FAT32 慢 I/O 而反复触发多轮等待与日志回读；
- 安装期间为防超时，用 `sleep + tail` 轮询后台日志，每次轮询都产生一次完整往返。

投入换来的收益：避免了「装完 fastapi 后下次再崩在 numpy / pymupdf 上」的反复返工。

## 在哪卡最久

在 **uv 在 FAT32 上的安装阶段（约 25 分钟，占本轮总时长约七成）**，原因是：

1. `E:` 为 FAT32，uv 无法从 C 盘缓存硬链接（`Failed to hardlink files`），只能整文件复制，已显式设 `UV_LINK_MODE=copy`；
2. 纯下载耗时 6 分 46 秒（pyarrow 26.6MB、onnxruntime 13.6MB、numpy 12MB、pillow 6.9MB 等）；
3. 写入阶段 FAT32 小文件开销极高——实测单独安装 1.7MB 的 pip 就耗时 47 秒。

**建议（本轮未执行，需你决策）**：把 venv 迁到 NTFS 盘（如 `D:`）可根治此类损坏与慢 I/O，代价是要调整 `crewService.js` 的 `DEFAULT_PYTHON_EXE` 默认值或改走配置项，涉及安装包对外的目录约定，属产品决策。
