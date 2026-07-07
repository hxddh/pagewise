# PageWise v3.1.0 架构与代码审查报告

日期：2026-07-06 · 审查范围：`main`（3b5fdae，v3.1.0）全量源码（~17.5k 行 TS/Rust）、配置与文档。
方法：四路并行深度审查（Agent/聊天管线、文档/索引管线、Rust 后端与安全、UI 与文档一致性），每个发现均追踪完整调用链核实；TypeScript 类型检查零错误、166 个单元测试全部通过（Rust 侧因审查环境缺 GTK 未能编译验证）。

---

## 一、总体评价

代码质量明显高于同类项目平均水平：分层清晰（UI hook → 自定义 ChatTransport → ToolLoopAgent → 纯函数工具；Rust 侧 10 个 IPC 命令全部经 `ensure_allowed` 收口）、异步卫生纪律好（序列号守卫、promise 链锁、防御性解析所有持久化数据）、Markdown 渲染对 LLM 输出的 XSS 防护完备、密钥处理与 SECURITY.md 声明相符。

但 v3.0.0 一天之内的 greenfield 重写留下了系统性的**改名漂移**和**半吊子生命周期**问题：最严重的一组 bug 都源于"工具/模块改名后，散落在别处的字符串字面量没跟上，而测试与实现共享同一份陈旧字面量所以依然全绿"。文档层面 README 仍在描述 v2 架构（Tesseract OCR、多会话、DirectChatTransport），与现实严重脱节。

---

## 二、高危问题（建议立即修复）

### H1. 工具改名漂移：提示词指挥模型调用不存在的工具
`agent-view-context.ts:93,103`、`agent-runtime-context.ts:44`

Agent 实际注册的工具只有 `document_outline` / `read_pdf_page` / `read_pdf_range` / `search_in_document`（`agent.ts:139-404`），但注入的指令仍引用已删除的 `get_document_index` 和 `list_documents`。用户问"总结整个文档"→ 触发 whole-document 指令 → 模型按指令调用 `get_document_index` → AI SDK 产生 `NoSuchToolError`，在 12 步 `stopWhen` 预算里空烧步数；路径被拒时提示"call list_documents"更是给了一个不存在的恢复手段。**这命中的是最常见的使用路径。**

### H2. `document_outline` 输出永不裁剪，token 预算设计整体失效
`prune-chat-history.ts:3-8`

`PRUNE_TOOLS` 名单里写的还是旧名 `get_document_index`，真实工具 `document_outline` 不在名单内。该工具对**每一页**返回 `{page, chars, preview(160 字符)}`——500 页 PDF 约 100KB JSON——既在每个后续轮次原样重发给 provider（`RUN_CHAR_BUDGET` 防上下文爆炸的设计被绕过），也未压缩地持久化到磁盘。系统提示词又明确要求"读大文档前先调 outline"，所以最坏情况就是必然情况。同源漂移：`tool-steps-summary.ts:32,50,88` 也还在 switch 旧名，outline 调用在 UI 里只显示成通用的"Working…"。

### H3. 重建索引清空全部页面文本，但只重建前 50 页
`index-queue.ts:187-191` + `doc-cache.ts:75-90`

`reindexDocument` 先调无参 `invalidateIndexedPageText(path)`——清空**所有** ≥20 字符的页面文本（包括来自 Rust 原生 PDF 提取、根本不需要 vision 的文本）——随后的重扫却 `slice(0, MAX_INDEX_PAGES=50)`。对 200 页文本型 PDF 点一次"Reindex"：全部 200 页文本被抹掉（`MAX_CACHED_DOCS=1`，没有任何路径会重新触发 Rust 提取），vision 只补回 1–50 页，51–200 页从此搜索（应用内搜索和 agent 的 `search_in_document`）静默返回空；同时浪费 50 次 vision API 调用去替换本来就有的原生文本。

### H4. 被取消的索引把页面永久卡在 "indexing" 状态
`index-queue.ts:114-129, 64-79`

`runIndexPage` 对 in-flight promise 去重，但 await 到一个**已被取消的旧代**promise 后直接 return，不重跑；而被中止的 `indexPage` 在发出 `status:"indexing"` 事件后静默退出，从不发终态。用户在扫描进行中点 Reindex：新工作池同步启动时旧 promise 还在 `pageInflight` 里，对应页面被跳过且最后状态停留在 "indexing"——`PreviewPane.tsx:43` 据此永久阻止按需索引，重试按钮又只在 `failed` 态出现。当前文档内没有任何恢复路径（只有切换文档才清状态）。

### H5. 设置面板"放弃并关闭"实际会保存被放弃的修改
`useDebouncedSave.ts:89-95` + `SettingsDrawer.tsx:311-319`

