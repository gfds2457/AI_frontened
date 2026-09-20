# -*- coding: utf-8 -*-
"""Python 侧的启动前置设置。任何入口都应**最先**导入本模块。

本服务由 Node 拉起，**终端所有权在 Node 手里**。所以 Python 侧有一条硬规则：

    永远不读 stdin，永远不弹交互提示。

违反了要么读不到（stdin 是管道），要么跟 TUI 抢输入（stdin 是终端）。CrewAI 里
会读 stdin 的功能，逐个关掉：

1. **执行轨迹（tracing）的首次询问** —— 用 CREWAI_TRACING_ENABLED=false 关掉。
   它的询问只在 stdin 是 TTY 时触发，但 Node 用管道拉起时不该赌这个判断；
   而且即便判定为非交互，也可能白等 20 秒超时。
   位置：crewai/events/listeners/tracing/utils.py
2. **Task(human_input=True)** —— 本项目禁用。人工确认一律走 Node 的 confirm / select 工具。
3. **Flow 的人工反馈**（flow/input_provider.py、flow/async_feedback/）—— 未使用，后续也别启用。
4. **llm_hooks / tool_hooks / crew_chat** —— 未使用。
"""

from __future__ import annotations

import os
import sys

# 关掉 tracing 询问（必须在任何 Crew.kickoff 之前生效；它在调用时读环境变量）
os.environ.setdefault("CREWAI_TRACING_ENABLED", "false")

# 输出编码：Windows 中文控制台默认 GBK，日志里带中文/emoji 会 UnicodeEncodeError。
# 这两项管的是子进程环境，进程内的 stdout 由 force_utf8_output() 兜底。
os.environ.setdefault("PYTHONIOENCODING", "utf-8")
os.environ.setdefault("PYTHONUTF8", "1")


def force_utf8_output() -> None:
    """把已创建的标准输出流切成 UTF-8。

    os.environ 只影响之后创建的子进程，改不了当前进程已经建好的 stdout；
    Node 读我们的输出管道时按 UTF-8 解码，所以这里必须显式切一次。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001 —— 流被重定向成不支持 reconfigure 的对象时忽略
            pass
