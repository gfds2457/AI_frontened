# -*- coding: utf-8 -*-
"""Node↔Python 闭环测试：Python 从 Node 取工具清单、生成 CrewAI Tool，并真的调起来。

前置：另开一个终端跑 `node src/server/start.js 8799`
"""
import pathlib
import sys
import time

import bootstrap  # noqa: F401  —— 必须最先导入

bootstrap.force_utf8_output()

from node_tools import LAST_RESULTS, build_tools  # noqa: E402

NODE = "http://127.0.0.1:8799"
ROOT = pathlib.Path(__file__).resolve().parent.parent
PKG = str(ROOT / "package.json")

ok = 0
bad = 0


def check(name, cond, extra=""):
    global ok, bad
    if cond:
        ok += 1
    else:
        bad += 1
    print(f"{'✅' if cond else '❌'} {name}" + (f" -> {extra}" if extra else ""))


print("=========== 1. 按角色取清单 + 动态生成 args_schema ===========")
eng = build_tools(NODE, "engineer")
des = build_tools(NODE, "designer")
check("engineer 工具数 = 14", len(eng) == 14, f"{len(eng)} 个")
check("designer 工具数 = 5", len(des) == 5, f"{len(des)} 个")

nav = next(t for t in eng if t.name == "navigate_page")
nav_props = nav.args_schema.model_json_schema()["properties"]
check("navigate_page 的 args_schema 已按 JSON Schema 生成", "type" in nav_props, ", ".join(nav_props))
enum_type = nav.args_schema.model_fields["type"].annotation
check("枚举字段转成了 Literal", "Literal" in str(enum_type), str(enum_type))

conf = next(t for t in eng if t.name == "confirm")
check("交互工具超时被放大到 1800s", conf.tool_timeout == 1800.0, f"{conf.tool_timeout}s")
rf = next(t for t in eng if t.name == "read_file")
check("普通工具超时 = Node 声明值 + 余量", rf.tool_timeout == 120.0, f"{rf.tool_timeout}s")
check("designer 拿不到 read_file", not any(t.name == "read_file" for t in des))

print("\n=========== 2. 直接调用：Python -> HTTP -> Node -> 真工具 ===========")
out = rf._run(filePath=PKG)
check("read_file 成功", LAST_RESULTS["read_file"]["ok"] is True, f"返回 {len(out)} 字符")
check("read_file 内容正确", '"express"' in out)

gl = next(t for t in eng if t.name == "glob")
out2 = gl._run(pattern="src/tools/*.js")
check("glob 成功且命中", "manager.js" in out2, f"返回 {len(out2)} 字符")

print("\n=========== 3. 可选参数必须被剔除（zod .optional 不收 null） ===========")
# glob 的 schema 带可选参数；若 None 被原样发过去，Node 侧 zod 会校验失败
optional_names = [
    n for n, f in gl.args_schema.model_fields.items() if not f.is_required()
]
check("glob 确实有可选参数（该测试才有意义）", len(optional_names) > 0, ",".join(optional_names))
check("省略可选参数调用成功", LAST_RESULTS["glob"]["ok"] is True)

print("\n=========== 4. 工具失败时返回可读错误、不抛异常 ===========")
bad_out = rf._run(filePath="not-absolute")
check("失败被转成文本而非抛异常", isinstance(bad_out, str) and "只能传绝对路径" in bad_out)
check("失败已记录到 LAST_RESULTS", LAST_RESULTS["read_file"]["ok"] is False)

