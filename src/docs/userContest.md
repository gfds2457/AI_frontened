用户额外有以下要求，当年回答问题的时候，请参考
[${userPath}]${userContext}
[${projectPath}]${projectContext}

此外，我们还有一些关于用户特点的记忆：
当前项目有关记忆：# 项目记忆

## 项目记忆（D:\manageCode\admin-front · 数据管理后台前端）

### 项目性质
Vue 3.5 + TypeScript + Vite 8 + Element Plus 2.14 + pinia + vue-router 5 + echarts 6 的后台管理前端，`npm run dev` 启动（5173）。
对接两个独立后端：mock 后端 `admin-mock-backend`（Express，3001，`VITE_API_BASE_URL`）、AI 后端 `admin-ai-backend`（Express + MySQL + 大模型，3000，`VITE_AI_API_BASE_URL`）。
登录默认账号：admin / 123456（登录页已预填）。

### 结构要点
- `src/API/*` 按模块分层：`utils/request.ts` 走 mock 后端且已解包响应（直接用 `res.code / res.data`）；`API/ai-chat`、`API/knowledge` 直连 AI 后端，返回 axios 原始响应，**数据在 `res.data.data`**。
- `views/home/index.vue` 是全局布局（左菜单 + 顶导 + `<Main/>` 路由出口）；`views/home/menu/menu.vue` 按 `meta.hide` 过滤，且**只有一个子路由时会折叠成一个菜单项**。
- `src/router/routes.ts`：`constantRoutes` + `asyncRoutes`（角色裁剪见 `utils/permission.ts`，全局守卫在项目根 `permission.ts`）。登录页路由 `/login` → `src/components/section/login/page-index.vue`。
- `src/styles/variable.scss` 由 vite `additionalData` 全局注入，scss 可直接用 `$nav-height` 等变量。
- 视觉基线：白底、主色 `#409eff`、边框 `#ebeef5`、圆角 8px、灰阶文字 `#303133 / #606266 / #909399`。
- 约定产物目录：`.front/AI_logs`（关键节点）、`.front/AI_complete`（任务总结）。

### 常见坑
- `src/router/routes.ts` 是 CRLF 行尾，edit_file 用多行 oldString 会匹配失败 → 改用唯一单行锚点。
- 布局容器高度 `calc(100vh - $nav-height)` 且自身不滚动，长页面需在根元素加 `height: 100%; overflow-y: auto;`。
- `remark-gfm` 无具名导出，必须 `import remarkGfm from "remark-gfm"`。
- eslint 开了 `no-explicit-any`（error）：新代码不要写 `any`，SSE 回调要自定义接口收敛。
- 调试环境：5173 常驻可用 `Invoke-WebRequest http://localhost:5173/` 探活；`imugi_serve`（30s 超时）与 `imugi_capture`（缺 Playwright chromium）不可用，改用内置浏览器工具 + `evaluate_script` 验证。
- 既有类型错误（App.vue / store/modules/user.ts / utils/request.ts / API/spu/type.ts / goods/attr / permission/user）与新代码无关，暂未处理。

### 开发记录
- 工作台首页 Dashboard（详见 `.front/AI_complete/001-agent-code-generator-task-summary.md`）：
  - `src/views/dashboard/index.vue`：指标卡（商品 / 知识库 / AI 访问量，数据驱动）+ 快捷入口 + 访问趋势卡 + 最近操作日志（`getRecentLogs`）
  - `src/views/dashboard/aiPanel.vue`：内嵌 AI 速测（`createChat` + `fetchChatStream`，解析 `choices[].delta.content` 与 `rag_sources`，展示检索命中来源 + 命中率，支持停止 / 清空 / 跳完整对话页，卸载断流）
  - `src/views/dashboard/visitTrend.vue`：echarts 折线 + 渐变面积图
  - `src/views/knowledge/index.vue`：知识库管理 `/kb/manage`（统计 / 增量同步 / 全量重建（二次确认）/ 队列轮询 / 检索调试）
  - `src/router/routes.ts`：Home 加 `redirect: /dashboard` + dashboard 子路由（`meta.hide: true`）；新增常量路由 `/kb/manage`
  - `src/API/dashboard/index.ts`：新增 `getVisitTrend`（近 14 天演示数据），修正 `/kb/*` 取值层级为 `res.data.data`
