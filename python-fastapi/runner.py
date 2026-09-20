# -*- coding: utf-8 -*-
"""一次 crew 运行的生命周期：起线程跑 kickoff、发进度事件、支持终止与重跑。

## 为什么是「工作线程 + 事件流」而不是直接同步返回

kickoff() 是阻塞的，一次跑 5~8 分钟（文生图单次就 100s），HTTP 请求扛不住。
所以 POST /run 立刻返回 runId，进度通过 GET /run/{id}/events 的 SSE 推给 Node，
由 Node 渲染进 TUI。

## 终止为什么是「标记 + 不再等待」

CrewAI 1.15 没有可用的中途打断手段，两条路都堵死（实测，见 node_tools.ABORT_HOOK 的注释）。
所以终止做成两段：
  1. **立刻**：标记状态为 aborted，SSE 立刻把终止事件推给 Node，用户马上拿回控制权；
  2. **收尾**：工作线程在下一个**工具调用边界**看到标记，返回一句让模型收手的话，
     循环很快自己结束。在此之前它可能还要跑完当前这次 LLM 调用。
代价是当前这次 LLM 调用白花，换来的是用户不用等满 5 分钟。

## 同一时刻只允许一个运行

工具里有 process.chdir（Node 侧的 runInCwd），两个运行并行会互相串工作目录。
TUI 侧本来就是 busy 状态，这里再加一道服务端保险。
"""

from __future__ import annotations

import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from typing import Any

import node_tools
from crew_builder import build_run
from node_tools import LAST_RESULTS

# 单次 crew 的时间上限（§10 第 7 条：9 分钟）
RUN_TIMEOUT = 9 * 60

# 各模式要跑的阶段。顺序即执行顺序。
PHASES: dict[str, list[str]] = {
    "team": ["Design_frontend_page", "Implement_frontend_page"],
    "engineer": ["Implement_frontend_page"],
}

# 用户没给保存路径时占位符填什么。填空串会让提示词里出现一个空区块，
# 这里给一句明确的指示，让 agent 知道该去问用户
SAVE_PATH_UNSET = "（本次未指定，你必须先用 confirm/select 工具向用户问明保存路径再开工）"


class RunError(Exception):
    """运行无法开始（入参不对、上一步没产出设计图等）。"""


@dataclass
class RunState:
    """一个运行的完整状态。events 是追加式的事件日志，SSE 按游标读。"""

    id: str
    mode: str
    inputs: dict[str, Any]
    status: str = "pending"  # pending|running|done|failed|aborted
    phase: str | None = None
    error: str | None = None
    result: str | None = None
    usage: dict[str, Any] = field(default_factory=dict)
    started_at: float = field(default_factory=time.time)
    cwd: str | None = None

    _events: list[dict] = field(default_factory=list)
    _cond: threading.Condition = field(default_factory=threading.Condition)
    _abort: threading.Event = field(default_factory=threading.Event)
    _thread: threading.Thread | None = None
    # 本运行挂在 node_tools.ABORT_HOOK 上的那个函数，收尾时用来确认「清的是自己的」
    _hook: Any = None
    # end 事件是否已经发出。SSE 靠它判断「不可能再有新事件了」——
    # 不能拿「状态已结束」当这个判断：终止时状态立刻变 aborted，
    # 但工作线程还要跑完当前那次 LLM 调用才收手，中间可能隔十几秒
    _sealed: bool = False

    # ---- 事件 ----

    def emit(self, kind: str, **payload: Any) -> None:
        with self._cond:
            self._events.append(
                {"seq": len(self._events), "kind": kind, "phase": self.phase, **payload}
            )
            self._cond.notify_all()

    def since(self, cursor: int, timeout: float = 15.0) -> list[dict]:
        """取 cursor 之后的事件；没有就等到 timeout（用来给 SSE 做心跳间隔）。"""
        with self._cond:
            if len(self._events) <= cursor:
                self._cond.wait(timeout)
            return self._events[cursor:]

    @property
    def finished(self) -> bool:
        return self.status in ("done", "failed", "aborted")

    @property
    def sealed(self) -> bool:
        """end 已发过 = 这个运行的整个事件序列已经定型，不会再有新的了。"""
        return self._sealed

    def seal(self) -> None:
        """补发 end 并封口。只有工作线程的 finally 该调它。"""
        with self._cond:
            self._events.append(
                {"seq": len(self._events), "kind": "end", "phase": self.phase, "status": self.status}
            )
            self._sealed = True
            self._cond.notify_all()

    # ---- 状态变更 ----

    def _set(self, status: str, **payload: Any) -> None:
        # 终止是终态，优先级最高：工作线程可能在用户点了终止之后才跑到
        # "done"/"failed"，那种迟到的状态不能把 aborted 覆盖掉，
        # 否则 TUI 会在用户已经看到「已终止」之后又跳回成功
        if self.status == "aborted":
            return
        self.status = status
        self.emit("status", status=status, **payload)

    def request_abort(self) -> bool:
        """标记终止。返回 False 表示这个运行已经结束了，不用再标。"""
        if self.finished:
            return False
        self._abort.set()
        self.status = "aborted"
        self.emit("aborted", text="已终止本次运行")
        return True

    @property
    def aborted(self) -> bool:
        return self._abort.is_set()

    def deadline_left(self) -> float:
        return RUN_TIMEOUT - (time.time() - self.started_at)


