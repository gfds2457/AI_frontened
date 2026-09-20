# -*- coding: utf-8 -*-
"""HTTP/SSE 端到端测试：真的起一个 uvicorn，走真的网络，验真的 SSE 字节流。

为什么单独一个文件、而不是并进 test_loop.py：
test_loop 测的是进程内的对象（Runner、RunState、事件列表），走不到 HTTP 那一层。
这次踩的坑恰恰只在那一层 —— 进程内看事件序列完整（... -> aborted -> phase_aborted -> end），
但客户端收不到 end：SSE 生成器早先按「状态已结束」判断收流，
而终止到工作线程真正收手之间可能隔十几秒，流就提前关了。
所以这里必须用真 socket、真分块、真的 iter_lines。

前置：Node 工具服务在跑（node src/server/start.js 8799）。
真金白银的部分：工程师模式会真的起一次 kickoff（几次 LLM 调用），几秒后就被终止，
所以花不了多少 token —— 终止本身就是要测的东西。
"""
import json
import pathlib
import socket
import subprocess
import sys
import threading
import time

import httpx

HERE = pathlib.Path(__file__).resolve().parent
NODE = "http://127.0.0.1:8799"

ok = 0
bad = 0


def check(name, cond, extra=""):
    global ok, bad
    if cond:
        ok += 1
    else:
        bad += 1
    print(f"{'✅' if cond else '❌'} {name}" + (f" -> {extra}" if extra else ""))


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_health(base: str, timeout: float = 40.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if httpx.get(f"{base}/health", timeout=2.0).status_code == 200:
                return True
        except Exception:  # noqa: BLE001 —— 还没起来，接着等
            time.sleep(0.5)
    return False


PORT = free_port()
BASE = f"http://127.0.0.1:{PORT}"

proc = subprocess.Popen(
    [sys.executable, "-m", "uvicorn", "main:app", "--port", str(PORT), "--log-level", "warning"],
    cwd=str(HERE),
    env={
        **__import__("os").environ,
        "NODE_TOOL_URL": NODE,
        "PYTHONIOENCODING": "utf-8",
        "PYTHONUTF8": "1",
        "CREWAI_TRACING_ENABLED": "false",
    },
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)

try:
    print(f"=========== 起 uvicorn :{PORT} ===========")
    alive = wait_health(BASE)
    check(f"uvicorn 起来了（:{PORT}）", alive)
    if not alive:
        print("💥 服务没起来，后面的测试没法跑")
        sys.exit(1)

    print("\n=========== 1. 探查类端点 ===========")
    h = httpx.get(f"{BASE}/health", timeout=10).json()
    check("/health 通", h.get("ok") is True, str(h))
    tools = httpx.get(f"{BASE}/tools", params={"role": "designer"}, timeout=60).json()
    check("/tools 按角色裁剪", len(tools.get("tools", [])) == 5, f"{len(tools.get('tools', []))} 个")
    llm = httpx.get(f"{BASE}/llm", timeout=30).json()
    check("/llm 能构造出模型", llm.get("ok") is True, f"{llm.get('provider')} / {llm.get('model')}")

    print("\n=========== 2. 未知 runId 一律 404（不能有的 404 有的 400） ===========")
    for method, path, kw in (
        ("GET", "/run/nope/events", {}),
        ("POST", "/run/nope/abort", {}),
        ("POST", "/run/nope/retry", {"json": {}}),
    ):
        r = httpx.request(method, f"{BASE}{path}", timeout=20, **kw)
        check(f"{method} {path} -> 404", r.status_code == 404, f"实际 {r.status_code}")

    print("\n=========== 3. 入参校验 ===========")
    r = httpx.post(f"{BASE}/run", json={"mode": "engineer", "userInput": "x"}, timeout=20)
    check("engineer 缺 designImage -> 400", r.status_code == 400, r.json().get("error", "")[:40])

    print("\n=========== 4. 真起一次运行 + 真 SSE 流 + 中途终止 ===========")
    r = httpx.post(
        f"{BASE}/run",
        json={"mode": "engineer", "userInput": "忽略这条需求，本测试只验证链路", "designImage": "D:/x.png"},
        timeout=20,
    )
    check("POST /run 立刻返回 200", r.status_code == 200, f"实际 {r.status_code}")
    rid = r.json().get("runId")
    check("拿到 runId", bool(rid), str(rid))

    kinds: list[str] = []
    seqs: list[int] = []
    aborted_sent = threading.Event()

    def abort_after_kickoff():
        # 等它真的开始跑（收到 phase_kickoff）再终止，这样测的是「跑起来之后被终止」
        if not aborted_sent.wait(60):
            return
        httpx.post(f"{BASE}/run/{rid}/abort", timeout=20)

    threading.Thread(target=abort_after_kickoff, daemon=True).start()

    t0 = time.time()
    stream_closed = False
    with httpx.stream("GET", f"{BASE}/run/{rid}/events", timeout=180) as resp:
        check("SSE 响应头是 text/event-stream", "text/event-stream" in resp.headers.get("content-type", ""),
              resp.headers.get("content-type", ""))
        for line in resp.iter_lines():
            if not line.startswith("data: "):
                continue  # ": ping" 心跳与空行
            ev = json.loads(line[6:])
            kinds.append(ev["kind"])
            seqs.append(ev["seq"])
            if ev["kind"] == "phase_kickoff":
                aborted_sent.set()
            if ev["kind"] == "end":
                break
    stream_closed = True
    dt = time.time() - t0

    check("SSE 流正常走完（不是超时/报错退出）", stream_closed)
    check("事件 seq 严格递增（断线重连靠它续）", seqs == sorted(set(seqs)) and len(seqs) == len(set(seqs)))
    # 这条就是本次修复的回归断言：进程内事件齐全，不代表客户端收得到。
    # 早先的版本这里只会看到 start -> status -> phase_start -> phase_kickoff -> aborted。
    check("客户端收到 end（SSE 收流条件不能用「状态已结束」）", kinds and kinds[-1] == "end",
          " -> ".join(kinds))
    check("客户端收到 aborted", "aborted" in kinds)
    check("客户端收到 phase_aborted", "phase_aborted" in kinds)
    check("客户端没收到 phase_done", "phase_done" not in kinds)
    check("终止后流在合理时间内关闭", dt < 120, f"耗时 {dt:.1f}s")

    print("\n=========== 5. 断线重连：带 ?from= 续读 ===========")
    last = seqs[-1]
    got = []
    with httpx.stream("GET", f"{BASE}/run/{rid}/events", params={"from": last}, timeout=60) as resp:
        for line in resp.iter_lines():
            if line.startswith("data: "):
                got.append(json.loads(line[6:])["kind"])
            if got and got[-1] == "end":
                break
    check("从末尾游标重连只回 end（不重放历史）", got == ["end"], " -> ".join(got))

    print("\n=========== 6. 重跑 ===========")
    r = httpx.post(f"{BASE}/run/{rid}/retry", json={}, timeout=260)
    check("已终止的运行可以重跑", r.status_code == 200, f"实际 {r.status_code} {r.text[:80]}")
    time.sleep(3)
    httpx.post(f"{BASE}/run/{rid}/abort", timeout=20)

    print("\n=========== 7. 并发保护 ===========")
    r1 = httpx.post(f"{BASE}/run", json={"mode": "engineer", "userInput": "占坑", "designImage": "D:/x.png"}, timeout=20)
    if r1.status_code == 200:
        r2 = httpx.post(f"{BASE}/run", json={"mode": "engineer", "userInput": "并发", "designImage": "D:/x.png"}, timeout=20)
        check("第二个运行被拒（避免 cwd 串台）", r2.status_code == 400, r2.json().get("error", "")[:40])
        httpx.post(f"{BASE}/run/{r1.json()['runId']}/abort", timeout=20)

finally:
    proc.terminate()
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()

print(f"\n{'🎉 全部通过' if bad == 0 else f'💥 {bad} 项失败'}（通过 {ok} / 失败 {bad}）")
sys.exit(0 if bad == 0 else 1)