print("\n=========== 5. 真 Agent 全链路（CrewAI 自己决定调工具） ===========")
try:
    from crewai import Agent, Crew, Task

    from llm_factory import get_llm

    agent = Agent(
        role="依赖检查员",
        goal="读取文件并回答问题",
        backstory="你是测试助手，用工具读取文件后如实回答。",
        llm=get_llm(),
        tools=[rf, gl],
        verbose=False,
    )
    task = Task(
        description=f"用 read_file 读取 {PKG}，告诉我 dependencies 里 express 的版本号。只回答版本号。",
        expected_output="express 的版本号，例如 ^5.2.1",
        agent=agent,
    )
    t0 = time.time()
    result = Crew(agents=[agent], tasks=[task], verbose=False).kickoff()
    elapsed = time.time() - t0
    text = str(result)
    check("Agent 调用工具并给出了答案", "5.2.1" in text, text.strip()[:120])
    # 这条查的是「有没有被 tracing 的 stdin 询问卡住 20s」。
    # 门槛给 40s：真实调用本身就要 3~14s（网络抖动下更长），卡在 tracing 上则是
    # 白等 20s 之后再走正常流程。原先写 15s 太贴边 —— 实测跑到过 14.0s，纯属运气，
    # 一旦网络稍慢就会误报成「tracing 有问题」，把注意力引到错的方向。
    check("未出现 tracing 询问（无 20s 空等）", elapsed < 40, f"耗时 {elapsed:.1f}s")
except Exception as e:  # noqa: BLE001
    check("Agent 全链路", False, f"{type(e).__name__}: {e}")

print("\n=========== 6. crew_builder：读 yaml 组装 Agent/Task/Crew ===========")
import re  # noqa: E402

import crew_builder as cb  # noqa: E402

check(
    "设计师任务只需 requirement",
    cb.required_inputs("Design_frontend_page") == ["requirement"],
    str(cb.required_inputs("Design_frontend_page")),
)
eng_need = cb.required_inputs("Implement_frontend_page")
check(
    "工程师任务需要 4 个入参（含设计说明）",
    eng_need == ["requirement", "design_image_path", "design_description", "save_path"],
    str(eng_need),
)
# 设计说明是工程师「看见」设计图的唯一途径（agent 读不了图），占位符漏了就等于把它打回凭想象还原
check("设计说明占位符在任务里", "design_description" in eng_need)

# 缺入参必须在组装阶段就报错，不能拖到 kickoff 时才抛
try:
    cb.build_run("Design_frontend_page", node_url=NODE)
    check("缺入参提前报 MissingInput", False, "竟然没报错")
except cb.MissingInput as e:
    check("缺入参提前报 MissingInput", True, str(e)[:70])
except Exception as e:  # noqa: BLE001
    check("缺入参提前报 MissingInput", False, f"报成了 {type(e).__name__}: {e}")

des_run = cb.build_run("Design_frontend_page", node_url=NODE, requirement="做一个服装电商首页")
des_agent = des_run.crew.agents[0]
check("设计师 agent 只带 5 个工具", len(des_agent.tools) == 5, f"{len(des_agent.tools)} 个")
check("设计师 agent max_iter 按 yaml = 8", des_agent.max_iter == 8, str(des_agent.max_iter))
check("单任务 Crew 结构正确", len(des_run.crew.tasks) == 1 and len(des_run.crew.agents) == 1)

eng_run = cb.build_run(
    "Implement_frontend_page",
    node_url=NODE,
    requirement="做一个服装电商首页",
    design_image_path="E:/tmp/design.png",
    design_description="## 整体\n两栏布局，左侧文案右侧插画，主色 #1e3a8a。",
    save_path="E:/tmp/out",
)
eng_agent = eng_run.crew.agents[0]
check("工程师 agent 带 14 个工具", len(eng_agent.tools) == 14, f"{len(eng_agent.tools)} 个")
check("工程师 agent max_iter 按 yaml = 30", eng_agent.max_iter == 30, str(eng_agent.max_iter))
check("关闭 agent 互相委派", eng_agent.allow_delegation is False)
check("关闭 planning / memory（省 token）", eng_run.crew.planning is False and eng_run.crew.memory is False)

