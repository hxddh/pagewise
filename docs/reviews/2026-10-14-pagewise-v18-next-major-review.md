# 18.0 方向评估：把工作台变成阅读器

*2026-10-14。基线 17.0.3（main `2fedacd`）。*

*来源标注：**实测**（在这个 orb 里对生产构建运行中的应用量出来的，方法见 §1.1）、**读代码**（文件:行）、**代理核对**（三路只读审计，要点我复核过，见 §8）。§0 结论，§1 现状，§2 18.0 提案（四个支点 + 一个预算），§3 交付包，§4 验收，§5 候选对比，§6 风险，**§7 依赖与可用能力**，§8 核验记录。*

*概念图（方向讨论用，不是规范）：`.amp/in/artifacts/v18-direction-concepts.png`（形态：Reader / Zen）、`.amp/in/artifacts/v18-config-concept.png`（配置：Today / v18）。*

*这一版的问题清单（"界面和交互不够优雅简洁、配置繁琐固化复杂、性能也需提升、成本仍需优化、阅读体验和沉浸感不足"）我逐条量了一遍。结论先行：**表现层与配置是两条真短板（有结构性证据），性能在桌面路径上是健康的（第一次量，见 §1.2），成本是真金白银且不可见（见 §1.3），沉浸感是"根本没做"（见 §1.5）**。*

---

## 0. 结论

1. **性能：桌面路径第一次被量，结果是健康的。** 生产构建、Chromium、mock Tauri、120 页文档（实测）：启动到可交互 **258–308ms**（FCP 224–256ms）；打开文档到首帧 **589–636ms**、文本层 814–874ms，期间**零长任务**；阅读速度与甩动滚动都是 **16.7ms/帧、零丢帧、零长任务**；缩略图首张 123ms 且只挂 14/120 项（有窗口化）；3,671 字符的流式回答 p95 16.7ms、只有 1 个 53ms 长任务；60 条消息的会话 633ms 内渲染完、滚动零丢帧。**"性能需提升"在 UI 路径上不成立**——真正没被覆盖的是别处：扫描页索引（OCR 中位 **2.2s/页**，`eval/README.md:54`）、大文件内存（整份读入 + 128MB 位图缓存 + 3 份字节缓存，`pdf.ts:22,36,110`）、首次包解析（`ai` 634KB 与 `pdf` 521KB 都在 `index.html` 里 modulepreload）、以及真机 WebKitGTK/WebView2（本环境不可测）。

2. **成本：每一问都背着 11,132 字节的固定前缀，而成本对读者不可见。** 实测：系统提示 4,041B + 8 个工具定义 7,091B = **每次请求（每一步都重发）≈2,650–3,180 token**；读取预算 6,000 字符/页、200,000 字符/次运行——但按 **UTF-16 字符**计数，中文文档的实际 token 上限约为英文的 3 倍（`reading.ts:60`，计费点 `reading.ts:507,519`、`read-page.ts:147`）；运行 20–30 步，`maxOutputTokens: 8,000`；视觉调用 1,568px JPEG q0.85 ≈ 85–218KB/次（50 页默认后台扫描）；**没有任何 prompt caching 提示**（已安装的 SDK 支持 `providerOptions.openai.promptCacheBreakpoint`，未用）；用量被记录却只藏在一个 popover 里（`MessageAssistantFooter.tsx:455`），`formatUsageSummaryLine` 有实现有测试却**没有任何调用点**（`message-metadata.ts:195`）。没有一分钱的显示。

3. **配置：一次问答要 6 次点击 + 1 次粘贴，而且系统要求读者理解"提供商 / 助手模型 / 扫页模型"三个概念。** 实测计数：5 个提供商、18 个存储字段（11 个可编辑）、**34 个交互控件**、94 条 `settings.*` 文案、9 张卡片；首问最短路径 6 点击（且设置抽屉默认开在 General，不是 AI——`SettingsDrawer.tsx:74` + `preferences.ts:73`，`initialTab` 从未被任何调用方传入）；"Set active" 是第二套语义（编辑 ≠ 生效）；**`settings.ts` 763 行里约 457 行（60%）是迁移与向后兼容**（7 个迁移函数、6 条 API key 兜底路径）；连接测试要发 2 次网络请求；自动保存与"有未保存的更改"提示并存。

4. **UI/UE：排印已经在 17.0 修好，但"骨架"还是十二份手写协议与九套空态。** 代理核对 + 我复核：**12 个文件各自手写 Escape/背板**（`useOverlayLock` 7 处、`useFocusTrap` 5 处，5 个全屏 `<button>` 背板各自带 `raw-button:` 理由）；**9 套空态实现**（8 个文件，只有 1 套共享）；**15 种列表行、13 个类族**；**24 个状态播报点、8 种视觉处理**；两套手抄的 tab 条（`PreviewPane.tsx:496-532` / `ChatPanel.tsx:490-505`）；z-index 20 处声明、**9 个裸数字**与 9 个 token 并存；`ChatPanel` 935 行 **34 个 props**；`SessionProvider` **30 字段而全应用 1 个消费者**；`useDocAgent` 668 行返回 19 个值。视觉上：顶栏一行 9 个控件、空会话是一大片空洞（截图 `docs/ui-shots/02-document.png`）、面板是"堆盒子的聊天窗"（`07b-answer-typography.png`）。

5. **沉浸感：这一层基本没做。** 实测/读代码：只有 dark/light 两个主题（`tokens.css:243`）；**没有任何 `setEffects` 调用**——macOS vibrancy / Windows Mica 一次都没用；没有 Zen/专注模式；答案栏没有文字大小控制；页面外的留白（gutter）没有承载任何信息（标记/结论只画在页面上）；打开就是"工作台"的样子——顶栏、轨道、面板三件套一直在。

6. **18.0 的质变：把工作台变成阅读器。** 一句话：*打开就是读；第一次只做一个选择；答案是一页排好的纸；界面在你读的时候退场；每一问花了多少看得见。* 见 §2。

