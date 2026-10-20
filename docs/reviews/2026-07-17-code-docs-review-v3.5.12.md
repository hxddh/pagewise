# PageWise v3.5.12 代码与文档审查

日期：2026-07-17 · 基线：`main`（`f6f8ddf`，v3.5.12）。
方法：两轮对抗性深挖。第一轮：Agent 工具环 / Chat·流式·持久化 / 文档管线·Rust·安全。第二轮：transport·LLM·settings / preview·follow / session·prefs·文档漂移。高危项均对照源码二次核实。不重复 CHANGELOG 3.5.9–3.5.12 已宣称已修且核实属实的项。

整体结论：v3.5.x 硬化后，经典竞态与历史损坏类问题明显收敛；第一轮新发现集中在 **(1) Agent 对「空页 / 未索引 / 元工具空转」的误判**、**(2) 整篇意图仍被关键词漏检**、**(3) 写路径 allowlist 与文档声明不一致**、**(4) Chat 切换/裁剪对用户可见 grounding 的高估**。第二轮（流式/设置/预览/偏好）追加 **(5) Discard 竞态仍可能写脏设置**、**(6) 关窗 flush 失败仍销毁窗口**、**(7) Web search / 工具能力启发式误挡 Agent**。

---

## 一、确认发现（按严重度）

### A1. 高危 — 显式页读把 vision/索引失败当成「空白页」
**类别：** Bug / AI-limit  
**位置：** `src/lib/agent.ts:145-160`，`src/document/index-queue.ts:143-175`

`readPageText` 在 native 文本不足 `MIN_INDEX_CHARS` 时走 `ensurePageIndexed`，随后一律 `after?.text ?? ""` 并以 `source: "vision"` 返回。`indexPage` 对 API/模型/扫描失败只发 UI `failed` 事件，**不向调用方抛错或附带失败原因**；短 native 文本也会被丢弃。

**影响：** 扫描件、未配多模态、429、错误模型时，Agent 会把「读不了」当成「页上没字」，自信回答「文档中没有…」。

**修法：** 显式 Agent 读应返回 `indexFailed` / `error` / 保留短 native fallback；tool result 里写明「indexing failed — do not treat as empty」。

---

### A2. 高危 — 元工具循环守卫只 `stopWhen`，不强制综合回答
**类别：** Bug / Design  
**位置：** `src/lib/agent.ts:62-72, 657-662`，`src/lib/agent-loop-guards.ts`

`isMetaToolOnlyLoop` 已接入 `stopWhen`；但 `shouldForceReadTools` / `getBlockedMetaTools` **仅出现在测试**，生产 `prepareStep` 只做「最后一步 `toolChoice: none`」。重复 outline/search 触发守卫时，run 可能在 tool output 后直接结束，**没有合成答案**。

**影响：** 弱模型空转搜索后 UI 出现「无回复 / 只有工具痕迹」。

**修法：** 在 `prepareStep` 里：阻断重复 meta 工具、搜索后强制 read tools，或在 loop 触发时强制 `toolChoice: "none"` + 合成指令。

---

### A3. 高危 — `search_in_document` 不报告未索引页（UI 搜索有，Agent 没有）
**类别：** AI-limit / Gap  
**位置：** `src/lib/agent.ts:565-589`，`src/document/search.ts`，对照 `document_outline` 的 `unindexedNote`

Outline 已返回 `unindexedPages` + note；Search 只返回 `{ hits, truncated }`。后台 vision 最多扫 **50 页**（`MAX_INDEX_PAGES`），其后稀疏页对 search 不可见。

**影响：** 0 hits → 模型推断「不在文档里」，尽管相关页从未可搜。Prompt 虽写「no hits ≠ absent」，但缺结构化信号时弱模型仍常早下结论。

**修法：** Search 结果附带 `unindexedPageCount` / 页码区间 / note；可选对候选稀疏页做有界 on-demand 索引。

---

### S1. 高危 — 打开的文档路径同时可被 `write_text_file` 覆盖
**类别：** Security  
**位置：** `src-tauri/src/lib.rs:219-225`

写授权条件为「父目录 **或** 精确文件路径」在 allowlist 中。打开 PDF/图片会 `register_allowed_path` 该文件（读），同一 grant 也满足写检查 → 可把任意文本写回该路径。