print("\n=========== 7. 占位符替换 + 真 kickoff（走 build_run 全链路） ===========")
# 直接调 CrewAI 的插值入口，验证 yaml 里的 {xxx} 都能被入参替换掉
t0_obj = eng_run.crew.tasks[0]
t0_obj.interpolate_inputs_and_add_conversation_history(eng_run.inputs)
leftover = re.findall(r"\{[A-Za-z_]\w*\}", t0_obj.description)
check("任务描述里的占位符已全部替换", not leftover, f"残留 {leftover}")
check("需求已注入描述", "做一个服装电商首页" in t0_obj.description)
check("设计图路径已注入描述", "E:/tmp/design.png" in t0_obj.description)
check("设计说明已注入描述", "主色 #1e3a8a" in t0_obj.description)
# 任务书必须交代「agent 看不到设计图、上面的设计说明是唯一依据」：
# crew 里没有任何把图喂给模型的通道（terminal 图片展示与 view_image 均已删除），
# 不写清楚模型就会去找工具看图、或直接凭想象还原
check(
    "任务书说明 agent 看不到设计图、以设计说明为唯一依据",
    "你看不到设计图本身" in t0_obj.description and "view_image" not in t0_obj.description,
    "否则等于让模型凭想象还原",
)

# 换成一条便宜又可验证的任务，用**真实的工程师 agent**跑一次 kickoff，
# 证明 build_run 组装的 agent + 插值 + 工具回调整条链是通的。
# 注意：CrewAI 在首次插值时会缓存 _original_description，kickoff 时拿它重新插值，
# 只改 description **会被冲掉**（踩过一次：以为在跑短任务，其实跑的是完整工程任务），
# 所以两处都要改。
CHEAP = "用 read_file 工具读取文件 {path}，告诉我 dependencies 里 express 的版本号。只回答版本号。"
try:
    task = eng_run.crew.tasks[0]
    task._original_description = CHEAP
    task.description = CHEAP
    eng_run.inputs["path"] = PKG
    t1 = time.time()
    out = eng_run.crew.kickoff(inputs=eng_run.inputs)
    dt = time.time() - t1
    check("build_run 组装的 crew 能真跑通", "5.2.1" in str(out), str(out).strip()[:80])
    # 同 §5：门槛放宽到 45s，避免网络抖动把「tracing 是否卡住」误判成失败
    check("kickoff 无 tracing 空等", dt < 45, f"耗时 {dt:.1f}s")
except Exception as e:  # noqa: BLE001
    import traceback

    traceback.print_exc()
    check("build_run 组装的 crew 能真跑通", False, f"{type(e).__name__}: {e}")

print("\n=========== 7.5 设计图 -> 文字说明（agent 唯一的「看图」途径） ===========")
from node_tools import DescribeError, fetch_design_description  # noqa: E402

DESIGN = str(ROOT / ".front" / "design" / "AI-image" / "静态着陆页设计稿.png")
if not pathlib.Path(DESIGN).exists():
    check("找到一张真实设计图（该测试才有意义）", False, DESIGN)
else:
    # 这一条会真的调一次视觉模型（约 30s，2500 上下的 image tokens）。
    # 值这个钱：它是工程师「看得见设计」的唯一来源，坏了整个还原就退化成凭想象。
    try:
        t0 = time.time()
        desc = fetch_design_description(DESIGN, NODE)
        dt = time.time() - t0
        check("视觉模型给出了设计说明", len(desc) > 200, f"{len(desc)} 字符，耗时 {dt:.0f}s")
        # 说明里得真有布局/配色这类可施工的信息，不能是一句「这是一张设计稿」
        has_layout = any(k in desc for k in ("布局", "区块", "栏", "导航"))
        has_color = "#" in desc or "色" in desc
        check("说明包含布局信息", has_layout)
        check("说明包含配色信息", has_color)
    except DescribeError as e:
        check("视觉模型给出了设计说明", False, str(e)[:90])

# 失败路径：图不存在时必须抛出可读错误，而不是返回空串
# （返回空串的话工程师会以为「本来就没有设计说明」，转而凭想象写代码）
try:
    fetch_design_description("D:/definitely-not-here-12345.png", NODE)
    check("图不存在时报 DescribeError", False, "竟然没报错")
except DescribeError as e:
    check("图不存在时报 DescribeError", True, str(e)[:70])