7. **配置的质变不是"把设置做漂亮"，是把概念减掉。** 18.0 的首问路径：**一个面板、三个提供商磁贴、一个 key、一个按钮（"Start reading"）**——模型自动选、扫页模型从界面消失（本地 OCR 优先、云端视觉按需）、"Set active" 概念删除（编辑即生效）；设置从 34 控件收敛到 **≤12 行、≤3 组、单行说明**；`settings.ts` 的兼容层从 457 行收敛到一条 v2→v3 迁移（目标 ≤120 行）。见 §2.2。

8. **表现层的质变是 v17 §8.2 第 3、4 层的兑现，不是又一次换皮。** Radix 原语替换 12 处手写浮层协议（直接调用点 ≤2）、`motion` 负责进入/离开/布局变化、React Compiler 兜底记忆化并删掉手写比较器；同时把 9 套空态、15 种行、8 种状态处理收敛成 4 个共享原语（EmptyState / ListRow / StatusLine / Tabs）；`ChatPanel` 拆成消息列表 + 行 + composer（≤250 行、≤12 props）；删掉 `SessionProvider` 的 30 字段 context（只有 1 个消费者）。见 §2.3。

9. **成本的质变是"可见 + 可控"，不是"省一点"。** 每一问落一行用量（页数 · 步数 · 输入/输出 token · 缓存命中 · 扫描次数），把 `formatUsageSummaryLine` 复活；前缀瘦身目标 ≤9,000B（工具 schema 去 `path`、描述精简、系统提示两段可裁）；预算从 UTF-16 字符改成 token 估算（消掉中文 3 倍偏差）；视觉默认 1,568px→1,024px、截图 PNG→JPEG、后台扫描 50→20、每题 20→10；按步骤分派推理档位（取回页面的步骤不需要 medium/high）。见 §2.4。

10. **沉浸的质变是三件看得见的事：材质、Zen、页边。** `setEffects`（macOS vibrancy / Windows Mica）+ `setBackgroundColor` 消除启动白闪（前提：窗口 transparent + 权限 `core:window:allow-set-effects`，Linux 降级为不透明）；⌘⇧F 进入 Zen——轨道/顶栏/面板退场、页面居中、右缘一条阅读进度发丝线、底部一个悬浮 composer；页面外缘的 gutter 承载标记与结论的点（悬停出注、点击回页）。见 §2.5。

11. **性能的质变是"把已经健康的面变成门，把没测过的补上"。** 把这次写的一次性探针收进仓库（`scripts/perf-probe.mjs`），用今天量到的数字设预算（启动 ≤500ms、开文档 ≤1,200ms、滚动 p95 ≤20ms 且 >50ms 帧为 0、流式 p95 ≤20ms 且长任务 ≤2、60 条会话 ≤1,500ms、答案后堆 ≤80MB）；新增三个从未测过的场景：100MB 扫描件的打开、500 页文档的搜索、100 轮会话；并把 `ai` chunk 改成"打开文档后按需加载"（现在它在首屏 preload 里）。见 §2.6。

12. **依赖没有 major 落差，工作不是升级。** 今天逐个核对：`radix-ui` 1.8.1、`motion` 14.2.0、`babel-plugin-react-compiler` 1.0.0、`@tanstack/react-virtual` 3.14.19、`ai` 7.0.140、`pdfjs-dist` 6.4.299、`tauri` 2.12.3——全部是补丁级或已是最新（§7）。18.0 要用的能力都在**已安装或一个补丁版本之内**。

13. **v17 的六项遗留被 18.0 全部吸收**（§1.7）：浮层内提问、Radix/motion/Compiler、`ChatPanel` 34 props、`SessionProvider` 拆分、文档级单例拆除、`eval/README` 的旧数字——18.0 是它们的收口版本。

---

## 1. 现状（实测为主）

### 1.1 这次 review 的方法

| 手段 | 说明 |
|---|---|
| 性能探针（实测，新） | `/tmp/perf/probe.mjs`：生产构建（`npm run build` 后静态服务）+ Chromium 1248 + 仓库自己的 `scripts/ui-harness/tauri-mock.mjs`；**合成文档**用 Chromium `page.pdf()` 打出 120 页 / 209KB 的文本 PDF（`/tmp/perf/gen-text.mjs` 同一份文本喂给 mock 的文档元数据）；流式回答由一个本地 OpenAI 兼容 SSE 服务逐词（6ms）提供，走真实 transport；测 rAF 帧间隔、`longtask`、DOM 槽位数、`performance.memory` |
| 长会话探针（实测，新） | 同一 harness，预置 30 轮 / 60 条消息（`pagewise-v3-chats.json` 的 mock 存储），测渲染时间、消息区滚动、下一问的请求体字节 |
| 三路只读审计（代理核对） | 配置摩擦、token/成本结构、UI 结构计数；要点我逐条复核（§8） |
| 构建与门（实测） | `npm run build`（1.25s，8 chunk）+ 全部 `check:*` 门 + `ui:shots` 13 张逐张看 + 当前截图 4 张（`01/02/05/07b`） |
| 版本核对（实测） | `npm view` 12 个包 + crates.io API 6 个 crate（2026-10-14 当天，§7） |

限制（先写在前面）：**Chromium 不是 WebKitGTK/WebView2**；mock shell 不执行 Rust；合成文档不是扫描件；mock 的模型延迟≈0，所以"首字 323ms"不是网络指标。凡涉及这些的地方都写明。

### 1.2 性能（实测，第一次）

环境：1440×900 @1x，生产构建，三次运行取范围。