`useDebouncedSave` 的卸载清理在 `dirty` 时无条件 `persist()`；而"Discard & close"的 `onConfirm` 只是 `onClose`（没有任何 revert/清 dirty 的路径）。用户改了模型/Base URL/贴了半截 API key → Esc → 确认"放弃并关闭" → 抽屉卸载 → 清理函数把被放弃的内容原样写入（含把半截 key 写进钥匙串/明文镜像，可用的配置被 `connectionVerified:false` 的垃圾覆盖）。确认框的承诺被直接违反。

### H6. 恶意/畸形 PDF 可让整个应用即刻崩溃
`src-tauri/Cargo.toml:36`（`panic = "abort"`）+ `pdf.rs:141-158`

PDF 解析走 `pdf_extract` 0.12——该 crate 对对抗性输入内部会 `panic!`/`unwrap()`。工作虽在 `spawn_blocking` 里，但 release 配置 `panic = "abort"` 使任意线程 panic 直接 abort 整个进程，`catch_unwind` 也救不了。打开一个精心构造的 PDF = 应用秒退、未保存聊天丢失。修复方向：子进程隔离解析，或去掉 `panic = "abort"` 并 `catch_unwind` 阻塞闭包。

---

## 三、中危问题

### M1. 安全边界：三个机制叠加把"渲染器被攻破"放大成"任意 $HOME 读取 + 外传"
- **白名单由不可信渲染器自行填充**（`lib.rs:39-48`）：`register_allowed_path` 对任意存在的路径放行，无对话框来源校验。Rust 侧 `ensure_allowed` 确实在每个文件命令上强制执行（这点做对了），但名单内容渲染器说了算——它只防"前端不小心传错路径"，不是对抗恶意渲染器的边界。
- **`assetProtocol` scope 为 `$HOME/**`**（`tauri.conf.json:24-29`）：`convertFileSrc` 走 asset 协议，遵守的是这个 scope 而非 Rust 白名单——渲染器可直接读 $HOME 下任意文件为 blob。建议收紧到已打开文档所在目录。
- **CSP `connect-src https:` 无主机限制**（`tauri.conf.json:23`）：自带端点的设计所需，但意味着页面内任何数据可 POST 到任意 HTTPS 主机；LLM 工具循环中的提示注入是现实触发器。
当前唯一防线是 `script-src 'self'` + 全代码库确无 HTML 注入 sink（已核实：无 `dangerouslySetInnerHTML`、无 `rehype-raw`）。对一个以"喂不可信 PDF + 不可信 LLM 输出"为本职的应用，这个边界偏薄。

### M2. 图片文档聊天把本地 asset URL 直接发给云端 provider
`pdf.ts:945` + `useDocAgent.ts:286-300`。PDF 页渲染成 `data:` URL（正确），图片类文档却传 `convertFileSrc(path)`——只有 Tauri webview 内可解析的 `asset://` URL。OpenAI 等服务端拉取必然失败；能否降级取决于错误文案恰好匹配 `isImageInputError`（`llm.ts:113-129`），否则用户看到硬错误。**图片文档 + 云端多模态 = 截图永远到不了模型。**

### M3. 文档快速切换会持久化被截断的聊天快照
`SessionProvider.tsx:171-183`。`messagesToSave = [...agent.messages]` 是点击那一帧的陈旧闭包；`waitForStreamIdle` 中止流后的收尾内容落在后续渲染里。500ms 自动保存本可补救，但新文档在 500ms 内加载完成（小文件/缓存命中）时清理函数把定时器取消——被截断的快照成为最终持久化结果。切回来会看到助手消息比刚才看着流出来的短。另：全应用没有 `beforeunload`/关窗 flush，退出时最后 ≤500ms 的聊天必丢。

### M4. 取消索引不会中止在途 vision 请求（烧钱）
`index-queue.ts:81-84`。队列的 abort signal 没传给 `generateVisionText`——只传了独立的 60s 超时 signal，await 后也不复查 abort。切换文档后旧文档最多 3 个 vision 请求继续跑满 60s，与新文档扫描并发（最多 6 路），白烧 token 和限额。应改 `AbortSignal.any([signal, timeout])` + await 后复查。（已核实晚到的结果不会写错文档——`upsertPageText` 按路径键控且 remove 后 no-op，纯成本问题。）

### M5. 取消被误报为"索引失败"
`index-queue.ts:98-111`。catch 不区分 `AbortError`，取消一律 emit `status:"failed"`+"need vision"，误导用户去改设置；且晚到的 failed 事件会在 `clearDocumentIndexState` 之后重新污染状态 map，重开文档可能带着陈旧的 failed 徽章。

### M6. vision 页面渲染尺寸超约定 ~4.4 倍
`pdf.ts:879-932`。`maxEdge` 拿**未缩放**的页面边长（PDF 点）比较：US-Letter（792pt < 1568）走 300DPI 分支渲染出 2550×3300px，几乎所有真实 PDF 都违反 1568px 约定——payload、vision token 成本、webview 内存全部放大。正确逻辑是 `scale = Math.min(OCR_RENDER_SCALE, maxEdge / edge)`。