**影响：** 渲染进程/前端若被诱导调用 `write_text_file`，可破坏用户原文档。当前调用点主要是导出，属纵深防御缺口。

**修法：** 读写 allowlist 分离；打开文档只授读；另存为单独授写（ ideally 带 purpose / 过期）。

---

### S2. 高危 — 「另存为」目录被持久化，与安全文档声明矛盾
**类别：** Security / Design  
**位置：** `src/lib/save-markdown.ts:19-22`，`src/lib/fs-access.ts:12-14`，`src/lib/allowed-paths.ts:78-84`

CHANGELOG / `allowed-paths` 注释称写权限限于「用户刚选的目录」；实现上 `allowPath` ≡ `allowPathPersisted`，导出父目录写入 `allowed-paths.json` 并在下次启动 `restoreAllowedPaths`。该目录下任意直接子文件均可写。

**影响：** 一次导出 → 持久写权限；与 `docs/SECURITY.md`「只注册打开的文件」叙事不一致。

**修法：** 导出用 session-only `allowPathEphemeral`；持久化仅恢复「打开过的文档读授权」。

---

### A4. 中危 — 整篇覆盖指令仍被关键词漏检（英文尤其严重）
**类别：** AI-limit / Design  
**位置：** `src/lib/page-intent.ts:9-15`，`src/lib/agent.ts:674-679`

预算/步数已不再按意图门控（3.5.9），但 `buildWholeDocumentInstructions`（outline → 分块读完全文）仍仅在 `hasWholeDocumentIntent` 命中时注入。实测：

| 用户说法 | 命中？ |
|----------|--------|
| `总结这份文档` / `全文总结` / `document summary` | 是 |
| `summarize this PDF` / `summarize this document` | **否** |
| `review every section` / `what recurs across the paper` | **否** |
| `Summarize the paper` / `summarize all 120 pages` | **否** |
| `分析这个章节` | 否（正确，section-scoped） |

**影响：** 最常见的英文「总结这份 PDF」拿不到整篇覆盖指令，容易浅读即答。

**修法：** 扩展英文 summarize/overview/review/across 模式；或对 summarize/分析类问题给轻量覆盖提示（不必等同全文脚本）。

---

### A5. 中危 — 默认 chunk × 步数天花板吃不满宣称的 200k 读预算
**类别：** AI-limit  
**位置：** `src/lib/agent.ts:42-55, 657-662`

默认 `maxChars=6_000`、`MAX_WHOLEDOC_STEPS=30`，最后一步强制不调工具 → 最多 ~29 次读 ≈ **174k**（再扣 outline/search 更少），到不了 `RUN_CHAR_BUDGET=200_000`，也难覆盖长密文档「每一页」。

**修法：** 整篇 run 提高默认 `maxChars`、按预估 chunk 扩步数，或提供高层 summarize/coverage 工具。

---

### A6. 中危 — outline/search 可冲过剩余预算且不标 `budgetExceeded`
**类别：** Bug / AI-limit  
**位置：** `src/lib/agent.ts:272-316, 568-589`

二者只在执行前检查 `budget.used >= max`；执行后 `chargeBudget(JSON.stringify(...).length)` 可把 used 推过上限，**同一次结果不带** `budgetExceeded`。页读路径会裁切并标记。

**影响：** 模型可在「已超预算」后仍继续尝试读，直到下一次调用才收到 note。

**修法：** 序列化/裁切到剩余预算，并在本次结果标记 `budgetExceeded`。

---

### A7. 中危 — 搜索按页序取前 N 条，无页多样性/排序
**类别：** AI-limit  
**位置：** `src/lib/document-search.ts`，`src/lib/agent.ts:546-589`

高频词会占满早期页的 `maxResults`，后文相关命中被截断（`truncated=true` 但模型看不到「后面还有什么」）。

**修法：** 按页分组、每页上限、返回 totalHits / 命中页列表。

---

### A8. 中危 — 系统提示与工具文案仍写「PDF only」，应用已支持图片文档
**类别：** Design / Gap  
**位置：** `src/lib/agent.ts:596-607`，工具名 `read_pdf_*`

无文档时提示「open a PDF」；有图片文档时模型可能错误推理。

**修法：** 文案改为 document/PDF/image；工具可保留兼容名并在 description 标明。

---

### C1. 高危 — 文档切换在 chat 保存失败后仍继续，可能丢上一份对话
**类别：** Bug  
**位置：** `src/session/SessionProvider.tsx:246-253` 及后续 load