except Exception as e:  # noqa: BLE001
    check("图不存在时报 DescribeError", False, f"报成了 {type(e).__name__}: {e}")

print("\n=========== 8. runner：事件流 / 入参校验 / 终止 ===========")
import threading  # noqa: E402
import time as _t  # noqa: E402

import node_tools  # noqa: E402
import runner as runner_mod  # noqa: E402
from runner import Runner, RunError  # noqa: E402

R = Runner(NODE)

for bad_call, why in (
    (dict(mode="nope", user_input="x", design_image=None, cwd=None), "未知 mode"),
    (dict(mode="team", user_input="  ", design_image=None, cwd=None), "空 userInput"),
    (dict(mode="engineer", user_input="x", design_image=None, cwd=None), "engineer 缺设计图"),
):
    try:
        R.start(**bad_call)
        check(f"拒绝：{why}", False, "竟然没报错")
    except RunError as e:
        check(f"拒绝：{why}", True, str(e)[:50])
    except Exception as e:  # noqa: BLE001
        check(f"拒绝：{why}", False, f"报成了 {type(e).__name__}: {e}")

# 终止：用真 kickoff 起一个跑得久的任务，中途终止，看状态与事件对不对。
# 这里临时把阶段换成一条耗时任务，不碰 yaml（否则会真去生成设计图，100s 起步）
st = R.start(mode="engineer", user_input="忽略这个需求", design_image="D:/x.png", cwd=None)
check("start 立刻返回 runId", bool(st.id) and st.status in ("pending", "running"))
check("事件里有 start", any(e["kind"] == "start" for e in st.since(0)))

# 等它真的跑起来（工作线程走到 kickoff）
_t.sleep(2.0)
check("运行中被标记为活动", R.active is not None and R.active.id == st.id)

# 设计图不存在（这里填的是 D:/x.png）时应走降级分支：注入一段「你没有设计说明」的说明，
# 而不是留空 —— 留空的话工程师会当成「本来就没有」，然后凭想象还原
dd = st.inputs.get("design_description") or ""
check("设计说明拿不到时注入了降级说明", "未能自动生成设计说明" in dd, dd[:60])
check("降级说明里要求靠对比报告逼近", "imugi_compare" in dd)

# 第二个运行必须被拒（工具里有 process.chdir，并行会串工作目录）
try:
    R.start(mode="engineer", user_input="并发试探", design_image="D:/x.png", cwd=None)
    check("并发运行被拒绝", False, "竟然又起了一个")
except RunError:
    check("并发运行被拒（避免 cwd 串台）", True)

check("abort 返回 True", R.abort(st.id) is True)
check("状态立刻变 aborted", st.status == "aborted")
check("已终止后 active 空出来", R.active is None)
check("再 abort 返回 False（已结束）", R.abort(st.id) is False)

# 迟到的 done/failed 不能把 aborted 顶掉
st._set("done")
check("终止是终态，不被迟到的 done 覆盖", st.status == "aborted")

# 关键：终止不能只是改个标签，工作线程得真的收手。
# CrewAI 没法从外部打断 kickoff，靠的是工具边界上的 ABORT_HOOK —— 所以这里
# 等的是「它跑完当前这次 LLM 调用、下次要调工具时看到标记」。等不到就是真问题。
_t.join_t0 = _t.time()
st._thread.join(timeout=120)
wind = _t.time() - _t.join_t0
check(
    "工作线程真的收手了（不是只改状态）",
    not st._thread.is_alive(),
    f"用了 {wind:.1f}s" if not st._thread.is_alive() else "120s 还没停",
)