class Runner:
    """持有所有运行。同一时刻只允许一个在跑。"""

    def __init__(self, node_url: str) -> None:
        self.node_url = node_url
        self._runs: dict[str, RunState] = {}
        self._lock = threading.Lock()

    # ---- 查询 ----

    def get(self, run_id: str) -> RunState | None:
        return self._runs.get(run_id)

    @property
    def active(self) -> RunState | None:
        with self._lock:
            for st in self._runs.values():
                if not st.finished:
                    return st
        return None

    # ---- 启动 ----

    def start(self, mode: str, user_input: str, design_image: str | None, cwd: str | None) -> RunState:
        if mode not in PHASES:
            raise RunError(f"未知的 mode：{mode}（可选：{', '.join(PHASES)}）")
        if not user_input or not user_input.strip():
            raise RunError("userInput 不能为空")
        if mode == "engineer" and not design_image:
            raise RunError("mode=engineer 时必须给 designImage")

        busy = self.active
        if busy:
            raise RunError(f"已有运行在进行中（{busy.id}），请先终止或等它结束")

        inputs = {
            "requirement": user_input.strip(),
            # 工程师阶段才用得上；设计师阶段填了也无害（它的描述里没有这个占位符）
            "design_image_path": design_image or "",
            "save_path": SAVE_PATH_UNSET,
        }
        state = RunState(id=uuid.uuid4().hex[:12], mode=mode, inputs=inputs, cwd=cwd)
        with self._lock:
            self._runs[state.id] = state

        state.emit("start", mode=mode, cwd=cwd)
        state._thread = threading.Thread(
            target=self._work, args=(state, cwd), name=f"run-{state.id}", daemon=True
        )
        state._thread.start()
        return state

    # ---- 工作线程 ----

    def _work(self, state: RunState, cwd: str | None) -> None:
        # 工具边界上的终止检查（见 node_tools.ABORT_HOOK）
        self._install_hook(state)

        try:
            state._set("running")
            for phase in PHASES[state.mode]:
                if state.aborted:
                    return
                if state.deadline_left() <= 0:
                    raise RunError(f"超过时间上限 {RUN_TIMEOUT // 60} 分钟，已停止")
                self._run_phase(state, phase, cwd)
            # 被终止的阶段不能落到 done：_run_phase 已经发了 phase_aborted，
            # 这里再标 done 的话 TUI 会在「已终止」之后又收到一个成功终态。
            # 单阶段模式下循环会自然结束、走不到下一轮开头的 aborted 检查，所以这里必须兜一次。
            # 生产路径上 request_abort 已经把 status 置为 aborted、_set 会 no-op；
            # 显式兜底是为了不依赖「谁先置状态」这种隐式约定。
            if state.aborted:
                state._set("aborted")
                return
            state.result = self._final_text(state)
            state._set("done", usage=state.usage)
        except RunError as e:
            state.error = str(e)
            state._set("failed", error=str(e))
        except Exception as e:  # noqa: BLE001 —— 任何异常都要变成事件，不能只躺在日志里
            state.error = f"{type(e).__name__}: {e}"
            state._set("failed", error=state.error, detail=traceback.format_exc()[-1200:])
        finally:
            self._clear_hook(state)
            # 唤醒所有还在等的 SSE 连接，让它们看到终态后收尾
            state.seal()

    def _install_hook(self, state: RunState) -> None:
        """挂上终止检查钩子。ABORT_HOOK 是模块级全局量，所以必须记住自己挂的是哪个，
        收尾时只清自己的 —— 否则「终止后立刻重跑」会让旧线程的 finally
        把新线程刚挂上的钩子清掉（删掉别人的东西）。"""
        hook = lambda: state.aborted or state.deadline_left() <= 0  # noqa: E731
        node_tools.ABORT_HOOK = hook
        state._hook = hook

    def _clear_hook(self, state: RunState) -> None:
        if node_tools.ABORT_HOOK is getattr(state, "_hook", None):
            node_tools.ABORT_HOOK = None

    def _run_phase(self, state: RunState, phase: str, cwd: str | None) -> None:
        state.phase = phase
        state.emit("phase_start", task=phase)

        if phase == "Implement_frontend_page" and state.mode == "team":
            state.inputs["design_image_path"] = self._design_from_last_run(state)

        # 工程师阶段：先把设计图转成文字说明，再注入任务。
        # agent 看不到图（工具结果只能是字符串，没有把图喂给模型的通道），
        # 没有这段说明它就只能凭想象还原，而任务书明写着「不要凭想象还原」。
        if phase == "Implement_frontend_page":
            state.inputs["design_description"] = self._describe_design(state)

        run = build_run(phase, node_url=self.node_url, **state.inputs)
        # cwd 目前只用于日志与将来传给工具；工具服务侧的 cwd 由 Node 决定
        state.emit("phase_kickoff", task=phase, cwd=cwd)

        result = run.crew.kickoff(inputs=run.inputs)

        state.usage[phase] = _usage_of(result)
        # 终止后 kickoff 仍会正常返回（模型看到「已终止」后自己收的尾），
        # 那个结果不能当成「这一阶段做完了」报给用户，否则 TUI 会在
        # 「已终止」之后又显示一个绿色的阶段完成
        if state.aborted:
            state.emit("phase_aborted", task=phase, usage=state.usage[phase])
            return

        state.emit(
            "phase_done",
            task=phase,
            text=_text_of(result)[:4000],
            usage=state.usage[phase],
        )

    def _describe_design(self, state: RunState) -> str:
        """设计图 -> 文字说明。拿不到时给一段明确的降级说明，绝不静默留空。

        这里不抛异常中断运行：视觉调用失败（没配 key、图太大、网络抖）时，
        工程师靠着需求文字 + imugi_compare 的差异报告仍能干活，只是会慢一些。
        但必须让它**知道**自己没有设计说明，否则它会当成「本来就没有」而凭想象写。
        """
        path = state.inputs.get("design_image_path") or ""
        if not path:
            reason = "本次没有提供设计图路径"
        else:
            state.emit("describe_start", path=path)
            try:
                text = node_tools.fetch_design_description(path, self.node_url, state.cwd)
                state.emit("describe_done", path=path, chars=len(text))
                return text
            except node_tools.DescribeError as e:
                reason = str(e)

        state.emit("describe_failed", path=path, error=reason)
        return (
            f"（本次未能自动生成设计说明：{reason}）\n"
            "你必须在没有设计说明的情况下工作：先把需求里能确定的部分做扎实，"
            "之后每一轮都靠 imugi_compare 返回的像素对比报告逐步逼近设计稿，"
            "不要臆造需求里没有的配色与元素。"
        )

    def _design_from_last_run(self, state: RunState) -> str:
        """设计阶段的产出。从 generate_image 的结构化返回里取，不去解析中文。"""
        res = LAST_RESULTS.get("generate_image") or {}
        path = (res.get("data") or {}).get("path")
        if not path:
            raise RunError(
                "设计阶段结束，但没拿到设计图路径 —— 设计师可能没调用 generate_image，"
                "或调用失败了。请查看上方设计师阶段的输出。"
            )
        state.emit("design_ready", path=path)
        return path

    def _final_text(self, state: RunState) -> str:
        for ev in reversed(state._events):
            if ev["kind"] == "phase_done":
                return ev.get("text") or ""
        return ""

    # ---- 终止 / 重跑 ----

    def abort(self, run_id: str) -> bool:
        state = self._runs.get(run_id)
        return bool(state and state.request_abort())

    def retry(self, run_id: str, from_task: str | None) -> RunState:
        """从指定任务重跑。

        粒度就是**任务**：一个任务一个 Crew，CrewAI 没法在任务内部断点续跑
        （「改→截→比」那个循环整个活在一次 kickoff 里）。所以 `from_task`
        只能取 PHASES 里的阶段名，缺省是最后一个。
        """
        state = self._runs.get(run_id)
        if not state:
            raise RunError(f"没有这个运行：{run_id}")
        if not state.finished:
            raise RunError("该运行还在进行中，请先终止再重跑")

        # 终止是异步收尾的：状态已变 aborted，但工作线程可能还在跑完当前那次 LLM 调用。
        # 这时如果直接起新线程，同一个 state 上就会有两个 crew 在跑 ——
        # 而且 retry 会把 _abort 换成新的 Event，旧线程从此看不到终止标记，永远停不下来。
        # 工具里还有 process.chdir，两个运行并行会互相串工作目录。
        # 所以先等它收手；等不到就明确拒绝，不要偷偷并跑。
        self._join_worker(state, timeout=20.0)

        phases = PHASES[state.mode]
        target = from_task or phases[-1]
        if target not in phases:
            raise RunError(f"fromTask「{target}」不在本次的阶段里：{', '.join(phases)}")

        # 重跑意味着要再占一次运行名额，直接复用原状态、重新起线程。
        # 时钟必须重置：deadline 是从 started_at 算的，不清掉的话
        # 「第一轮跑了 9 分钟 → 点重跑」会立刻撞上限
        state._abort = threading.Event()
        # 封口标记也要一起复位：它记的是「上一轮的 end 已发」，重跑后要重新等新线程发。
        # 不复位的话，新的一轮只要连续 15s 没有事件（一次 LLM 调用就够），
        # SSE 就会以为事件序列已定型而提前收流。
        state._sealed = False
        state.status = "pending"
        state.started_at = time.time()
        state.error = None
        state.result = None
        state.phase = None
        state.emit("retry", task=target)

        # 从 target 开始往后跑
        remaining = phases[phases.index(target) :]
        state._thread = threading.Thread(
            target=self._work_from, args=(state, remaining), name=f"retry-{state.id}", daemon=True
        )
        state._thread.start()
        return state

    @staticmethod
    def _join_worker(state: RunState, timeout: float) -> None:
        """等上一次的工作线程收手。还在跑就抛错，绝不并跑。"""
        thread = state._thread
        if thread and thread.is_alive():
            thread.join(timeout=timeout)
        if thread and thread.is_alive():
            raise RunError(
                f"上一次运行还在收尾（已等 {timeout:.0f}s），请稍后再重跑。"
                "CrewAI 无法从外部打断 kickoff，终止要等当前这次 LLM 调用跑完才生效。"
            )

    def _work_from(self, state: RunState, remaining: list[str]) -> None:
        self._install_hook(state)
        try:
            state._set("running")
            for phase in remaining:
                if state.aborted:
                    return
                if state.deadline_left() <= 0:
                    raise RunError(f"超过时间上限 {RUN_TIMEOUT // 60} 分钟，已停止")
                self._run_phase(state, phase, state.cwd)
            # 同 _work：被终止的阶段不能落到 done
            if state.aborted:
                state._set("aborted")
                return
            state.result = self._final_text(state)
            state._set("done", usage=state.usage)
        except RunError as e:
            state.error = str(e)
            state._set("failed", error=str(e))
        except Exception as e:  # noqa: BLE001
            state.error = f"{type(e).__name__}: {e}"
            state._set("failed", error=state.error, detail=traceback.format_exc()[-1200:])
        finally:
            self._clear_hook(state)
            state.seal()


def _text_of(result: Any) -> str:
    """CrewOutput -> 文本。取 .raw 最准，退化时用 str()。"""
    return str(getattr(result, "raw", None) or result)


def _usage_of(result: Any) -> dict[str, Any]:
    """token 用量。拿不到就返回空字典 —— 用量只是观测数据，不该因为它失败而中断运行。"""
    usage = getattr(result, "token_usage", None)
    if usage is None:
        return {}
    if hasattr(usage, "model_dump"):
        return usage.model_dump()
    return dict(usage) if isinstance(usage, dict) else {"value": str(usage)}