`saveChat` 失败只 toast，仍 abort/load 新文档并 hydrate 新历史。上一文档未落盘的消息在内存中已被 `resetForDocumentSwitch` 清掉。

**修法：** fail-closed：保存失败则中止切换、保留当前文档与消息。

---

### C2. 高危 — `normalizeUIMessage` 整表信任 `parts`，畸形 part 可在渲染期崩
**类别：** Bug  
**位置：** `src/lib/messages-utils.ts:14-16`，`src/components/MessageContent.tsx:31-34`

行级规范化跳过坏行，但不校验 part 形状。`{ type:"text", text:123 }` 能 hydrate，随后 `.length/.slice` 抛错，挡住打开历史。

**修法：** normalize 时只保留合法 text/reasoning/file/source/tool parts；加 hydrate/render 回归测试。

---

### C3. 中危 — 历史裁剪后「Pages read」可高估截断的 range 读
**类别：** Bug / AI-limit（误导 grounding）  
**位置：** `src/lib/prune-chat-history.ts:140-150`，`src/lib/read-pages.ts:45-56`

活着的 `read_pdf_range` output 含真实 `startPage/endPage`；prune 改成基于 **input** `start–end` 的字符串后，`collectReadPages` 只能按请求范围展开 → 读到第 3 页可显示成 1–100。

**修法：** compact 保留 `{ compacted, startPage, endPage, charCount }`；`collectReadPages` 读这些字段。

---

### C4. 中危 — Stop 后 settle 路径不 `sanitizeDanglingToolParts`，「Pages read」把未完成调用算进去
**类别：** Bug  
**位置：** `src/hooks/useDocAgent.ts:219`，`src/lib/read-pages.ts:28`

Settle 只 `pruneToolOutputsForHistory`；`collectReadPages` 接受无 output 的 `input-available`。未完成读会被标成已读。

**修法：** settle/abort 先 sanitize；或 collect 要求 `output-available` 且非 placeholder。

---

### C5. 中危 — Retry/Regenerate 的 web/截图选项存在易失 ref，重载后静默丢失
**类别：** Bug  
**位置：** `src/hooks/useDocAgent.ts:164, 354, 460-467`

选项在 `lastSendOptionsRef`；文档切换/重载后按当前默认重试，可能去掉 web search 或页截图。

**修法：** 写入 message metadata，从被重试的那条消息恢复。

---

### C6. 中危 — 快速双击发送可能把已发送草稿填回输入框
**类别：** Bug  
**位置：** `src/pages/ChatPanel.tsx:164-199`

`interactionBusy` 尚未 re-render 时第二次 `submit` 仍通过本地守卫；`sendDocumentMessage` 返回 `false`（busy）后恢复草稿。

**修法：** `submitInFlightRef`；或区分 busy vs validation failure，仅后者恢复草稿。

---

### P1. 中危 — 打开 PDF 仍前端全量 Rust 抽文本，超大文档阻塞预览与 Agent
**类别：** Design / Gap  
**位置：** `src/lib/load-document.ts`，`src-tauri/src/pdf.rs`

无页数/体积上限的全量提取；大 PDF 打开阶段卡住，懒读/vision 帮不上。

**修法：** 先元数据+预览；分页/分块提取；Rust 侧时间/页数上限。

---

### P2. 中危 — Agent 读 piggyback 后台索引时，Stop 不能及时打断
**类别：** Bug  
**位置：** `src/document/index-queue.ts:187-201, 237-258`

可 await 已有 background promise；该 promise 不跟 Agent abort 绑定，最坏等到 vision timeout。

**修法：** 与 caller signal race；或 Agent 读始终自建 pass。

---

### P3. 中危 — Vision prompt 只抽「可见文字」，图表/版式/手写证据丢失
**类别：** AI-limit  
**位置：** `src/document/index-queue.ts:18`，`src/lib/vision-api.ts`

「Output only the extracted content」→ 非文本页常 `insufficient_text` 或空白描述。

**修法：** Agent 读用 richer page-understanding prompt（文字 + 表/图/版式摘要）。

---

## 二、低危 / 卫生