### M7. 反循环守卫是死代码，测试在为不存在的行为背书
`agent-loop-guards.ts:52-74`。`isMetaToolOnlyLoop`/`shouldForceReadTools`/`getBlockedMetaTools` 有导出、有单测，但生产代码零调用——`createDocAgent` 从未接线。实际唯一的循环边界是 `stepCountIs(12)`。守卫内部引用的还是幽灵工具名（同 H1），即使接上也是半空转。

### M8. 未知 OpenRouter 模型被默认判定不支持工具，agent 直接拒发
`model-capabilities.ts:127-134` + `llm.ts:209-222`。静态白名单只有 ~10 个 OpenRouter 条目，未列出的（如 `openai/gpt-4.1`、较新的 Claude 路由）一律返回 false 并硬阻断发送，错误文案还断言"该模型不支持工具调用"。开放目录用静态默认拒绝名单，且用户无法覆盖。

### M9. `useTheme` 双实例状态漂移
`useTheme.ts:15-29` 在 `App.tsx:50` 和 `GeneralSettings.tsx:58` 各建一份互不同步的本地状态：命令面板"Cycle theme"用陈旧基准（第一次按无效果）；在抽屉里切到"System"后，唯一的 `matchMedia` 监听随抽屉卸载消失——此后 OS 主题切换失效直到重启。

---

## 四、低危 / 卫生问题（摘选）

| # | 位置 | 问题 |
|---|------|------|
| L1 | `useDebouncedSave.ts:56-74` | 编辑后改回原值：快照相等时跳过保存但不清 dirty，"Unsaved" 永久悬挂并触发虚假放弃确认 |
| L2 | `chat/persist.ts:12-19` | 首次 `Store.load` 失败的 rejected promise 被永久缓存，此后整个进程聊天持久化静默全灭（自动保存错误又只在 DEV 打日志） |
| L3 | `index-events.ts:41-49` | `clearDocumentIndexState` 删完立刻被 `emitPageIndex(idle)` 重新 set，与自身注释承诺的"防 map 无限增长"相反；单测还断言了这个泄漏 |
| L4 | `Markdown.tsx:31-59` | `SafeAnchor`/`SafeImg` 把 react-markdown 的 `node` prop 透传到 DOM，每条含链接/图片的消息刷 React 未知属性告警 |
| L5 | `SessionProvider.tsx:295` vs `useAppCommands.ts:64` | 两套"导出聊天"实现，文件名不一致（`report.pdf-chat.md` vs `report-chat.md`） |
| L6 | `useConnectionStatus.ts:38-47` | 设置读取失败时硬编码回退 `openrouter`，与全局默认 `deepseek` 不一致 |
| L7 | `secrets.rs:24-47` | 钥匙串命令是同步 `#[tauri::command]`，跑在主线程，macOS 授权弹窗/DBus 往返会冻结窗口 |
| L8 | `lib.rs:223-234` | `write_text_file` symlink 检查存在 TOCTOU 窗口且新文件跳过检查（需本地攻击者，影响低） |
| L9 | `index-queue.ts:151-155` | `ensurePageIndexed` 不处理已 aborted 的 signal（监听器永不触发），Stop 后仍可能发出一次付费 vision 请求 |
| L10 | `pdf.ts:431` | `pdfBytesCache` 命中不更新 recency，LRU 实为 FIFO（影响近零） |
| L11 | `agent.ts:469` | `documentTools` 死导出，且共享一个永不重置的字符预算——若被使用会在 120k 字符后永久枯竭 |
| L12 | `DocumentSearch.tsx:103` | 标注 `aria-modal` 但无焦点陷阱（其它 overlay 都有） |
| L13 | `usePdfViewer.ts:36-41` | 持久化 zoom 未 clamp，损坏的 localStorage 值可产生零尺寸画布 |

---

## 五、文档问题

