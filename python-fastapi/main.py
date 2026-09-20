# -*- coding: utf-8 -*-
"""FastAPI 入口：Node 拉起本服务，把 crew 编排交给 Python。

端点分两类：
  探查类  GET  /health /tools /llm          —— 查链路通不通、工具与上下文长什么样
  运行类  POST /run                          —— 起一次 crew，立刻返回 runId
          GET  /run/{id}/events              —— SSE 推进度（Node 拿它渲染 TUI）
          POST /run/{id}/abort               —— 终止
          POST /run/{id}/retry               —— 从指定任务重跑

启动：python-fastapi/.venv/Scripts/python.exe -m uvicorn main:app --port <port>
（由 Node 负责拉起，端口与 NODE_TOOL_URL 通过环境变量传入）
"""

import json  # noqa: E402
import time  # noqa: E402

import bootstrap  # noqa: F401  —— 必须最先导入，见模块内说明

bootstrap.force_utf8_output()

from fastapi import FastAPI, Query, Request  # noqa: E402
from fastapi.concurrency import run_in_threadpool  # noqa: E402
from fastapi.responses import JSONResponse, StreamingResponse  # noqa: E402

import node_tools  # noqa: E402
from runner import Runner, RunError  # noqa: E402

app = FastAPI(title="front crew service", version="0.1.0")

runner = Runner(node_tools.DEFAULT_NODE_URL)

# SSE 流的兜底时长上限。运行本身有 9 分钟上限，这里留足余量；
# 主要是防止客户端断开后生成器一直挂着不回收
SSE_MAX_SECONDS = 20 * 60


@app.get("/health")
def health() -> dict:
    """Node 侧探活，同时也把当前认识的工具服务地址报回去，方便排查。"""
    return {"ok": True, "nodeToolUrl": node_tools.DEFAULT_NODE_URL}


@app.get("/tools")
def list_tools(role: str | None = None) -> JSONResponse:
    """透传 Node 的工具清单。按角色裁剪时带 ?role=engineer|designer。"""
    try:
        return JSONResponse({"ok": True, "tools": node_tools.fetch_manifests(role=role)})
    except Exception as e:  # noqa: BLE001 —— Node 工具服务没起来时给出明确原因
        return JSONResponse(status_code=502, content={"ok": False, "error": str(e)})


@app.get("/llm")
def llm_info() -> JSONResponse:
    """确认 LLM 能按 .front/setting.json 构造出来。

    ⚠️ 只许取具体标量字段。LLM 是 dataclass，打印对象本身/属性/bound method 都会
    把完整 api_key 一起 dump 出来（本项目已因此泄漏两次）。
    """
    from llm_factory import ConfigError, get_llm

    try:
        llm = get_llm()
        return JSONResponse(
            {"ok": True, "model": llm.model, "provider": getattr(llm, "provider", None),
             "baseUrl": getattr(llm, "base_url", None)}
        )
    except ConfigError as e:
        return JSONResponse(status_code=400, content={"ok": False, "error": str(e)})
    except Exception as e:  # noqa: BLE001
        return JSONResponse(status_code=500, content={"ok": False, "error": str(e)})


# ---------------------------- 运行控制 ----------------------------


@app.post("/run")
async def start_run(req: Request) -> JSONResponse:
    """起一次运行，立刻返回 runId；进度走 /run/{id}/events。

    body: { mode: "team"|"engineer", userInput, designImage?, cwd?, sessionId? }
    """
    body = await req.json()
    try:
        state = runner.start(
            mode=body.get("mode") or "team",
            user_input=body.get("userInput") or "",
            design_image=body.get("designImage"),
            cwd=body.get("cwd"),
        )
    except RunError as e:
        return JSONResponse(status_code=400, content={"ok": False, "error": str(e)})
    return JSONResponse({"ok": True, "runId": state.id, "mode": state.mode})


@app.get("/run/{run_id}/events")
def run_events(run_id: str, from_: int = Query(0, alias="from")) -> StreamingResponse:
    """SSE 事件流。

    事件是追加式的且带 seq，所以断线重连时带 ?from=<seq> 就能续上，
    不用从头重看（TUI 重连用得上）。`from` 是 Python 关键字，故用 alias。
    """
    state = runner.get(run_id)
    if not state:
        return JSONResponse(status_code=404, content={"ok": False, "error": "没有这个运行"})

    def stream():
        cursor = max(0, from_)
        deadline = time.time() + SSE_MAX_SECONDS
        while True:
            batch = state.since(cursor)
            for ev in batch:
                cursor = ev["seq"] + 1
                yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
                if ev["kind"] == "end":
                    return
            # 「结束了」不等于「end 事件已经发过了」：
            # 终止时状态立刻变 aborted，但工作线程要跑完当前那次 LLM 调用才收手
            # （实测 5.7~7.9s，慢的时候更久），中间这段没有新事件。
            # 只按 finished 收流的话，客户端会漏掉 end，以为连接意外断了。
            # sealed 是工作线程 finally 里发的，看到它才说明事件序列真的定型了。
            if state.sealed and not batch:
                return
            if time.time() > deadline:
                yield 'data: {"kind":"timeout","text":"事件流超时关闭"}\n\n'
                return
            # 心跳：让中间的代理/浏览器知道连接还活着
            yield ": ping\n\n"

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/run/{run_id}/abort")
async def abort_run(run_id: str) -> JSONResponse:
    """终止运行。用户立刻拿回控制权，工作线程在下一个工具边界收手。"""
    if not runner.get(run_id):
        return JSONResponse(status_code=404, content={"ok": False, "error": "没有这个运行"})
    return JSONResponse({"ok": runner.abort(run_id)})


@app.post("/run/{run_id}/retry")
async def retry_run(run_id: str, req: Request) -> JSONResponse:
    """从指定任务重跑。body: { fromTask? }，缺省最后一个阶段。

    粒度是任务级：CrewAI 没有任务内部的断点续跑，「改→截→比」整个活在一次 kickoff 里。
    """
    if not runner.get(run_id):
        return JSONResponse(status_code=404, content={"ok": False, "error": "没有这个运行"})
    try:
        body = await req.json()
    except Exception:  # noqa: BLE001 —— body 可以为空
        body = {}
    try:
        # retry 可能先等上一次的工作线程收手（最多 20s），是阻塞操作，
        # 必须丢到线程池里跑，不能卡住事件循环
        state = await run_in_threadpool(runner.retry, run_id, body.get("fromTask"))
    except RunError as e:
        return JSONResponse(status_code=400, content={"ok": False, "error": str(e)})
    return JSONResponse({"ok": True, "runId": state.id, "status": state.status})
