# -*- coding: utf-8 -*-
"""读 config/agent.yaml + config/tasks.yaml，组装 CrewAI 的 Agent / Task / Crew。

**一个任务一个 Crew。** 两个任务不靠 CrewAI 的 sequential 串起来，原因有三：

1. 两个任务的模型不同（设计师走 qwen-image 那套、工程师走 qwen3.8-flash），
   一次 kickoff 共享一个 LLM 反而不好配；
2. 阶段之间要停下来让用户确认（设计稿认不认可），单次 kickoff 里插不进人工等待；
3. D4 定的是「Node 侧确定性判定」—— 跑哪些阶段、要不要重跑，由 Node 决定，
   不该交给 CrewAI 的流程编排去猜。

任务描述里的 {xxx} 是 kickoff(inputs=...) 的占位符。CrewAI 在 kickoff 时才做替换，
缺参数会抛异常，所以这里提供 required_inputs() 让调用方**提前**核对并给出明确报错。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml
from crewai import Agent, Crew, Task

from llm_factory import get_llm
from node_tools import DEFAULT_NODE_URL, build_tools

CONFIG_DIR = Path(__file__).resolve().parent / "config"
AGENT_FILE = CONFIG_DIR / "agent.yaml"
TASK_FILE = CONFIG_DIR / "tasks.yaml"

# 与 CrewAI 内部 _VARIABLE_PATTERN 保持一致的占位符写法
PLACEHOLDER = re.compile(r"\{([A-Za-z_]\w*)\}")


class ConfigError(Exception):
    """配置文件本身有问题（缺字段、引用不存在的 agent 等）。"""


class MissingInput(ConfigError):
    """kickoff 缺少任务描述里要用的占位符。"""


def _load(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise ConfigError(f"配置文件不存在：{path}")
    with path.open(encoding="utf-8") as f:
        data = yaml.safe_load(f)
    if not isinstance(data, dict) or not data:
        raise ConfigError(f"配置文件为空或格式不对：{path}")
    return data


def agent_specs() -> dict[str, dict]:
    return _load(AGENT_FILE)


def task_specs() -> dict[str, dict]:
    return _load(TASK_FILE)


def _spec(specs: dict[str, dict], key: str, kind: str) -> dict:
    if key not in specs:
        raise ConfigError(f"{kind} 「{key}」不存在，可用：{', '.join(specs)}")
    return specs[key]


def required_inputs(task_key: str) -> list[str]:
    """任务描述 + 交付期望里用到的占位符，按出现顺序去重。"""
    spec = _spec(task_specs(), task_key, "任务")
    out: list[str] = []
    for text in (spec.get("description") or "", spec.get("expected_output") or ""):
        for name in PLACEHOLDER.findall(text):
            if name not in out:
                out.append(name)
    return out


def _check_inputs(task_key: str, inputs: dict[str, Any]) -> None:
    need = required_inputs(task_key)
    missing = [n for n in need if n not in inputs]
    if missing:
        raise MissingInput(
            f"任务「{task_key}」缺少入参 {missing}（需要：{need}）"
        )


def build_agent(agent_key: str, node_url: str = DEFAULT_NODE_URL, model: str | None = None) -> Agent:
    """按 agent.yaml 建一个 Agent，工具从 Node 按其 tool_role 取。"""
    spec = _spec(agent_specs(), agent_key, "Agent")
    role_key = spec.get("tool_role")
    if not role_key:
        raise ConfigError(f"Agent 「{agent_key}」没配 tool_role，拿不到任何工具")

    return Agent(
        role=spec["role"],
        goal=spec["goal"],
        backstory=spec.get("backstory") or "",
        llm=get_llm(model),
        tools=build_tools(node_url, role_key),
        max_iter=int(spec.get("max_iter") or 25),
        # 不开启委派：本项目的分工由 Node 决定（D4），agent 之间不该互相派活，
        # 开着会多出一层 LLM 决策，白烧 token 且行为不可预测
        allow_delegation=False,
        # 关掉逐条推理过程打印：终端所有权在 Node 手里，这里每行输出都会污染 TUI
        verbose=False,
    )


@dataclass
class CrewRun:
    """一次待执行的 kickoff：Crew 已经组装好，入参已核对过。"""

    task_key: str
    crew: Crew
    inputs: dict[str, Any] = field(default_factory=dict)

    def kickoff(self) -> Any:
        return self.crew.kickoff(inputs=self.inputs)


def build_run(
    task_key: str,
    node_url: str = DEFAULT_NODE_URL,
    model: str | None = None,
    **inputs: Any,
) -> CrewRun:
    """组装「一个任务 + 它的 agent」的一次运行，入参先核对再返回。"""
    _check_inputs(task_key, inputs)

    spec = _spec(task_specs(), task_key, "任务")
    agent = build_agent(spec.get("agent") or "", node_url, model)

    task = Task(
        description=spec["description"],
        expected_output=spec["expected_output"],
        agent=agent,
        # 单任务 Crew 用不上 context；留字段是为了将来真要串任务时不用改结构
        context=None,
    )

    crew = Crew(
        agents=[agent],
        tasks=[task],
        # 不开 planning / memory：两者都会额外调 LLM 或向量库，
        # 在 15000 token 的预算下属于纯开销
        planning=False,
        memory=False,
        verbose=False,
    )
    return CrewRun(task_key=task_key, crew=crew, inputs=dict(inputs))