| # | 位置 | 问题 |
|---|------|------|
| L1 | `src/lib/agent-loop-guards.ts` | 文件含 **NUL 字节**，部分工具/编辑器当二进制打开失败 |
| L2 | `src-tauri/src/pdf.rs` 缓存键 `(mtime, size)` | 同 size + 粗粒度 mtime 替换文件可能陈旧（已知类问题，影响面有限） |
| L3 | 加密 PDF | 仅空密码尝试；无用户密码入口 |
| L4 | `PreviewPane` 图片 `asset://` | 可绕过 256 MiB IPC 读上限进入 WebView 解码（解压炸弹面） |
| L5 | `export-markdown.ts` | 导出未像 UI 一样过滤 `http(s)` / 转义链接 |
| L6 | Clear chat | UI 先空再删文件；失败时重载可「复活」旧历史且无 toast |
| L7 | `indexPageInBackground` | 无组件级 AbortSignal；关文档后可能白烧 vision |

---

## 三、第二轮追加发现（流式 / 设置 / 预览 / 偏好）

第二轮方法：三路并行（transport·LLM·settings / preview·follow / session·prefs·docs），跳过第一节已列项，高危项再次对照源码。

### U1. 高危 —「Discard & close」竞态仍可能把脏 AI 设置写盘
**类别：** Bug  
**位置：** `src/hooks/useDebouncedSave.ts:53-56, 66-95`，`src/components/settings/AiProviderSettings.tsx:237-249`

`discardPending()` 只清 `dirtyRef` / 抑制 unmount persist，**不清 debounce timer，且 `persist()` 不读 `dirtyRef`**。`handleDiscard` 在 `await loadProviderSettings` 之后才 `setDirty(false)`——等待期间 React `dirty` 仍为 true、400ms timer 仍可触发，把**尚未回滚的草稿** `saveSettings` 出去。

**修法：** timer 存 ref，`discardPending` 里 clear；`persist` 检查 discard generation / `dirtyRef`；Discard 同步 `setDirty(false)` 再 await。

---

### U2. 高危 — 关窗 flush 失败仍 `destroy()`，静默丢最后对话
**类别：** Bug  
**位置：** `src/session/SessionProvider.tsx:201-209`

`onCloseRequested` 在 `catch` 后 `finally` 里无条件 `win.destroy()`。与 C1（切文档）同类，但是关窗路径：用户以为已保存，实际最后几条可能未落盘。

**修法：** flush 失败则保持窗口、toast/对话框提示重试或「仍要关闭」。

---

### W1. 中危 — Web search 只注入 Agent 循环的**第一次** LLM 请求
**类别：** AI-limit / Design  
**位置：** `src/lib/llm.ts:82-99`

`takeWebSearchInjection` 在首次 stream 请求后把 `webSearchForRun = false`。后续在读完文档事实后再搜网的步骤**无法**再用 web plugin——「对照文档段落查最新信息」类任务系统性变弱。

**修法：** 有界多步保持 web；或独立 web 工具；至少在 prompt 提示「需外网时尽早搜」。

---

### W2. 中危 — 编辑重发静默丢掉该条的 web-search 选项
**类别：** Bug  
**位置：** `src/pages/ChatPanel.tsx:408-416`，`src/hooks/useDocAgent.ts:347-357`

编辑表单调 `editUserMessage` 不传 `webSearch`；`runAgentSend` 记成 `false`。用户编辑一条曾开 🌐 的问题会悄悄变成无搜索。

**修法：** 与 C5 一并：选项进 message metadata；编辑/重试复用。

---

### W3. 中危 — UI 用启发式 `isToolModel` **硬挡**发送，与「未知模型允许试」设计矛盾
**类别：** AI-limit / Design  
**位置：** `src/hooks/useConnectionStatus.ts:57-60`，`src/pages/ChatPanel.tsx:164-169`，`src/lib/model-capabilities.ts`

`useDocAgent` 注释写明不因工具能力启发式预挡；Composer 仍要求 `agentToolsSupported`。OpenRouter 上支持 tools 但不匹配硬编码 regex 的路由**完全无法发送**。

**修法：** 能力检查降为警告 + 可选覆盖；硬挡仅保留缺 key/model/URL。

---

### W4. 中危 — Vision HTTP 错误丢 status / raw，401·429·「不支持图片」常变成泛化文案
**类别：** Bug / UX  
**位置：** `src/lib/vision-api.ts:100-109`，`src/lib/llm.ts:291+`