| 场景 | 实测 | 判断 |
|---|---|---|
| 启动（冷） | FCP 224–256ms；可交互 258–308ms；初始堆 9.6–9.7MB | 好 |
| 打开 120 页文档 | 首帧 **589–636ms**；文本层 814–874ms；零长任务；挂 2 页槽 / 245 DOM 节点；堆 ≈20MB | 好 |
| 阅读速度滚动（80px/帧） | 60 帧 avg 16.9ms、p95 16.8、max 33.3、>32ms 仅 1 帧、**>50ms 0 帧**、零长任务 | 好 |
| 甩动滚动（500px/帧 ≈30,000px/s） | 40 帧全部 16.7ms，零丢帧 | 好 |
| 跳页到末尾（第 120 页） | 零长任务，挂 2 页槽 | 好（窗口化有效） |
| 缩略图栏 | 首张 123ms；**只渲染 14/120 项**（窗口化）；滚到底仍 14 项；堆 +1MB | 好 |
| 流式回答（3,671 字符 / 4.9s） | 276 帧、p95 16.7ms、max 33.3ms、>50ms 0 帧、**长任务 1 个（53ms）**；答案后堆 33.9MB | 好 |
| 长会话（30 轮 / 60 条） | 打开到全部渲染 **633ms**（首帧后约 8ms）；消息区滚动全 16.7ms；DOM 483 节点、堆 16.4MB | 好 |

**没被这份数据覆盖的（18.0 要补测）**：扫描件索引吞吐（OCR 中位 **2.2s/页**，`eval/README.md:54`，14.0 的语料记录）、视觉调用体量（85–218KB/张）、100MB 级文件的读入与 pdf.js 解析（整份读入内存，`lib.rs:262` `MAX_READ_BYTES` 256MiB；字节缓存 3 份 `pdf.ts:36`；位图缓存 128MB `pdf.ts:22`）、500 页文档的搜索、首次包解析（`index.html` 里 modulepreload 了 `ai` 634KB 与 `vendor` 210KB，加上 `pdf` 521KB —— gzip 合计约 340KB 在首屏）。

### 1.3 成本（实测 + 读代码）

| 项 | 数值 | 来源 |
|---|---|---|
| 固定前缀（每次请求、每一步） | 系统提示 **4,041B** + 工具定义 **7,091B** = **11,132B ≈ 2,650–3,180 token** | 实测（用应用自己的模块跑出来，与 `agent-tool-prefix.test.ts` 的摘要值一致） |
| 工具定义构成 | 描述 2,373B + schema 4,024B；8 个工具；`path` 字段在 8 个 schema 里 ≈285B；`maximum: 9007199254740991` ×10 ≈90B | 实测 |
| 读取预算 | 6,000 字符/页（上限 50,000）；**200,000 字符/次运行**，按 UTF-16 `length` 计费（`reading.ts:60`，计费点 `reading.ts:507,519`、`read-page.ts:147`） | 读代码 |
| 步数 | `min(30, max(20, totalPages))`（`agent.ts:69-76`）；`maxOutputTokens: 8,000`；`streamRetries: 1` | 读代码 |
| 历史压缩 | 运行内保留 16,000 字符工具结果（`compact-run-messages.ts:33`）；跨轮 12 轮窗口（`history-window.ts:25`），注记量化到 4 轮以保前缀字节稳定 | 读代码 + **实测**（30 轮历史下发问，请求体 17,864B / 31 条消息） |
| 一页正文的代价 | 语料实测中位：英文论文 3,701 字符（3,749B）、中文合同 879 字符（**2,405B**）、UML 表 1,082 字符 | 实测（`eval/out` dump） |
| 视觉 | 1,568px JPEG q0.85 ≈ **85–218KB**（base64 114–290KB）/次；后台扫描默认 50 页；每题上限 20；**在页预取不计入任何消息** | 实测（ImageMagick 按应用参数复现）+ 读代码 |
| 截图（可选） | 整页 **无损 PNG**（`pdf.ts:1314-1341`），比 JPEG 路径大 2–4 倍 | 读代码 |
| 缓存 | **没有任何缓存提示**；SDK 支持 `providerOptions.openai.promptCacheBreakpoint`（`node_modules/@ai-sdk/openai/dist/index.js:480`），未用；前缀 11,132B 已超过 OpenAI 1,024 token 的自动缓存门槛 | 实测 grep |
| 用量显示 | 每步 input/output/cached 都记了；只在一个"Usage stats" popover 里可见；`formatUsageSummaryLine` 无调用点；**没有钱** | 读代码 |
| 推理档位 | **已经是分步的**：还没有材料的步骤用 `low`，首个工具结果之后每一步都用配置档（`agent.ts:107-137,291`）。注释（`agent.ts:108-135`）记录了这是一次刻意的取舍——20 步里 19 步全档，理由是"哪一步写答案无法预知，而答案才是读者拿到的东西" | 读代码 |

一句话：**读者看不见每一问的成本，而每一问的固定开销是 2,650–3,180 token；中文文档的实际读取上限是英文的 3 倍 token。**

### 1.4 配置（实测）

| 项 | 实测 |
|---|---|
| 概念数 | 5 个提供商 ×（API key / 助手模型 / 扫页模型 / 思考开关 / Base URL）；读者要先理解"提供商、助手模型、扫页模型"三个概念 |
| 字段与控件 | 18 个存储字段（11 个可编辑）、**34 个交互控件**、94 条 `settings.*` 文案（中英各 480 键总量）、9 张卡片 |
| 首问路径 | **6 次点击 + 1 次粘贴**：设置（抽屉默认开在 General）→ AI tab → key 输入 → 测试连接（可选）→ 关闭 → 打开文档 → 提问；切提供商再加"Set active"（第 7 击） |
| 没有 onboarding | 唯一的"引导"是三处指向设置的内联链接 + 一条 `onboarding-hints`（只讲面板快捷键） |
| 两套语义 | 编辑自动保存（400ms 防抖）但有"未保存的更改"确认框；"保存"与"设为使用"分离；切换提供商不丢 key 但也不生效 |
| 连接测试 | 2 次网络探测（工具调用 + 视觉探测，`AiProviderSettings.tsx:408-412`） |
| 兼容层 | `settings.ts` 763 行中约 **457 行（60%）**是迁移/兜底（7 个迁移函数、6 条 key 兜底路径、明文警告） |
| 文案漂移 | 中文「设为使用」vs「设为当前」；EN `Attach current-page screenshot` vs `llm.agentImageNotSupported` 里的措辞 |

### 1.5 阅读与沉浸（实测 + 读代码）