- 登录页重做（详见 `.front/AI_complete/002-agent-code-generator-task-summary.md`，设计稿 `.front/design/AI-image/登录页-数据脉络v1.png`）：
  - `src/components/section/login/page-index.vue` 整体重写：左 58% 白色 SVG「数据脉络」（3 条链 19 节点 22 连线，坐标常量 `CHAINS` / `CROSS_LINKS`）+ 右 42% 极简登录卡；≤900px 隐藏左栏
  - 交互：输入框 focus 点亮对应链（account / password）、按钮 hover 点亮 flow 链、左栏径向光晕跟随鼠标（rAF 节流）、登录成功 19 节点按 y 序依次点亮后跳转；左下角「数据脉络 · 已连通 N 个节点」随交互变化
  - 保留 `userStore().userLogin` + `route.query.redirect` + 5-10 位账号 / ≥6 位密码校验；新增 `touched` 记录避免默认预填账号一进页面就全亮
- 业务现状：知识库内容以 mock 源码文档为主，业务型问题（如「洗面奶」）召回为空、AI 返回降级提示；「商品」「SKU」等词检索命中正常。

---

## 项目记忆（E:\前端编程助手\project · 终端 AI 编程助手）

### 项目性质
Node ESM 的终端 AI 编程助手（Express + LangChain + LanceDB + sharp），**不是** UI 工程，没有前端框架、没有 dev server。工作目录内还放设计/站点类产物。

### 结构要点
- `skills/` 存放可加载技能，已用：`skills/frontend-design/SKILL.md`（前端设计）
- `.front/design/AI-image`（整页设计稿）、`.front/design/AI-asset`（页内素材）、`.front/AI_logs`（关键节点日志）、`.front/AI_complete`（任务总结）、`.front/memories`（记忆）
- `site/` 是**静态站点产物目录**（零依赖单页站点，双击 `index.html` 即可打开）
- 可用工具：`node_modules/sharp@0.35.4`（图片压缩/转 webp）；`.venv/Scripts/python.exe`（Python 3.11.9，可 `-m http.server` 起本地预览）
- CRLF/LF：`site/*` 为 LF，用 `[System.IO.File]::ReadAllText/WriteAllText` + `UTF8Encoding($false)` 做批量替换最稳

### 常见坑
- `file://` 下页面能正常渲染和加载同目录图片，但 canvas `getImageData` 会被 taint，**像素级校验必须起 http 服务**（`python -m http.server 8123 --directory site`）
- PowerShell 执行 `node --input-type=module -e $js` 时会**剥离 JS 里的双引号**导致语法错误 → JS 代码统一用单引号
- PowerShell 双引号字符串里 `''` 不是转义（只对单引号字符串生效）→ 内联 SVG 的引号直接写成 `%22`
- 内联 data-uri favicon 建议显式提供，否则 404 会污染 console