# 终止后的事件序列必须完整：aborted -> phase_aborted -> end。
# 这里踩过：SSE 早先按「状态已结束」收流，而终止到工作线程收手之间可能隔十几秒，
# 结果客户端常常收不到 end 与 phase_aborted。改成按 seal() 封口判断后，
# 断言的就是这条不变量 —— 序列定型了才允许收流。
kinds = [e["kind"] for e in st.since(0)]
check("终止后事件序列以 end 收尾", kinds and kinds[-1] == "end", " -> ".join(kinds))
check("终止发了 aborted", "aborted" in kinds)
# 这条是终态不变量：被终止的 run 绝不能出现「阶段完成」的绿色事件。
# 注意不能在这里断言「一定有 phase_aborted」：那是 kickoff **正常返回**时才走的分支，
# 若中途 LLM 调用抛错（例如网络断了），异常会直接冒到 _work 的 except，
# 反而不会发任何阶段事件（此前写成必有 phase_aborted，一次网络故障就把它判成失败）。
check("终止的阶段不发 phase_done（否则 TUI 会显示绿色完成）", "phase_done" not in kinds)
check("工作线程收手后 sealed = True", st.sealed is True)

# phase_aborted 那个分支用假的 crew 离线验，不受网络影响：
# 造一个「kickoff 正常返回、但返回时已经被终止」的场景，看它是否如实报 phase_aborted。
_holder = {}
_gate = threading.Event()


class _FakeCrew:
    def kickoff(self, inputs=None):
        _gate.wait(10)  # 等测试把状态对象放进 _holder
        # 走真实入口 request_abort（而不是直接 _abort.set()）：
        # 真实用户点终止就只走这条路，它同时置 event 与 status
        _holder["st"].request_abort()
        return "假装的结果"


class _FakeRun:
    crew = _FakeCrew()
    inputs: dict = {}


_orig_build = runner_mod.build_run
runner_mod.build_run = lambda phase, **kw: _FakeRun()
try:
    st4 = R.start(mode="engineer", user_input="离线验证 phase_aborted", design_image="D:/x.png", cwd=None)
    _holder["st"] = st4
    _gate.set()
    R._join_worker(st4, 30.0)
    kinds4 = [e["kind"] for e in st4.since(0)]
    check(
        "kickoff 正常返回且已被终止 -> 发 phase_aborted",
        "phase_aborted" in kinds4,
        " -> ".join(kinds4),
    )
    check("且依然不发 phase_done", "phase_done" not in kinds4)
    check("状态是 aborted，不被迟到的 done 顶掉", st4.status == "aborted", st4.status)
finally:
    runner_mod.build_run = _orig_build

# 不存在的 id
check("abort 未知 id 返回 False", R.abort("nope") is False)
try:
    R.retry("nope", None)
    check("retry 未知 id 报错", False, "竟然没报错")
except RunError:
    check("retry 未知 id 报错", True)

# 重跑：上一轮线程已经收手了，应该能顺利再起一轮
st2 = R.retry(st.id, None)
check("已结束的运行可以重跑", st2.id == st.id and st2.status in ("pending", "running"))
check(
    "重跑复位的封口标记（不复位 SSE 会提前收流）",
    st.sealed is False,
    "上一轮的 end 已经发过，新一轮要重新等",
)
_t.sleep(3.0)
R.abort(st.id)
R._join_worker(st, 20.0)
check("重跑起来的那轮也能终止", st.status == "aborted")

# 关键不变量：**终止后立刻重跑，绝不能出现两个 crew 并跑**。
# retry 会先等旧线程收手（最多 20s），所以这里断言的是
# 「retry 返回时，旧线程一定已经死了」。测不了 >20s 的拒绝分支
# （那需要一次挂住 20s 以上的 LLM 调用），但这条不变量是防并跑的根。
st3 = R.start(mode="engineer", user_input="再起一轮", design_image="D:/x.png", cwd=None)
_t.sleep(3.0)
R.abort(st3.id)
old = st3._thread
check("旧线程此刻还在收尾（这条断言才有意义）", old.is_alive())
R.retry(st3.id, None)
check("retry 返回时旧线程已死 —— 不会并跑", not old.is_alive())
R.abort(st3.id)
R._join_worker(st3, 30.0)
check("重跑那轮也能正常收尾", not st3._thread.is_alive())

print(f"\n{'🎉 全部通过' if bad == 0 else f'💥 {bad} 项失败'}（通过 {ok} / 失败 {bad}）")
sys.exit(0 if bad == 0 else 1)