| 项 | 现状 |
|---|---|
| 主题 | 只有 dark / light（`tokens.css:243`）；没有"纸"（暖白）档 |
| 材质 | **零个 `setEffects` 调用**；窗口不透明；启动有底色闪变（无 `setBackgroundColor`） |
| Zen / 专注 | 不存在；轨道、顶栏、面板常驻 |
| 顶栏 | 一行 9 个控件（文件名、翻页×2、页码、缩略图、搜索、缩放、Chat/Record、两个图标） |
| 空会话 | 大片空洞（截图 `02-document.png`：建议贴底，上方约 500px 无内容） |
| 答案栏 | 一个 surface 里叠三层盒子（回答动作行、follow-up chip、composer）；工具步骤仍占答案的第一视觉入口（`07b`） |
| 阅读位置 | **已实现**：`recent-files.ts:20` 的 `lastPage` + `SessionProvider.tsx:412` 的 resume |
| 缩放 | 预设 + ⌘+/−/0（17.0 加）；没有答案文字大小控制 |
| 页外留白 | 不承载信息：标记/结论只画在页面上，页面外缘没有任何锚点 |
| 排版控制 | 页面 fit-width / 预设缩放；无单页/双页模式 |

### 1.6 表现层结构（代理核对 + 我复核）

| # | 事实 | 位置 | 代价 |
|---|---|---|---|
| S1 | **12 个文件各自手写 Escape/背板**；`useOverlayLock` 7 处、`useFocusTrap` 5 处；5 个全屏 `<button>` 背板 | `RecentFilesDrawer/CommandPalette/SettingsDrawer/DocumentSearch/ExportDialog/ConfirmBar/AnchoredMenu/PreviewToolbar/RecordPanel/ConversationSearchBar/PreviewPane/MarkNote` | 一次浮层的正确行为被复制 12 次；Esc 层叠/焦点归还各写各的 |
| S2 | **9 套空态**（8 个文件），只有 1 套共享 | `EmptyState.tsx` 4 分支；`library-empty`/`record-empty`/`record-none`/`outline-empty`/`palette-empty`/`doc-search-empty`×2/`message-empty-reply`/`welcome-view` | 空态是"读者第一眼看到的东西"，却有 9 种形状 |
| S3 | **15 种列表行 / 13 个类族** | 缩略图、大纲、标记、记录、最近文件、命令面板、模型、提供商、导出选项…… | 选中/悬停/焦点各自实现 |
| S4 | **24 个状态播报点、8 种视觉处理** | toast / banner / 内联错误 / 设置页脚 / 连接芯片…… | 同一件事（告诉用户发生了什么）有 8 个样子 |
| S5 | 两套手抄 tab 条 | `PreviewPane.tsx:496-532`、`ChatPanel.tsx:490-505` | 面板 tab 的"当前"样式要在两处维护 |
| S6 | z-index：20 处声明、**9 个裸数字**（1/2/4/5/20/30/40/50/350）与 9 个 token 并存 | 见 §1.6 明细（`preview.css:380` 的 350 落在 300 与 1000 之间） | 层叠靠数字大小互相猜 |
| S7 | `ChatPanel` 935 行 / **34 props**；`SessionProvider` **30 字段 / 1 个消费者**；`useDocAgent` 668 行 / 19 个返回值 | `ChatPanel.tsx:51-93`、`SessionProvider.tsx:59-96`、`useDocAgent.ts:610-647` | 每个助手交互都是三文件改动 |
| S8 | `AiProviderSettings` 760 行 / 15 个 state；`settings.css` 789 行 | 同上 | 配置页是全仓最重的组件 |
| S9 | 门是健康的：raw-button 47 条带理由 + 4 个原语豁免；css-tokens 78 个 token 全解析；css-order 492 条规则；css-hygiene 另加死类/孤儿 keyframes/单一选中样式等 | `scripts/*`（实测运行） | 这是重写的安全网，不是负债 |

### 1.7 v17 遗留（18.0 的输入）

| 遗留 | 状态 |
|---|---|
| 浮层内提问（§2.3） | 未做（"Ask about this" 已聚焦 composer，差一次指针移动） |
| Radix / motion / React Compiler（§8.2 第 3、4 层） | 未做——18.0 的主包 |
| `ChatPanel` 34 props / `SessionProvider` 拆分 | 未做 |
| 文档级单例拆除（`pdf.ts` 10 个模块缓存 + 手写 reset 清单） | 未做（"上一份文档的文字漏进下一份"这一 bug 类被记录过三次） |
| `eval/README.md` 里 15.0 的旧数字 | 未改（但 OCR 表是 14.0 的真实记录，本次引用它） |
| 原生材质（§8.2 第 6 层） | 未做 |

---

## 2. 18.0：从工作台到阅读器

### 2.1 目标句（验收单位）

> 装好应用，第一次打开只做一个选择：选一个提供商、贴一个 key、点 "Start reading"——模型自动选好。打开一份 PDF 就是读：顶栏安静、页面居中、右侧是一页排好的纸，工具只留一行脚注。按 ⌘⇧F，界面退场，只剩页面和一条进度发丝线；选中一句话问一句，答案在旁边长出来，引文点回去就亮。读到的每个答案下面有一行小字：读了几页、几步、多少 token、有没有走缓存。设置里只有十几行，每一行一句话。

### 2.2 支点 A · 一次选择（配置的质变）

