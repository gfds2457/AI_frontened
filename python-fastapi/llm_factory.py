# -*- coding: utf-8 -*-
"""按 .front/setting.json 构造 CrewAI 的 LLM。

CrewAI 1.15 内置 dashscope provider（见 crewai/llms/providers/openai_compatible），
直接吃阿里云 compatible-mode 端点，实测 is_litellm=False —— 不走 LiteLLM，
因此没有模型名前缀 / 大小写的坑。私有 MaaS 端点通过 base_url 参数覆盖。

API Key 只从这一份配置读，避免 Node 与 Python 两处维护密钥。
"""

from __future__ import annotations

import json
import pathlib

from crewai import LLM

# python-fastapi/ 的上一级就是项目根
ROOT = pathlib.Path(__file__).resolve().parent.parent
SETTING_PATH = ROOT / ".front" / "setting.json"


class ConfigError(RuntimeError):
    """配置缺失或非法时抛出，由调用方转成给用户看的错误信息。"""


def load_setting() -> dict:
    try:
        cfg = json.loads(SETTING_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ConfigError(f"找不到配置文件：{SETTING_PATH}")
    except json.JSONDecodeError as e:
        raise ConfigError(f"配置文件不是合法 JSON：{SETTING_PATH} -> {e}")
    _export_env(cfg)
    return cfg


def _export_env(cfg: dict) -> None:
    """把端点与密钥同步到环境变量。

    我们给 LLM 显式传了 base_url / api_key，正常路径用不到环境变量。但 CrewAI 内部
    有几条分支会绕过显式参数、退回到「按 provider 名去环境里找」——dashscope 的
    约定名是 DASHSCOPE_API_KEY / DASHSCOPE_BASE_URL（见
    crewai/llms/providers/openai_compatible/completion.py 的 OPENAI_COMPATIBLE_PROVIDERS，
    其 base_url 默认值是公网的 dashscope-intl）。

    实测曾出现一次 `Failed to connect to OpenAI API` —— 即某个内部调用退回到了默认
    端点。补上这两个环境变量后，无论走哪条分支都能落回用户配的私有 MaaS 端点。
    用 setdefault：已经有值就不覆盖，留出用环境变量临时改端点的余地。
    """
    import os

    if cfg.get("apiKey"):
        os.environ.setdefault("DASHSCOPE_API_KEY", cfg["apiKey"])
    if cfg.get("baseURL"):
        os.environ.setdefault("DASHSCOPE_BASE_URL", cfg["baseURL"])


# 同名模型复用同一实例：CrewAI 会在每个 agent 上各建一次 LLM，
# 缓存可以省掉重复的客户端构造
_cache: dict[str, LLM] = {}


def get_llm(model: str | None = None) -> LLM:
    """取一个 CrewAI LLM。缺省用 setting.json 里的 model。"""
    cfg = load_setting()
    name = model or cfg.get("model")
    if not name:
        raise ConfigError("setting.json 里没有配置 model")
    if not cfg.get("apiKey"):
        raise ConfigError("setting.json 里没有配置 apiKey")
    if name in _cache:
        return _cache[name]
    llm = LLM(
        model=f"dashscope/{name}",
        base_url=cfg.get("baseURL"),
        api_key=cfg.get("apiKey"),
    )
    _cache[name] = llm
    return llm