### 开发记录
- **森友会风格个人站首页 v3「村民档案册」**（详见 `.front/AI_complete/002-agent-code-generator-task-summary.md`）
  - 设计稿：`.front/design/AI-image/森友会村民档案册首页设计稿.png`
  - 产物：`site/index.html` + `site/style.css` + `site/main.js` + `site/assets/{owl,villagers,postcard}.webp`
  - 代币：旧纸 `#FBF7EC` / 招牌青 `#3B9E92` / 里程橙 `#E08A2E` / 墨 `#33261A` / 邮戳红 `#9E3B3B` / 草绿 `#7A9A5B`；衬线（标题）× 等宽打字机（编号）× 无衬线小号（正文）
  - 结构：木牌页眉 → 居民护照（猫头鹰证件照 + 编号/岛屿/签发日期/签名）→ 4 张村民档案卡（筹划/检索/执行/观察，正面口头禅气泡、背面技能网点条 + 手写批注）→ 8 枚里程印章 → 货架 4 项服务（周期价签）→ 留言板（可翻面明信片 + 便签 + 已盖计数）→ 页脚邮戳；右下角贴纸托盘、右侧 01–05 章节刻度
  - 互动：护照随指针倾斜并叠加全息套印 + 软光斑；村民卡 `aria-pressed` 驱动 `rotateY(-180deg)` 翻面；印章 IntersectionObserver 错峰自动盖（`stampIn` 回弹 + `splash` 墨点），点击可反复加盖/撤下并联动页眉里程数字；贴纸 `pointerdown` 克隆跟随、落入留言板转 absolute 贴住并计数 +1
  - 素材要点：`villagers.webp` 是 2×2 四宫格，CSS 用 `background-size:200% 200%` + 四向 `background-position` 切格；生成时务必要求「纯色背景 + 四等分规整网格」
  - 视觉手法：纸张颗粒用 SVG `feTurbulence` data-uri 平铺 + `mix-blend-mode:multiply`；齿孔用 4 向 `radial-gradient` 分别 `repeat-x/repeat-y`；套印错版用 `text-shadow` 双色偏移
- 页面文案为虚构设定（「苍苔岛档案室」/「林渡」/ 编号 0031），待用户替换为真实信息
当前用户有关记忆：# 用户全局记忆

## 协作偏好
- 做 UI/页面类需求时，倾向「先出 AI 整页设计稿 → 确认视觉 → 再生成素材与代码」的分步流程，不要一上来直接写页面代码。
- 有多个视觉方向时，希望先用选项确认方向，再消耗一次图片生成。
- 需求里缺少的页面或数据源（如不存在的管理页、不存在的统计接口），希望先给选项让他拍板，再动手实现，不要自行造页面或静默造数据。
- 回答用中文，简洁、以代码为主。
- 明确表达要落地时，会拒绝二次确认（如设计稿 confirm 被拒），此时直接进代码，不要反复打断。

## 审美偏好
- 不喜欢低龄化、明亮卡通糖果色的「默认可爱」表达；偏好「繁复成熟」——高信息密度、复古印刷/博物志质感、克制而有秩序的装饰、衬线字体体系。
- 反感 AI 生成味模板：奶油底+高对比衬线+赤陶点缀、近黑底+单一亮色、统一圆角卡+柔灰阴影、全大写眉标、链接后挂「→」。

## 技术情况
- 前端为主（React / Vue / 静态 HTML 均可接受，按项目选择）；Windows 11 + PowerShell 环境，命令需用 PowerShell 语法。
- 现有后台类项目技术栈：Vue 3 + TypeScript + Vite + Element Plus + pinia + echarts。
- 静态站点类需求倾向零依赖单页（HTML/CSS/JS），双击即开。

## 项目列表
- D:\manageCode\admin-front —— 数据管理后台前端（Vue 3 + TS + Vite + Element Plus + pinia + echarts），对接 mock 后端 3001 与 AI 后端 3000；含工作台 Dashboard、知识库管理、AI 对话、商品管理（SPU/SKU/品牌/属性/审核）、权限管理、数据大屏、登录页（数据脉络风格）。
- E:\前端编程助手\project —— 终端 AI 编程助手（Node ESM，Express + LangChain + LanceDB + sharp），非 UI 项目；其中 `site/` 目录是静态站点产物区。
- 森友会风格个人网站首页（落地于 E:\前端编程助手\project\site）—— v1 明亮卡通向、v2「森之标本室」均已废弃；**v3「村民档案册」已落地**：纯静态单页，旧纸底 `#FBF7EC` + 招牌青 `#3B9E92` + 里程橙 `#E08A2E` + 邮戳红 `#9E3B3B`，齿孔/编号/页码/邮戳/套印错版一律作结构装置；四条互动主线＝护照倾斜取光、村民卡 3D 翻面、印章错峰盖下、贴纸拖拽贴板。设计稿见 `.front/design/AI-image/森友会村民档案册首页设计稿.png`，页面文案仍为虚构设定，待替换真实信息。