**首问路径重做**（概念图 `v18-config-concept.png` 右）：
- 未配置时打开设置 = **"Set up the assistant" 单页**：三个提供商磁贴（OpenAI / DeepSeek / OpenRouter）+ 一行"Something else…"；一个 key 输入 + "Get a key ↗"；一个主按钮 **Start reading**；一行小字 "The model is chosen automatically. Change it later in Settings."。目标：**2 次点击 + 1 次粘贴**。
- **模型自动选**：按提供商预置表取第一个工具可用模型（`PROVIDER_PRESETS` 已有），把"助手模型 / 扫页模型"收进 Advanced。视觉能力探测保留，但只在失败时说一句人话（现有 `agentNeedTools`/`scanNeedMultimodal` 文案改写成一句话）。
- **扫页模型从界面消失**：默认顺序 = 本地 OCR →（页面无文字且用户开着云端扫描时）云端视觉；模型从当前提供商的能力表里自动取（`defaultVisionModel` 已有）。自定义提供商时才在 Advanced 里出现。
- **删掉 "Set active"**：编辑即生效（切提供商 = 用它；per-provider profile 保留）。`settings.providerHint`/`savedPreviewNotActive` 两条文案随之删除。
- **修设置默认页**：`initialTab` 目前没有任何调用方，`DEFAULT_PREFERENCES.lastSettingsTab = "general"`（`preferences.ts:73`）；未配置时强制落在 setup 页。
- **设置收敛到 ≤12 行 / ≤3 组 / 单行说明**：Appearance（Dark/Light/System）、Reading（本地扫描开关、云端页数 Off/20/50/200）、Assistant（Model: Automatic (recommended) → Change；"Show cost per answer" 开关）。现有的 3–4 行工程说明（"Free and private: nothing leaves your computer…"）压成一句或移入 tooltip。
- **兼容层收敛**：store 升到 v3，写一条 v2→v3 迁移（profiles + 明文镜像 + keychain 导入一次性完成）；`settings.ts` 目标 **≤450 行、迁移函数 ≤2**（今天 457 行兼容、7 个函数）。keychain 兜底保留一条明文路径（unsigned macOS 构建需要它，`docs/SECURITY.md:17` 已记录），但只保留"一次迁移 + 一个显式警告"。

### 2.3 支点 B · 表现层重写（UI/UE 的质变）

v17 §8.2 第 3、4 层的兑现 + 骨架收敛：

1. **原语替换手写协议**：`radix-ui` 1.8.1 的 Dialog / Popover / Menu / Tooltip / Switch / Tabs 替换 12 处手写实现；`useOverlayLock`/`useFocusTrap` 的**直接调用点从 12 处降到 ≤2 处**（保留的两个给 pdf 覆盖层这类非 DOM 浮层）。5 个手写背板删除。两个 confirm 包装（`ConfirmOverlay`/`ClearChatConfirm`）合并为一个 `ConfirmDialog`。
2. **共享原语四个**：`EmptyState`（9 → 1，带 compact/minimal 变体）、`ListRow`（15 → ≤2：一行 + 一行带次要列）、`StatusLine`（toast / inline / banner 三种命名角色，替换 8 种处理）、`Tabs`（替换两套手抄）。
3. **动效系统**：`motion` 14.2.0 负责四类——面板开合（保留 160ms token）、答案插入（FLIP）、列表增删、浮层进入/离开；CSS 只留呼吸/脉冲；`prefers-reduced-motion` 全覆盖（现有全局兜底保留）。答案里的引文点亮从瞬时改为 250ms 高亮衰减。
4. **`ChatPanel` 拆分**：`MessageList` / `MessageRow` / `Composer` + 一个 ≤12 props 的面板契约（今天 34）；`SessionProvider` 的 30 字段 context **删除**，改为两个切片（document / workbench）直接传；`useDocAgent` 的 19 个返回值收成 3 组（run / messages / history）。
5. **顶栏收敛**：一行从 9 个控件降到 **≤5 个常驻**（文件名、位置"12 / 120"、一个 overflow 菜单；缩略图/搜索/缩放进 overflow 或 hover 才显形）。
6. **阅读栏是一页纸**：面板成为一个连续 surface（删掉叠层盒子）；工具步骤成为答案下的一行脚注（17.0 已移到答案后，18.0 再压成一行）；回答动作 hover 才出现（已是 12px/7.5:1）；空会话改为"当前页建议 + 最近文件"（消灭 500px 空洞）；follow-up chip 变成答案末尾的安静一行。
7. **单例拆除**：`pdf.ts` 的 10 个模块缓存 + `agent-abort`/`agent-steer`/`agent-view-context`/`usage-tracker` 的模块状态，收进一个显式 `DocumentScope`（create/dispose），`SessionProvider.tsx:376-393` 的手写 reset 清单删除。这是"上一份文档漏进下一份"这一 bug 类的根治。

### 2.4 支点 C · 成本可见可控

1. **每一问落一行用量**（复活 `formatUsageSummaryLine`）：`读 3 页 · 4 步 · 6.2k in / 0.9k out · 缓存 4.1k · 扫描 0`——放在答案脚注（与工具行同一行或相邻），hover 展开现有 popover 的明细。不引入价格表（可选：预设模型的价格表 + 估算金额，作为 18.x）。
2. **前缀瘦身到 ≤9,000B**（今天 11,132B）：8 个工具 schema 去掉 `path`（−285B）、`maximum` 上限（−90B）、描述精简（`read_section` 492B、`document_outline` 440B 是最大两段）；系统提示裁两段（附件段落 ~600B、未扫描页段落 ~500B）。每一步都跑 `eval` + `audit:*`，用答案质量说话。
3. **预算按 token 而不是 UTF-16 字符**：`RUN_CHAR_BUDGET` 与 `chargeBudget(slice.length)` 改成按字节/估算 token 计费（消掉中文 3 倍偏差）；同时把上限从"200,000 字符"改成"约 50k token 等价"。
4. **缓存友好**：保持前缀字节稳定（已有设计：工具集固定、注记量化 4 轮）；显式打开 OpenAI 侧的 `promptCacheBreakpoint`（SDK 已支持）并把 `cachedInputTokens` 的命中率放进用量行——**缓存命中从此可见**（现在只在 popover 里）。
5. **视觉降档**：默认 1,568px→**1,024px q0.80**（≈3–4× 更小），只对 OCR 也读不好的页用 1,568；截图路径 PNG→JPEG（复用 `renderPageToJpegBytes`）；后台扫描默认 50→**20**，每题 20→**10**；在页预取计入文档用量（不再隐形）。
6. **推理档位：这一项不是提案，是观察项。** 现在已经是分步的（无材料步骤 `low`、其余全档），而且 `agent.ts:108-135` 明确记录了取舍理由。18.0 若要再动它，前提是**真机测量**（同一问题在 low/medium 下的答案质量对比，用 live 语料）——在没有这个数据前再猜一次，等于把 17.0 之前那条"只在被截断的最后一步全档"的弯路重走一遍。

