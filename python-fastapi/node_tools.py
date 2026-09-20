# -*- coding: utf-8 -*-
"""把 Node 侧的工具动态包装成 CrewAI Tool。

Node 的 GET /tools 返回每个工具的
    { name, description, parameters(JSON Schema), interactive, timeout }
这里据此动态生成 pydantic args_schema 与 Tool 子类；_run 通过 POST /tool/invoke
回调 Node 执行。

为什么是回调而不是在 Python 里重写工具：confirm/select 直接读 stdin、
generate_image 会往终端打进度，**只有持有终端的 Node 进程做得了这些事**。
Python 侧因此完全不碰终端。
"""

from __future__ import annotations

import os
from typing import Any, Callable, Literal

import httpx
from crewai.tools import BaseTool
from pydantic import BaseModel, Field, create_model

# Node 工具服务地址：Node 拉起本服务时用环境变量告知
DEFAULT_NODE_URL = os.environ.get("NODE_TOOL_URL", "http://127.0.0.1:8799")

# 工具执行超时（秒）。非交互工具用 Node 声明的超时再留 30s 余量（含网络往返）；
# 交互工具会一直阻塞到用户作答，给足 30 分钟。
TIMEOUT_MARGIN = 30.0
INTERACTIVE_TIMEOUT = 1800.0

# 工具名 -> 最近一次调用的 {ok, text, data}。
# CrewAI 的 Tool 只能把字符串交给模型，像设计图路径这种结构化结果模型拿不到准；
# 编排逻辑可以从这里取，不必去解析中文。
LAST_RESULTS: dict[str, dict] = {}

# 终止检查钩子：由 runner 在每次运行前挂上，返回 True 表示该运行已被终止。
#
# 为什么要在**工具边界**上做终止：CrewAI 1.15 没有可用的中途打断手段 ——
#   1. Crew.step_callback 是个死字段，全库找不到把它接到 agent 上的代码；
#   2. Agent.step_callback 实测只在最后 AgentFinish 时触发一次，
#      中间调用工具的步骤根本不触发（用「必须调工具才拿得到的随机值」验证过）。
# 而 kickoff() 是阻塞调用，没法从外部中断。所以退而求其次：
# 在每次工具调用前查一次，已终止就返回一句让模型收手的话，让循环尽快自己结束。
# 真正让用户立刻拿回控制权的是 runner 的「标记终止 + 不再等待工作线程」。
ABORT_HOOK: Callable[[], bool] | None = None


def _py_type(spec: dict) -> Any:
    """JSON Schema 片段 -> Python 类型。"""
    enum = spec.get("enum")
    if enum:
        try:
            return Literal[tuple(enum)]  # type: ignore[valid-type]
        except Exception:
            return str
    match spec.get("type"):
        case "string":
            return str
        case "integer":
            return int
        case "number":
            return float
        case "boolean":
            return bool
        case "array":
            return list[_py_type(spec.get("items") or {})]
        case "object":
            return dict
    return Any


def _args_model(tool_name: str, schema: dict) -> type[BaseModel]:
    """按 JSON Schema 生成入参模型，让模型看到明确的参数与类型。"""
    props = schema.get("properties") or {}
    required = set(schema.get("required") or [])
    fields: dict[str, Any] = {}
    for pname, raw in props.items():
        spec = raw or {}
        pytype = _py_type(spec)
        desc = spec.get("description")
        if pname in required:
            fields[pname] = (pytype, Field(..., description=desc))
        else:
            try:
                optional = pytype | None
            except TypeError:
                optional = Any
            # 可选参数默认 None —— 但 _run 里必须把它剔掉：
            # Node 侧是 zod 的 .optional()，只接受 undefined，收到 null 会校验失败
            fields[pname] = (optional, Field(None, description=desc))
    return create_model(f"{tool_name}_args", **fields)


class NodeTool(BaseTool):
    """转发到 Node 工具服务执行的一个 CrewAI Tool。"""

    name: str = ""
    description: str = ""
    args_schema: type[BaseModel] = BaseModel
    node_url: str = DEFAULT_NODE_URL
    tool_timeout: float = 120.0

    def _run(self, **kwargs: Any) -> str:
        if ABORT_HOOK and ABORT_HOOK():
            return "【已终止】本次运行已被用户终止，请立即停止，不要再调用任何工具，直接结束。"
        args = {k: v for k, v in kwargs.items() if v is not None}
        try:
            resp = httpx.post(
                f"{self.node_url}/tool/invoke",
                json={"name": self.name, "args": args},
                timeout=self.tool_timeout,
            )
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:  # noqa: BLE001 —— 工具失败要让模型看到并自行调整，不能中断 crew
            LAST_RESULTS[self.name] = {"ok": False, "text": str(e), "data": None}
            return f"调用工具 {self.name} 失败：{e}"

        LAST_RESULTS[self.name] = {
            "ok": data.get("ok", False),
            "text": data.get("text", ""),
            "data": data.get("data"),
        }
        return data.get("text") or f"（工具 {self.name} 没有返回内容）"


def fetch_manifests(node_url: str = DEFAULT_NODE_URL, role: str | None = None) -> list[dict]:
    """取 Node 侧的工具清单（可按角色裁剪）。"""
    params = {"for": role} if role else None
    resp = httpx.get(f"{node_url}/tools", params=params, timeout=60.0)
    resp.raise_for_status()
    return resp.json()


# 视觉模型读设计图可能要几十秒（实测 32s），给足余量
DESCRIBE_TIMEOUT = 180.0


class DescribeError(Exception):
    """设计说明没拿到（图不存在、没配 key、模型调用失败…）。"""


def fetch_design_description(
    design_path: str, node_url: str = DEFAULT_NODE_URL, cwd: str | None = None
) -> str:
    """请 Node 用视觉模型把设计图转成结构化文字说明。

    为什么不让 Python 自己调视觉模型：设计图的落盘、格式与体积校验都在 Node 侧，
    而且 apiKey/baseURL 的读取口径也只该有一处（Node 的 config.js）。这里只做转发。

    失败一律抛 DescribeError，由调用方决定怎么降级 —— 不能默默返回空串，
    否则工程师会以为「本来就没有设计说明」，转而凭想象写代码。
    """
    if not design_path:
        raise DescribeError("没有设计图路径，无法生成设计说明")
    try:
        resp = httpx.post(
            f"{node_url}/design/describe",
            json={"path": design_path, "cwd": cwd},
            timeout=DESCRIBE_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:  # noqa: BLE001 —— 网络/服务异常统一成 DescribeError
        raise DescribeError(f"调用 Node 生成设计说明失败：{e}") from e

    if not data.get("ok"):
        raise DescribeError(data.get("text") or "Node 侧生成设计说明失败")
    text = (data.get("text") or "").strip()
    if not text:
        raise DescribeError("设计说明为空")
    return text


def build_tools(node_url: str = DEFAULT_NODE_URL, role: str | None = None) -> list[NodeTool]:
    """按角色从 Node 取清单并构造 CrewAI Tool 列表。"""
    tools: list[NodeTool] = []
    for m in fetch_manifests(node_url, role):
        declared = float(m.get("timeout") or 90000) / 1000.0
        tools.append(
            NodeTool(
                name=m["name"],
                description=m.get("description") or m["name"],
                args_schema=_args_model(m["name"], m.get("parameters") or {}),
                node_url=node_url,
                tool_timeout=(
                    INTERACTIVE_TIMEOUT if m.get("interactive") else declared + TIMEOUT_MARGIN
                ),
            )
        )
    return tools