非 OK 响应用 `new Error(message)` 丢掉 statusCode；OpenRouter `metadata.raw` 里的「image input not supported」也难命中专用分支。

**修法：** 保留 status + raw 传给 `formatLlmError`；补 vision 401/429/image 回归测试。

---

### V1. 中危 — Vision 失败徽章有 Settings 回调时**永远看不到 Retry**
**类别：** Bug  
**位置：** `src/features/preview/PreviewPane.tsx:132-174`

`indexHintActionable`（vision_failed ∧ onOpenAiSettings）走单按钮「开设置」分支；带 Retry 的 `indexFailed` 行不可达。生产几乎总有 `onOpenAiSettings` → 用户只能进设置，不能一键重试索引。

**修法：** 失败态统一一行，同时放 Retry + Settings。

---

### V2. 中危 — 缩略图虚拟化行高未计入 flex `gap: 8px`
**类别：** Bug  
**位置：** `src/components/ThumbnailSidebar.tsx:6,100-133`，`src/App.css:1961-1967`

`THUMB_ROW_HEIGHT=112`，列表 `gap: 8px` → 实际 pitch 120。长文档滚动/定位会漂到错误页窗。

**修法：** 单一 row-pitch 常量含 gap，或把间距放进固定高度行内。

---

### V3. 中危 — Follow-agent 可在 hydrate / `input-available` 时误跳页
**类别：** Bug  
**位置：** `src/hooks/useFollowAgent.ts:23-39`，`src/lib/page-intent.ts:129-133`

接受无 output 的 `input-available`；文档切换后 `getLastAgentMessageContext()` 为空时 `shouldFollowAgentToPage(..., null)` 返回 **true**，hydrated 历史工具 part 可把预览拽走。

**修法：** 仅跟踪当前 live run；要求成功 `output-available`；无 ctx 时不跳。

---

### V4. 中危 — Ctrl/Meta+滚轮未忽略，触控板缩放手势可被当成翻页
**类别：** Design / Bug  
**位置：** `src/features/preview/usePdfViewer.ts:183+`

`onWheel` 不检查 `ctrlKey`/`metaKey`，pinch-zoom 的 wheel 事件会累加翻页 delta。

**修法：** modifier wheel 忽略或映射到 zoom。

---

### U3. 中危 — 从 Recent 移除文件不撤销 allowlist
**类别：** Security / Privacy  
**位置：** `src/lib/recent-files.ts:100`，`src/session/SessionProvider.tsx:337`

`removeRecentFile` 只改 `recent.json`；路径仍在 `allowed-paths.json`，下次启动照样 restore。

**修法：** 导出 revoke；移除 Recent 时同步；Rust 侧可选 unregister。

---

### U4. 中危 — Follow-agent / 附带截图开关双重 `patchPreferences`
**类别：** Bug  
**位置：** `src/components/settings/GeneralSettings.tsx`，`src/hooks/useWorkbenchPrefs.ts`

父回调已持久化，子组件再写一次；失败时 UI / 父状态 / 磁盘易不一致。

**修法：** 单层所有权；异步 setter 返回成败并回滚/toast。

---

### U5. 中危 — `store:default` 权限过宽
**类别：** Security  
**位置：** `src-tauri/capabilities/default.json:7`

主窗口拿 plugin-store 全集；渲染进程沦陷即可读写含聊天/路径/明文 key fallback 的本地 store。

**修法：** 收窄到所需 store 权限，或敏感读写走校验过的 Rust 命令。

---

### 第二轮低危

| # | 位置 | 问题 |
|---|------|------|
| L8 | `useAskSelection.ts` | 选区「Ask」按钮只在 selectionchange 定位；滚动/缩放后漂离选区 |
| L9 | `remark-page-refs.ts` | 可点击引用只认 ASCII 数字；`第十二页` / 全角数字不可点（intent 解析器却支持） |
| L10 | `MessageAssistantFooter` memo | 签名只含 text 长度；等长内容更新时 Copy 可能用陈旧文本 |
| L11 | `loadSettingsMeta` + `useConnectionStatus` | 「不碰 keychain」文档不实；启动状态刷新可触发 keychain 迁移/读取 |
| L12 | Ollama「API key saved」徽章 | sentinel `"ollama"` 被当成已保存密钥 |
| L13 | 启动 `restoreAllowedPaths` | 失败路径有 toast key 但未展示；失效 Recent 仍可见 |
| L14 | i18n | 图片拒绝文案仍说关「当前页」；实际开关是「附带当前页截图」 |

