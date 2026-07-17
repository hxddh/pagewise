# PageWise v3.5.12 代码与文档审查

日期：2026-07-17 · 基线：`main`（`f6f8ddf`，v3.5.12）。
方法：三路并行深挖（Agent 工具环 / Chat·流式·持久化 / 文档管线·Rust·安全），高危项对照源码二次核实。不重复 CHANGELOG 3.5.9–3.5.12 已宣称已修且核实属实的项。

整体结论：v3.5.x 硬化后，经典竞态与历史损坏类问题明显收敛；本轮新发现集中在 **(1) Agent 对「空页 / 未索引 / 元工具空转」的误判**、**(2) 整篇意图仍被关键词漏检**、**(3) 写路径 allowlist 与文档声明不一致**、**(4) Chat 切换/裁剪对用户可见 grounding 的高估**。

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

## 三、功能缺口（相对「本地文档 Agent」预期）

1. **密码 PDF / 更多格式**（加密 PDF、Office 等）无路径。  
2. **无「索引/覆盖状态」工具**：模型看不到「已索引页数 / vision 失败页 / 预算剩余」的一等公民信号（outline 部分覆盖，search/read 不足）。  
3. **Web search 仅 OpenRouter 原生插件**；其他 provider 无对等能力。  
4. **无书签跳转后的「按章节读」一等工具**（有 outline bookmarks，但仍靠模型自己拼 range）。  
5. **表格/版式结构化读取**缺失（纯文本切片）。  
6. **多文档 / 对比**未支持（单 active doc）。  
7. 文档与 README 对安全模型的描述滞后于「导出目录持久化」实现（见 S2）。

---

## 四、阻塞 AI 的限制（优先修复清单）

按「修了立刻提升回答质量」排序：

1. **A1** 失败当空白 — 直接导致幻觉式否定  
2. **A3** Search 无未索引信号 — 与 A1 同类「假阴性」  
3. **A4** 英文整篇意图漏检 — 覆盖指令根本不注入  
4. **A2** 元工具空转停跑无答案 — 用户看到空回复  
5. **A5/A6** 步数/预算会计 — 整篇任务系统性读不完或超预算不知情  
6. **P3** Vision 只抽字 — 扫描图/表页无内容可 grounded  
7. **C3/C4** Pages read 高估 — 用户与后续回合被错误 grounding 误导  

---

## 五、对抗性核实为「当前成立 / 已修好」

- 整篇 **步数/字符预算** 不再被关键词门控（3.5.9 属实）；缺口在 **指令注入**（A4），不是静默砍预算。  
- `document_outline` / `search_in_document` 会计入 read budget（3.5.11）；残留问题是 **冲过剩余预算不打标**（A6）。  
- 发送时 history repair 优先丢掉非 user 行（3.5.12）；方向正确。  
- Outline 对 image doc 跳过 pdf.js outline（3.5.11）属实。  
- 远程图片 click-to-open + CSP（3.5.11）属实。  
- 「本页」页码与截图偏好解耦（3.5.4）属实。

---

## 六、建议修复批次

**Batch 1 — Agent 假阴性（最高 ROI）**  
A1, A3, A2, A4  

**Batch 2 — 安全契约对齐**  
S1, S2（并更新 `docs/SECURITY.md`）  

**Batch 3 — Grounding UI / 历史诚实**  
C1, C2, C3, C4, C5  

**Batch 4 — 管线与预算**  
A5, A6, A7, P1, P2, P3, L1  

---

## 七、本轮未跑项

- 工作区无 `node_modules`，未执行 Vitest / `tauri build`。结论来自源码与对照测试文件的静态核实。  
- Rust 侧未在审查环境编译（缺桌面依赖时的惯例限制）。