1. **README 仍在描述 v2**（高危级误导）：宣称 Tesseract OCR 是特性且为"硬前置依赖"（含 brew 安装指引、架构图里的 Tesseract）——v3.0.0 已整体移除 OCR/Tesseract，代码里无 `ocr.rs`、无 tesseract 依赖，`index-queue.ts` 自述 "vision-only, No OCR"。用户会装一个无用的包，并期待一个不存在的功能。`CONTRIBUTING.md:11` 同病。
2. **README 架构图引用不存在的 `DirectChatTransport`**——实际是自定义 `PagewiseChatTransport`（`pagewise-chat-transport.ts:37`）。
3. **README "Library — Recent files and saved sessions" / "Per-document chat threads"（复数）过时**——v3 是每文档单线程，Library 只剩最近文件。
4. **SECURITY.md 写错聊天存储文件名**：`sessions.json` → 实为 `pagewise-v3-chats.json`（`chat/persist.ts:6`）。安全文档里指错"你的聊天内容在哪个文件"不合适。
5. **CHANGELOG 从 0.2.45 到 3.1.0 全部同一天**，三个 major 一天发完，作为历史记录的可信度受损。
6. 核实无误的部分：版本号四处一致（3.1.0）、scripts 表、provider 列表、i18n（en/zh-CN 键集完全一致）、钥匙串平台表与 keyring features 相符、RELEASE.md 与 CI 工作流相符、密钥明文镜像仅在钥匙串不可用时写入且会回迁——SECURITY.md 的核心声明成立。

---

## 六、设计缺陷（根因层面）

1. **工具身份没有单一事实来源。** 工具名以字符串字面量散布在 6 个模块；`document_outline` 一次改名静默击穿提示词、prune 名单、循环守卫、UI 摘要四处，而**测试与实现共享同一份陈旧字面量，全绿通过**。应从 `keyof ReturnType<typeof createDocumentTools>` 派生所有名单，把这类漂移变成编译错误。H1/H2/M7 会一起消失。

2. **模块级单例侧信道。** `agent-view-context`、`agent-abort`、`agent-progress`、`usage-tracker` 都是进程全局量，绕过 transport 把每次运行的状态从 React 层走私进 `prepareCall`/工具。正确性完全依赖 `isAgentBusy` 严格串行——今天成立，但后台索引已经造成第一个症状（vision 用量被记到并发聊天消息头上）。AI SDK 的 `runtimeContext`/`toolsContext` 是现成的正规通道。

3. **手写并发令牌过多。** 五个独立代数计数器（`agentGenRef`/`sendGenRef`/`streamAgentGenRef`/`pruneChatIdRef`/`epochRef`）+ 三个定时器 + 一个 10s 轮询协调同一个生命周期，每个都是为修某个具体 race 加的。不变量不在任何人脑子里，M3 正是这种土壤长出来的。建议收敛为 hook 持有的单一 "run token"（每次发送创建、切换时失效）。

4. **索引队列的取消是半实现。** 有检查点但不中止 fetch、中止不发终态、去重不感知代数——于是每条中止路径要么撒谎（failed）要么卡死（indexing）。一次小重构（`AbortSignal.any` 进 fetch、abort 时发终态、inflight 条目带代数并在陈旧时重跑）可一并修掉 H4/M4/M5/L9。

5. **`MAX_INDEX_PAGES = 50` 是埋在三层之下的隐性产品限制。** 它静默限制大扫描件的搜索召回，还与无上限的 invalidation 组合出 H3。这个上限应当成为用户可见的一等概念。

6. **信任边界与产品定位矛盾。** 安全模型假设渲染器可信，而应用的本职是把不可信 PDF 字节和不可信 LLM 输出喂进渲染器。白名单自注册 + `$HOME/**` asset scope + 开放 `connect-src` 三者叠加，使"一个 XSS/供应链问题"与"任意 $HOME 读取 + 外传"之间只隔着 CSP `script-src 'self'`。建议：PDF 解析出主进程（同时修 H6）、asset scope 收窄到文档目录、在文档中把白名单定位为纵深而非边界。

---

## 七、修复优先级建议

1. **一小时内可完成的高收益修复**：H2（prune 名单改名）、H1（提示词工具名）、H5（discard 路径清 dirty）、M5（识别 AbortError）、L2（rejected store promise 重置）、L4（解构掉 `node`）、README 的 Tesseract/架构段落。
2. **半天级**：H3（invalidate 尊重上限或按需重提取）、H4+M4（索引队列取消重构）、M2（图片文档改走 data: URL）、M3（经 ref 读 messages + 关窗 flush）、M6（缩放公式）、M9（useTheme 提升为共享状态）。
3. **架构级（排期做）**：工具名单一事实来源、单例侧信道迁移到 runtimeContext、run-token 收敛、PDF 解析进程隔离、asset scope 收窄。

## 八、值得肯定的部分（核实为佳）

- 无命令注入面（Rust 后端零 `Command` 调用）；生产 Rust 无 unwrap/panic 路径；密钥不入日志（FNV 指纹 + redact 层）。
- "陈旧结果写错文档"这类经典 bug 不存在：三套独立守卫（React epoch、pdf.js epoch/active-path、Rust per-scope cancel generation）互为冗余，全部核实有效。
- Markdown/LLM 输出渲染的 XSS 防护完备；i18n 键集 en/zh 完全一致；持久化数据全部防御性解析。
- `document-search.ts` 的 NFC 归一化 + 逐码位 case-fold + 偏移映射处理了变长折叠（如 İ），实现严谨。