### 2.5 支点 D · 沉浸

1. **材质**：`window.setEffects()`——macOS `Sidebar`/`UnderWindowBackground` 材质给轨道与面板，Windows 11 `Mica`；`setBackgroundColor` 按主题设置底色，消除启动闪变。前提：窗口 `transparent: true`、页面背景透明、权限 `core:window:allow-set-effects`（不在默认集）。**Linux 与不支持时按不透明降级**，先保证"没有效果也正确"。
2. **Zen（⌘⇧F，命令面板同条）**：轨道/顶栏/面板全部退场；页面居中、左右留白 ≥ 窗口 12%；右缘一条 2px 阅读进度发丝线；底部中央悬浮 composer（点开才展开，回车即发）；Esc 或再按 ⌘⇧F 精确恢复进入前的布局与阅读位置。首次进入给一次提示（`onboarding-hints` 已有机制）。
3. **页边（gutter）**：页面外缘承载标记与结论的点（黄=标记、紫=结论、青=批注），hover 出短注、点击滚到该处；这是"答案↔原文"锚定的可视形态（v17 §8.5 方向 B 的兑现）。
4. **阅读舒适**：面板文字大小三档（跟随设置，⌘⇧+ / ⌘⇧− 调整，存 preferences）；新增"纸"主题（暖白，对比度按现有 AA 地板验算）；页面在画布上有真实的边影（已有 `--shadow-*`，按"纸"重算一次）。
5. **不做的**：双页摊开、翻页动画、页面内嵌批注编辑器（编辑仍在侧栏/记录里完成）。

### 2.6 支点 E · 性能预算

1. **把探针收进仓库**：`scripts/perf-probe.mjs`（这次的一次性脚本清理后入库），用合成文档 + mock shell 跑，输出 JSON；CI 新增 job（与 `ui:inventory` 并列）。
2. **预算（今天实测值 → 门）**：启动可交互 ≤500ms（今 258–308）；120 页首帧 ≤1,200ms（今 589–636）；滚动 p95 ≤20ms 且 >50ms 帧 0（今 16.7/0）；流式 p95 ≤20ms 且长任务 ≤2（今 16.7/1）；缩略图首张 ≤400ms（今 123）；60 条会话渲染 ≤1,500ms（今 633）；答案后堆 ≤80MB（今 33.9）。
3. **补测三个从未测过的场景**：100MB 级扫描件打开（时间 + 峰值内存）、500 页文档搜索（首命中时间）、100 轮会话（渲染 + 请求体）。
4. **首屏包瘦身**：`ai` chunk（634KB / gzip 160KB）从 `index.html` 的 modulepreload 里拿掉，改为打开文档后动态加载（聊天在打开文档前不可用）；`pdf` chunk 保留。目标：首屏解析 ≤400KB gzip。
5. **大文件内存**：位图缓存 128MB 与字节缓存 3 份是硬上限（`pdf.ts:22,36`）；18.0 加一条"打开 100MB 件后堆 ≤ 文件大小 ×3"的预算断言，超了就先缩位图缓存。

### 2.7 为什么这是质变，而不是加功能

- **配置**：读者面对的概念从 3 个（提供商/助手模型/扫页模型）降到 1 个（提供商）；首问 6 击 → 2 击。
- **表现层**：不是换皮——是把手写协议、空态、行、状态、tab 五类骨架收敛成 4 个原语 + 一个编译器，界面里"每个角落都略有不同"这件事从根上消失。
- **成本**：从"看不见"到"每问一行 + 缓存命中可见 + 中文不再被收 3 倍"。
- **沉浸**：从"工作台三件套常驻"到"读的时候界面退场"，且这是唯一一层能让老读者一眼看出"这不是聊天窗"的东西。
- **性能**：从"感觉"到"门"——已经健康的路径不许回退，没测过的路径开始有数字。

---

## 3. 交付包与顺序

| 包 | 内容 | 依赖 |
|---|---|---|
| 包 0 · 度量与门 | 收 `perf-probe` 入库 + CI job；`eval:cost`（按字节估算 token 的成本报告）；三个新场景的基线数字 | 无 |
| 包 1 · 配置 | setup 单页 + 设置收敛 + store v3 迁移 + "Set active" 删除 + 文案压缩 | 无（与包 2 解耦） |
| 包 2 · 表现层 | Radix + motion + React Compiler；一次一条路径（菜单 → 对话框 → 抽屉 → 面板 tab）；4 个共享原语；`ChatPanel` 拆分；`SessionProvider` 删除；单例拆除 | 包 0（截图/DOM 断言先就位） |
| 包 3 · 成本 | 用量行 + 前缀瘦身 + token 预算 + 缓存提示 + 视觉降档（推理档位只做 live 测量，不改） | 包 0（`eval:cost` 做前后对比） |
| 包 4 · 沉浸 | 材质 + Zen + gutter + 纸主题 + 文字档 + 顶栏收敛 + 空态重做 | 包 2（顶栏/面板结构先稳定） |
| 包 5 · 收尾 | README/CHANGELOG/`eval/README` 数字；截图集；18.0.0 发布 | 全部 |

---

## 4. 验收（全部可测）

**配置**
1. 未配置时打开设置 = setup 单页；从应用打开到首问 ≤ **2 次点击 + 1 次粘贴**（今天 6 击）。
2. 设置抽屉 ≤ **12 行、≤3 组**；不存在超过约 90 字符的说明文案；不存在"Set active"概念（UI 与文案）。
3. 未配置时设置落在 setup 页（修 `initialTab`/`lastSettingsTab` 的默认）。
4. `settings.ts` ≤450 行、迁移函数 ≤2 个；v2→v3 迁移测试覆盖（profiles/明文镜像/keychain 三条输入）。