---

### 文档漂移（第二轮）

| 文档 | 代码 | 漂移 |
|------|------|------|
| `docs/SECURITY.md`「临时」明文 fallback | `settings.ts` 跨重启保留至迁移成功 | 夸大「临时」 |
| README / SECURITY「什么会离开机器」 | OpenRouter web plugin 可外带查询 | 未提及 opt-in web search |
| `docs/RELEASE.md` 示例仍 `0.2.0` | `VERSION`=`3.5.12` | 过期 |
| README 扫描模型举例 Qwen2.5-VL | 当前 OpenRouter scan preset 为 Qwen3-VL | 过期 |

---

## 四、功能缺口（相对「本地文档 Agent」预期）

1. **密码 PDF / 更多格式**（加密 PDF、Office 等）无路径。  
2. **无「索引/覆盖状态」工具**：模型看不到「已索引页数 / vision 失败页 / 预算剩余」的一等公民信号（outline 部分覆盖，search/read 不足）。  
3. **Web search 仅 OpenRouter 原生插件**；其他 provider 无对等能力；且即便开启也只覆盖循环第一步（W1）。  
4. **无书签跳转后的「按章节读」一等工具**（有 outline bookmarks，但仍靠模型自己拼 range）。  
5. **表格/版式结构化读取**缺失（纯文本切片）。  
6. **多文档 / 对比**未支持（单 active doc）。  
7. 文档与 README 对安全模型的描述滞后于「导出目录持久化」实现（见 S2）及明文 key / web search（见上表）。

---

## 五、阻塞 AI 的限制（优先修复清单）

按「修了立刻提升回答质量 / 可用性」排序：

1. **A1** 失败当空白 — 直接导致幻觉式否定  
2. **A3** Search 无未索引信号 — 与 A1 同类「假阴性」  
3. **A4** 英文整篇意图漏检 — 覆盖指令根本不注入  
4. **A2** 元工具空转停跑无答案 — 用户看到空回复  
5. **W3** 工具能力启发式硬挡发送 — 可用模型被 UI 拒绝  
6. **W1/W2** Web search 一步即失效 / 编辑丢选项 — 外网对照任务不可靠  
7. **A5/A6** 步数/预算会计 — 整篇任务系统性读不完或超预算不知情  
8. **P3** Vision 只抽字 — 扫描图/表页无内容可 grounded  
9. **C3/C4** Pages read 高估 — 用户与后续回合被错误 grounding 误导  

---

## 六、对抗性核实为「当前成立 / 已修好」

- 整篇 **步数/字符预算** 不再被关键词门控（3.5.9 属实）；缺口在 **指令注入**（A4），不是静默砍预算。  
- `document_outline` / `search_in_document` 会计入 read budget（3.5.11）；残留问题是 **冲过剩余预算不打标**（A6）。  
- 发送时 history repair 优先丢掉非 user 行（3.5.12）；方向正确。  
- Outline 对 image doc 跳过 pdf.js outline（3.5.11）属实。  
- 远程图片 click-to-open + CSP（3.5.11）属实。  
- 「本页」页码与截图偏好解耦（3.5.4）属实。  
- `paintPage` 同 canvas 上会 `prev?.cancel()`（第二轮「翻页不取消 render」指控部分被现有守卫削弱；未升格为确认项）。

---

## 七、建议修复批次

**Batch 1 — Agent 假阴性（最高 ROI）**  
A1, A3, A2, A4  

**Batch 2 — 安全契约对齐**  
S1, S2, U3, U5（并更新 `docs/SECURITY.md`）  

**Batch 3 — Grounding UI / 历史诚实**  
C1, C2, C3, C4, C5, U2, W2  

**Batch 4 — 设置 / Web / 能力门**  
U1, W1, W3, W4, U4  

**Batch 5 — 预览 / 管线与预算**  
V1–V4, A5, A6, A7, P1, P2, P3, L1  

**Batch 6 — 文档漂移**  
SECURITY / README / RELEASE 版本与 web-search / key fallback 表述  

---

## 八、本轮未跑项

- 工作区无 `node_modules`，未执行 Vitest / `tauri build`。结论来自源码与对照测试文件的静态核实。  
- Rust 侧未在审查环境编译（缺桌面依赖时的惯例限制）。