**表现层**
5. `useOverlayLock`/`useFocusTrap` 直接调用点 ≤2；`raw-button:` 理由数从 47 降到 ≤20（被原语替换，不是重新解释）。
6. `EmptyState` 实现 = 1；列表行类族 ≤2；状态播报处理 = 3 个命名角色；tab 实现 = 1。
7. z-index 裸数字 = 0（全部走 token）；`!important` ≤4 处（今天 9 处 4 规则）。
8. `ChatPanel` ≤250 行、props ≤12；`SessionProvider` 的 30 字段 context 删除；`useDocAgent` 返回值 ≤8。
9. 动效：面板开合、答案插入、浮层进入离开、引文点亮四处有过渡；`prefers-reduced-motion` 下全部瞬时（两种状态各断言）。
10. 截图集（浅/深各一）：welcome、空会话（有文档）、setup 单页、设置、流式答案、settled 答案、Zen、页边 gutter。

**成本**
11. 每个 settled 答案有一行用量（页数/步数/输入输出 token/缓存命中/扫描次数），数据来自已记录的 metadata。
12. 固定前缀 ≤ **9,000B**（今天 11,132B），且 `eval` 六套件与 `audit:*` 全绿。
13. 运行预算按 token 等价计（中文与英文的 token 上限一致，误差 ≤20%）。
14. 视觉默认 ≤1,024px q0.80；截图路径为 JPEG；后台扫描默认 ≤20、每题 ≤10；在页预取的调用计入文档用量。
15. 缓存提示已启用且 `cachedInputTokens` 出现在用量行（OpenAI/DeepSeek 路径）。

**沉浸**
16. ⌘⇧F 进出 Zen：Zen 下轨道/顶栏/面板高度为 0、页面宽度 ≥窗口 70%、composer 可键盘到达、Esc 精确恢复。
17. 材质：macOS/Windows 真机有材质且随主题切换；无支持时（Linux）底色正确、无透明洞（**真机项，本环境只能验降级**）。
18. gutter 点在当前页有标记/结论时出现，可键盘到达，点击滚到对应位置。
19. 面板文字三档可调且持久；"纸"主题对比度满足现有 AA 地板（用现有对比度脚本验算）。

**性能**
20. `perf-probe` 入库并在 CI 通过 §2.6 的七条预算；三个新场景（100MB 件、500 页搜索、100 轮会话）有基线数字且不回退。
21. 首屏 gzip 解析 ≤400KB；`ai` chunk 不在首屏 preload。

---

## 5. 候选对比

**配置收敛的三种做法**

| 方案 | 判断 |
|---|---|
| A · setup 单页 + 模型自动（**建议**） | 唯一把"提供商/模型"概念从首问里拿掉的做法；与 per-provider profile 兼容；迁移面小 |
| B · 保留现面板，只把模型收进 Advanced | 改动最小，但读者仍要理解"浏览 vs 生效"（Set active）与扫页模型；6 击只降到 4 击 |
| C · 内置免 key 的默认提供商 | 拒绝：成本与条款不可控，且离线承诺会被破坏 |

**组件栈**

| 方案 | 判断 |
|---|---|
| Radix 1.8.1 + motion 14.2.0 + React Compiler 1.0.0（**建议**） | v17 已评估；三者同包一次引入；直接删掉 12 处手写协议与手写 memo |
| Base UI rc | 未 GA，不采纳 |
| 自己抽一个 Overlay 原语（不引库） | 便宜，但 12 处行为已经分叉，抽出来仍要逐处迁移；无障碍（层叠/焦点/滚动锁）自研成本高于引入 |

**沉浸**

| 方案 | 判断 |
|---|---|
| Zen 开关 + 材质 + gutter（**建议**） | 显式开关可发现、可恢复；材质与 gutter 独立可用 |
| 常驻"轻 chrome"（hover 才显形） | 拒绝：隐藏入口在桌面端是反模式（读者找不到翻页/搜索） |
| 只做材质 | 不够：材质是精致感，不是沉浸感 |

---

## 6. 风险

- **表现层重写是最大的一次性风险**（12 处浮层 + 47 个手写按钮）。消化方式：一次一条路径 + 守卫不放松（`raw-button` 理由要**减少**，不是重新解释）+ 每个包跑 `ui:shots` 与 `ui:inventory`。
- **React Compiler 会暴露 Rules of React 违规**：先跑 `eslint-plugin-react-hooks` 的 compiler 规则热身，再开编译器。
- **材质与真机**：本环境（Linux + Chromium）只能验降级路径；macOS/Windows 需要在真机上补验（v17 的 §9.4 同样列出过）。
- **Zen 的可发现性**：首用提示 + 命令面板条目 + README 一句。
- **成本裁剪影响答案质量**：每一步裁剪都跑 `eval` 六套件 + `audit:citations/tables/claims`；`agent-tool-prefix.test.ts` 的摘要值随裁剪更新（它是"这次裁剪花了什么"的记录）。
- **store v3 迁移丢 key 是最高代价的 bug**：迁移测试必须覆盖"只有 keychain"、"只有明文镜像"、"两者都有且不一致"三种输入（现有 `settings.test.ts` 656 行是基础，扩展不删）。
- **配置与表现层同版本发布**：两个大改动在同一版本里，回归定位会变难；用"包 1 先合、包 2 后合"的顺序缓解。

---

## 7. 依赖与可用能力（2026-10-14 核对）

方法：`npm view <pkg> version` 与 crates.io API 逐个查询（当天）；能力来自上游文档/包内代码。**没有 major 落差**。

| 包 / crate | 仓库 | 最新 | 18.0 用法 |
|---|---|---|---|
| `radix-ui` | 未装 | **1.8.1** | 菜单/弹出/对话框/抽屉/工具提示/开关/tab 原语（替换 12 处手写协议） |
| `motion` | 未装 | **14.2.0** | 面板开合、答案插入（FLIP）、列表增删、浮层进入离开 |
| `babel-plugin-react-compiler` | 未装 | **1.0.0** | 自动记忆化；删手写比较器（配 `@vitejs/plugin-react` 6.1.2 的 preset） |
| `@tanstack/react-virtual` | 未装 | 3.14.19 | **暂不需要**：60 条消息实测 633ms 渲染、滚动零丢帧；记录在案，等 100 轮场景的数字再定 |
| `shiki` | 未装 | 4.5.0 | 暂不需要（论文/代码高亮不是本版主题） |
| `ai` / `@ai-sdk/react` / `@ai-sdk/openai` | 7.0.140 / 4.0.143 / 4.0.93 | 同 | 已是最新；`providerOptions.openai.promptCacheBreakpoint` 可用（未用） |
| `pdfjs-dist` | 6.4.299 | 6.4.299 | 已最新；上游 `textLayer.update()` 不再重排（`049f59a`，未发版）列入观察 |
| `react` / `react-dom` | 19.3.0 | 19.3.0 | 已最新 |
| `lucide-react` | 1.56（^1.48） | **1.57.0** | 顺手升 |
| `vite` / `vitest` / `playwright` / `jsdom` / `zod` | 8.3.4 / 5.0.4 / 1.64 / 30.1.2 / 4.6.7 | 同 | 已最新（v17 升过） |
| `tauri` / `tauri-build` | 2.12.3 / 2.7.2 | 同 | `setEffects` + `setBackgroundColor`（材质；权限不在默认集） |
| `tauri-plugin-store` / `-window-state` | 2.5.0 / 2.5.0 | 同 | 已最新（3.0.0-alpha 不采纳） |
| `keyring` | 4.2.0 | 4.2.0 | 已最新；v3 迁移里保留 `v1` shim |
| `pdf-inspector` | 1.25.2 | 1.25.2 | 已最新（`extraction-drift.yml` 周度跟踪） |

---

## 8. 核验记录

### 我实测的（本次）

- 构建：`npm run build` 1.25s，8 chunk；尺寸见 §1.2（index 330KB/gzip 110KB、pdf 521KB/156KB、ai 634KB/160KB、vendor 210KB/66KB、markdown 154KB/46KB、ChatPanel 56KB、PreviewPane 44KB、CSS 75KB/13KB、worker 1.32MB）；`check:*` 全绿（i18n 480 键、entitlements 3 项、bundle 8 chunk 无 console）。
- 性能：§1.2 全表（三次运行范围；探针含 rAF 帧间隔、longtask、槽位、堆）。
- 长会话：60 条消息 633ms 渲染、滚动零丢帧、30 轮历史下请求体 17,864B / 31 条消息。
- 成本：前缀 11,132B（系统 4,041 + 工具 7,091）用应用自己的模块跑出，与 `agent-tool-prefix.test.ts:44-53` 的摘要值一致；语料页正文中位数字（`eval/out` dump）；视觉图片 85–218KB（ImageMagick 按应用参数复现）。
- 配置：18 字段 / 34 控件 / 94 文案 / 首问 6 击（来源计数 + `docs/ui-shots/05-settings.png` 交叉核对）。
- 版本：12 个 npm 包 + 6 个 crate（当天）。
- 截图：`ui:shots` 13 张 + `01/02/05/07b` 逐张看过。
- CI：`444b841`（v17.0.0）全绿，含 v17 新增的 `eval` 与 `ui-inventory` 两个 job，Release 三平台构建 + 发布 6 个产物（订阅通知）。

### 读代码（未运行）

- `pdf.ts` 的 10 个模块缓存与上限（`MAX_CACHE_BYTES` 128MB、`MAX_TEXT_LAYER_CACHE` 40、`MAX_PDF_BYTES_CACHE` 3）；`lib.rs:262` 的 `MAX_READ_BYTES` 256MiB 与 `tauri::ipc::Response`（raw bytes，不是 JSON 数组）。
- `reading.ts` 的预算与计费方式（UTF-16 `length`）；`agent.ts` 的步数/输出上限/推理档位；`compact-run-messages.ts`/`history-window.ts` 的阈值；`vision-api.ts`/`index-queue.ts` 的视觉策略。
- `settings.ts`/`types.ts`/`model-capabilities.ts` 的迁移与能力探测；`MessageAssistantFooter.tsx:455` 的用量 popover；`message-metadata.ts:195` 的无调用点函数。
- `tokens.css:243`（两主题）、`setEffects` 全仓零命中、`preferences.ts` 的字段表。

### 代理核对、我复核的

| 代理结论 | 我的复核 |
|---|---|
| 12 个文件手写 Escape/背板、5 个背板按钮 | 采纳（含 `ConfirmBar` 手写焦点与 `MarkNote`/`PreviewToolbar` 的 Esc） |
| 9 套空态 / 15 种行 / 24 个播报点 / 8 种处理 | 采纳（分组口径已注明是类名 + 渲染点归纳） |
| z-index 9 个裸值、20 处声明 | 采纳（`preview.css:380` 的 350 是最大的漂移） |
| 配置 18 字段 / 34 控件 / 6 击 | 采纳；"首问 6 击"我用截图核对了"设置默认开在 General"这一环 |
| `agent-tool-prefix.test.ts` 的旧 token 数字（1,269/1,472） | **不可复现**：同一批工具按 OpenAI wire 形式是 7,091B ≈2,650–3,180 token；文件里的数字按历史估计对待 |
| 工具 schema 可裁 ~823B（path/maximum/$schema） | 采纳前两项（285+90B）；`$schema` 的 448B 属 SDK 序列化细节，留待实测 |

### 未验证

- 真机：macOS vibrancy / Windows Mica、WebKitGTK 的渲染与字体、IME、真实键盘上的 ⌘⇧F；**材质只能真机验收**。
- 扫描件索引在真机上的吞吐（本环境的 OCR 数字来自 `eval/README.md` 的 14.0 语料记录，未在本次重跑）。
- 100MB 级文件、500 页搜索、100 轮会话（18.0 包 0 才补）。
- 真实模型的每问成本（需要 key；本次所有 token 数为按字节的估算，仓库内没有 tokenizer——已确认 `node_modules` 只有 `js-tokens`）。
- `cargo test`/release 构建（本环境可跑 `cargo check`；release 三平台在 CI）。
