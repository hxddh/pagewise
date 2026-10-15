# v21 补充：六个角度

*2026-10-15。基线与 [v21 方向评估](2026-10-15-pagewise-v21-next-major-review.md) 相同：main `0c43505`，`VERSION 20.0.0`。*

*本稿不推翻那一稿的两个支点（核对过夜、表格的门）。它回答的是那一稿没分开写的六个问题：易用、架构、成本、性能、agent、界面。口径与那一稿相同。父线程改正了成本片段的一处：线上前缀不是 9,157 B，见 §3。*

*四个片段（`v21-audit/05`–`08`）是工作稿，合并后删除。*

## 0. 这六个角度改了什么

1. **易用上最贵的不是少一个按钮，是红芯片点下去没有原文。** 芯片不论状态都 `onReveal`（`src/components/CitationChip.tsx:95-97`）。`unlocated` 没有矩形（`src/lib/citation-check.ts` 的该状态不带 `rects`）。`App.tsx` 在没有矩形时把高亮清掉。读者按了「不在这一页」，页翻了，原文不亮。模型复核在脚部「更多」里，而且只收 `located` 和 `mismatch`，不收红的那条（`src/components/MessageAssistantFooter.tsx:322` 一带的 `reviewable`）。下一步不在红芯片上。
2. **Agent 上最贵的是工具对模型说谎，不是缺一个工具。** 空白页被 `markDelivered`（`src/lib/agent-tools/reading.ts:613`），下一轮只剩 `[already returned in full earlier in this turn]`（`:575`）。系统提示许诺每次阅读都带 `` `figures` `` 附件（`src/lib/agent.ts:162`）；`ReadAttachments` 只有 `links` 和 `marks`（`src/lib/agent-tools/result.ts:33-38`）。`pagesWithFigures` 只在大纲结果里（`src/lib/agent-tools/tools/document-outline.ts:128`）。范围读把索引失败收成页号，原因被消费掉（`reading.ts:564`，`src/document/index-queue.ts:268-274`）。
3. **架构上不该拆大文件。** `pdf.ts` 1455 行、`index-queue.ts` 808 行，拆开只是搬行。该收的边界是：步骤标签不认四个已有工具，停止条件写了两遍，关文档不清的 map 还在。v20 的 `DocumentScope`、原子写、句子表不要重做。
4. **成本上没有新的大笔。** 前缀实测仍是 **8,925 B / 9,000 B**，线上同一条转换也是 8,925，不是 9,157。输出盖 8,000 若被顶满，一步是 $0.0048，约为一步未命中前缀的 14 倍——但工具步实际发出多少 **未量**，所以不先切。能写进验收的钱，仍是上一稿那两笔：复核从 N 次变 1 次并不再因重开重付，降级不再重付已索引的页。
5. **性能上没有一项对着现有预算测出超时。** 探针是 4 个场景、21 条 check。hurry 重绘、一页多次 `getPageGeometry`、1,000 行大纲、长线程下一次请求的字节，都是 **未量**。v21 不把「虚拟化消息列表」或「换渲染」写成交付。先把已有的 40,000 字节预算接回 `check()`，再谈优化。
6. **界面上不换视觉语言。** 20.0 的纸、页边、动效已经是这套界面。要修的是预测失败：单页 header 中间是空的（`WorkspaceHeader.tsx:124`），Esc 被快捷键表写成「关闭浮层」但关不掉 Zen（`src/lib/commands.ts:70` 与 `src/hooks/useAppCommands.ts:211-216`），导出对话框没有 CSV（`ExportDialog.tsx:7` 的三种是 report / pdf / chat），表的 CSV 在答案脚的「更多」里。

**一句话**：六个角度挖完，v21 仍然不加表面。加上的是三条行为——红芯片有下一步、工具不对模型说谎、读者看见的步骤名与工具名是同一张表。

## 1. 产品易用

读者的活是：打开、问、信、留下、离开、出错时知道下一步。

**打开。** 第一问之前的决定已经被 18.0 收成一页（提供商、密钥、开始阅读）。这条不用再设计。打开文件的入口按代码仍有多条：欢迎页、轨、资料库、⌘O、拖放、系统「打开方式」。多入口不是缺陷，除非它们到达的状态不同。本次没有逐条走到终态，**未量**。不把「合成一个入口」写成 v21。

**问。** 两条入口：composer，选中浮层。运行中可以追加约束：`queueSteerNote`，600 字、最多 4 条（`src/lib/agent-steer.ts:24-27`）。`clearSteerNotes` 没有生产调用（全仓只在测试里）。关文档不丢未送达的 steer，也不清它。这是小的；大的是读者看不到「这 4 条里已经用了几条」。

**信。** 这是本节的洞。

- 绿芯片点下去，原文亮。这是产品的句子。
- 红芯片点下去，翻到那一页，高亮被清掉，因为没有矩形。读者得到的动作是「看看这一页」，不是「这几个字不在」。tooltip 里有原因，按钮的点击没有。
- 「请模型看」不在红芯片上，在脚部更多里，而且 `reviewable` 排除了 `unlocated`。红的那条正好是本地已经判过「不在」的，模型复核能做的是看句子是否把话说过了——本地做不到的那一半。入口放反了：能本地判的不需要模型，本地判失败的才需要一句人话，而入口不收它。

**留下和离开。** Keep 与记录面板是 13.0 以来的主路，不动。带引文的表要离开：页眉「导出」打开的对话框是报告、带证据的 PDF、会话（`ExportDialog.tsx:48-50`）。CSV 在答案脚的更多里（`MessageAssistantFooter.tsx` 的 table export）。读者按页眉的导出，会以为表出不去。修法不是第四个对话框选项——那是新表面。修法是：有表的答案，导出对话框的会话一行旁边写明「表在答案下」，或者把 CSV 作为该答案的动作留在脚部、但页眉导出在有表时不再沉默。本稿倾向后者已经成立，缺的是对话框里的一句，不是新行。

**出错。** 扫描停住的行没有按钮（`ReadingLine.tsx:38-49`），文案是「剩 m 页按需」。按需的入口不在这句话里。索引失败的重试只给 `vision_failed`（`PreviewPane.tsx:311-317`）。store 读不了有 toast（20.0）。API 错误仍是长句，指向已删除的「设置 → AI 提供商」（上一稿 §1.12）。长句不是易用；指错地方是易用事故。

**键盘。** 单页文档页码控件 `return null`（`WorkspaceHeader.tsx:124`），header 中间空一截。Zen 的退出是 ⌘⇧F，Esc 只关浮层。快捷键表把 Esc 写成关闭浮层，不写「Zen 不是浮层」。读者按表里的键，停在 Zen 里。

## 2. 架构

不拆大文件。判据：这次拆，下一次无关的改动还要不要打开它。

| 文件 | 行 | 第二件工作 | 拆不拆 |
|---|---:|---|---|
| `pdf.ts` | 1455 | 渲染、缓存、几何、vision 像素 | 不拆。几何查询若加缓存，加在函数上，不另起模块 |
| `index-queue.ts` | 808 | 扫页策略、额度、阅读线、失败 map | 阈值与预览各写一遍（`isPoorlyRecognised` 与 `PreviewPane.tsx:283`）。收成一个函数，不拆文件 |
| `settings.ts` | 681 | 偏好与密钥 | 不拆。两份锁已经是同一个 `createStoreRuntime` |
| `reading.ts` | 684 | 预算、去重、附件、范围读 | 不拆。空白页的谎在这个文件里修 |
| `PreviewPane.tsx` | 644 | 状态机与叠加装配 | 不拆 |
| `MessageAssistantFooter.tsx` | 657 | 用量、核对、复核、CSV、Keep | **复核的调用不该住在页脚。** 句子表已经是一张；复核是对那张表的一次写入，入口可以留在页脚，调用该进 `claim-review` 的主人，而不是和剪贴板绑在一起 |
| `App.tsx` | 575 | 装配 | 不拆 |

**该收的边界，三条。**

1. **步骤标签不认四个工具。** 工具名的真源是 `src/lib/document-tool-names.ts:11-20`，八个常量。`toolActivityLabel` / `toolStepLabel` 的 `default` 把 `read_figure`、`read_section`、`note_finding`、`revise_finding` 画成 “Working…”（`src/lib/tool-steps-summary.ts:49-51` 与 `:100-101`）。工具自己的 `execute` 回调带了 `agent.activityFigure` 等 key（`read-figure.ts:33`），摘要不读它。加工具不会编译失败，读者看到的是「在忙」。这是同一身份的两张表。
2. **停止条件两遍。** 构造时 `AGENT_STOP_WHEN` 用默认步数（`agent.ts:92`），`prepareCall` 重写成最多 30（`agent.ts:389`）。超时文件的注释复述 30。改一处不改另一处，测试未必红——红的是行为，而且要跑到第 21 步。
3. **关文档的清单仍会漏。** `DocumentScope` 登记了 13 项（`document-scope.ts:44-80`），这是对的机制。`cancelIndex` 不删 `pathGenerations` 和 `pageIndexFailure`。`clearSteerNotes` 没有生产调用。`index-store` 的 `pending` **不该**在拆 scope 时删——那是还没落盘的已付费页，删了等于制造上一稿要修的重付。flush 再忘，不要反过来。

**崩溃顺序，按代码能排的。** body 先 `externalize`，再写 index（`json-store.ts` 的那一次 flush）。按这个顺序，崩溃不会留下「index 指向不存在的 body」；会留下「body 写了、index 还指着旧的」。下次打开，旧 index 仍指向旧 body 或 inline。这不是丢读者的记录。丢记录的口子仍是上一稿写的：`store_write_cmd` 不看旧文件，撕坏的 sidecar 下次编辑被盖掉；OCR 写没有 `sync_all`。

不要做：重写 `pdf.ts`，合成八个 JSON，拆句子表，再造一个 agent 框架。

## 3. 成本

**前缀。** 本次用测试同一条转换复测：system 3,248 + 工具 wire 5,677 = **8,925 B**。八个 schema 里各已有一个 `additionalProperties: false`。再走一遍工具自己的 `inputSchema.jsonSchema()`（`compactToolSchemas` 包过的那层），仍是 5,677 B，标志 8 个。成本片段写的 9,157 B（「线上再加 232 B」）**不成立**，作废。门量的就是发出去的工具块。余量 75 B。不把新规则写进 system。

可删且不改决策的规则，片段量过约 649 B。按 4 字符 / token 的算术（不是 tokenizer），约 163 token，二十步未命中约 $0.0005。相对整段前缀的二十步未命中（约 $0.0067，沿用上一稿的换算、单价同日上游 $0.15/1M），这是小头。值得删的理由是「不改变决策的字节不该每步重发」，不是它贵。v21 不把砍前缀当主线；谁改提示词，谁付这 75 B。

**输出盖。** `MAX_OUTPUT_TOKENS = 8_000`（`agent.ts:98`）。若一步顶满，输出 $0.60/1M × 8,000 = **$0.0048**，约为一步未命中前缀（2,232 token × $0.15/1M ≈ $0.00033）的 14 倍。工具步实际 `outputTokens` **未量**。没量到分布之前，拆成机械 2,000 / 合成 8,000 是猜测。候选是「量」，不是「切」。harness：`eval/live` 或 scripted run 的用量行，按步记输出。scripted 不经过真模型，量不到真输出——这条要 key，或者明确写「未量，不切」。

**复核。** 指令字符串片段量过 545 B，顶满一段（3,000 字符通道）3,919 B。N 次调用的浪费在重复指令和不过夜，不在这一段的绝对大小。上一稿的「1 次调用核 N 条，并落盘」仍是这笔的修法。不在这里重算美元。

**降级重付。** `readDocs` 在 `newer` 时返回 `[]`（`index-store.ts:174-179`），本树不读 `index.newer`。每页美元仍按上一稿的 vision 算术（一页约 $0.004–0.006，20 页约 $0.086），那是上游 tile 公式，不是本次在 app 里读到的 `getDocumentVisionUsage`。标成算术，不标成实测。修法在上一稿验收 #11。

**本地 OCR。** $0。50 页帽在。逐页滚动触发的 vision 不占这顶帽（上一稿 §1.4）。不扩大帽。

**长线程。** `longchatRequestBytesMax: 40_000` 写在 `scripts/perf-probe.mjs:95`，21 条 `check()` 里没有它。探针记下了 body 长度，不跟 40,000 比。所以「100 轮之后下一次请求有多大」**未量**，门也没关。先接上 check，再谈剪历史。

## 4. 性能

现有预算（读 `perf-probe.mjs` 的 `check()`）：打开 firstRaster / firstTextLayer、滚动 p95、fling settle 1,500ms、搜索首命中、缩略图 first 600ms / 最多 40 项、长会话渲染。没有一项在本轮被重新跑过。`.perf/` 不在这个 checkout。**未量**，不引用旧 report 的毫秒当现状。

没有预算、因此不能叫「慢」的：

- hurry 结束重绘全部挂载页（`PageSlot.tsx` 的 effect deps）。对照物是 settle 1,500ms 和 fling p95。没采样之前，它是已知的浪费，不是已知的超时。
- 一页 6–7 次 `getPageGeometry`，函数无缓存（`pdf.ts`）。对照物是滚动 p95。同上。
- 大纲逐条挂载，Rust 帽 1,000（`OutlineSidebar.tsx`，`inspect.rs:60`）。对照物是缩略图的 600ms / 40 项。1,000 行是否超过，**未量**。
- 消息列表全量 `map`（`MessageList.tsx:127`）。重开清检查缓存，每颗芯片再查一次。长对话的开销 **未量**。虚拟化是新机制；在没有一次超时的预算之前，不进 v21 的交付。视口内才查，比虚拟化小，也要先有数。
- 主线程 OCR canvas：200dpi Letter 约 14.3MiB，300dpi 约 32MiB（算术，不是本机 RSS）。`render-idle` 仍是单向门：显示先走。不改。

「极致」在这里的意思是：每一项要么对着现有预算量过，要么不叫性能工作。v21 的性能交付是把 40,000 的预算接回门，加上一页几何的缓存——如果采样显示一页的重复查询出现在滚动的长任务里。没有这个采样，几何缓存也不做。它便宜，但便宜不是理由。

## 5. Agent-native

定义：读者给目标，工具对得上文档里真有的东西，读者能在运行中改口而不丢已写下的，失败是模型能自己接着做的，界面显示的是步骤而不是一只转圈。不是更多工具，不是第二个 agent。

**对得上的。** 八个工具覆盖页、范围、节、搜索、大纲、图、记一条、改一条。标记以附件进下一次阅读，只读（`result.ts` 的 `marks`）。上一轮没站住的引文会进下一问的提示（`buildCitationFeedback`，`agent.ts:356`），状态限于 `unlocated` / `outOfRange` / `mismatch`。这是闭环，而且没有新提示词规则。保持。

**对不上的，四处，都不需要新工具。**

1. **空白页被记成已完整返回。** `markDelivered` 在 `pageOffset === 0` 且没截断时调用（`reading.ts:613`），不看 `remainingText` 是否为空。下一轮 `alreadyDelivered` 为真，模型只看到短标记（`:575`），系统提示还告诉它不要再读（`agent.ts:161`）。空页因此从「没有说明」变成「以后不能再读」。修法：空页不 `markDelivered`，返回值带一句「这页没有字」。上一稿的验收 #5 要的是这句说明；这里补上「不记入已交付」，否则说明只出现一次。
2. **提示许诺的附件不存在。** `agent.ts:162` 写 `` `figures` / `pagesWithFigures` `` 在每次阅读的附件里。`ReadAttachments` 没有这两个字段。`pagesWithFigures` 在大纲工具的输出里。模型按提示去读附件，读不到，会再猜哪一页有图，或再调一次大纲。修法二选一：删提示里的这半句（前缀还回去几十 B），或让阅读结果在该页有图时带一个页号。本稿倾向删提示里的半句——大纲已经给了 `pagesWithFigures`，附件再给一次是第二张表。删提示是付字节的反向：变短，digest 要在同一提交里改。
3. **索引失败的原因到不了范围读。** 单页工具有 `indexingFailed` 和原因（`read-page.ts`）。范围读把失败页收成压缩页号（`reading.ts:629` 一带），`consumeIndexFailure` 把原因从 map 里拿掉。模型看到页号，看不到「缺密钥」还是「超时」，系统提示却要求它告诉读者索引失败。修法：范围结果带上原因，或不要在收成页号时消费掉。不新加工具。
4. **表不是工具能点名的对象。** 大纲结果有 `pagesWithTables`，并写明 reflow 会把相邻数字并成一个错数字（`document-outline.ts:115-117`）。模型接下来只能 `read_pdf_page`，拿的是重排后的文本。读者框选的区域走 `extract_region`，这条只在读者路径（`inspect.rs`）。不加工具 `read_table`。若表格进门（上一稿路 1），区域识别是 OCR 的事，不是第九个工具。路 2（明说不承诺）则在大纲的那句注释之外，不让提示要求「每个格子都有引文」——那句已经在 system 里（`agent.ts:159`），它要求的是模型做不到的事。删或收窄这句，同样是前缀变短，不是变长。

**运行中改口。** steer 存在，4×600。取消时已经 `note_finding` 的条目留在记录里——这是对的，读者的记录不该随取消消失。取消时未送达的 steer 没有生产路径清理。小。

**界面是不是步骤。** 四类工具有自己的句子（读、搜、大纲、范围）。图、节、记、改在跑的时候是 “Working…”（`tool-steps-summary.ts:49-51`）。工具失败会变成「… — 失败」（`:108-120`），这条是有的。慢和忙在跑的过程中分不开，因为标签不带工具名。收成一张表之后，慢仍然是慢，但不再是无名的忙。

**读者能做、模型不能做的。** 框选一块区域来问。模型没有这块区域的矩形，除非读者的选区被送进某一次 `read_figure`。选区浮层走的是 composer，不是区域渲染。这是真缺口。补法不是新工具：选区若落在一个 figure 的框里，提问时带上那个 figure 的 index，走已有的 `read_figure`。选区不在 figure 里，今天没有对应的工具，**未量** 这种问法占多少。不在 v21 为它加工具。先看选区浮层的提问有没有把页和引文带上——带上了，模型能读那一页；没带上，才是缺口。本次没把浮层的 payload 逐字段对完，标 **未复核完**。不据此加能力。

## 6. 界面

不换视觉语言。纸主题、页边、动效、对比度 token 是 19.0–20.0 的交付。`prefers-reduced-motion` 有断言，本次未重跑。强制色彩的 token 在，对比度比值本次没算，不引用上一轮的 4.3:1 当现状。

预测失败，四处，都是现有表面：

- 单页 header 中间空（`WorkspaceHeader.tsx:124`）。页位置在单页时仍应占位，否则条的重心跳。占位不是新控件。
- Esc 与快捷键表不一致（`commands.ts:70`，`useAppCommands.ts:211-216`）。要么 Esc 在没有浮层时离开 Zen，要么表里不要让人以为 Esc 能离开。前者是行为，后者是一句文案。本稿倾向改表，因为 Zen 的退出已经有 ⌘⇧F，再让 Esc 身兼两职会和「Esc 关浮层」抢。要改行为，先量 Zen 里按 Esc 的人是否把浮层和 Zen 当成一件事——**未量**。
- 导出对话框的三种选择不包含读者刚看到的表。见 §1。一句说明，不是第四行。
- 页边列超过碰撞步长之后，卡片顶可以落在页高之外，列 `overflow: hidden` 裁掉（`page-gutter.ts` 的 `columnTops` 不夹页高，`preview.css` 的列溢出隐藏）。第 4 条 tie 起共用最外车道。同页是否叠到读不清，**未量**（要浏览器）。v21 不重做列。若采样看到卡片被裁，夹紧 `columnTops` 是一行，不是新设计。

关闭按钮的三种画法、设置里的第三套 tablist、设置错误不走 `StatusLine`，上一稿写过。它们丑，但不挡读者的下一步。排在红芯片和指错的设置路径之后。不单独立项。

## 7. 对上一稿验收的增补

上一稿 §4 的 15 条保持。这里加上行为，不加上表面。

16. 红芯片的点击要么亮出「不在这一页」的原因（不是只有 tooltip），要么不假装完成了一次定位。`reviewable` 收 `unlocated`，或红芯片的下一步就是那一次复核。二选一，写进测试：状态为 `unlocated` 时，点击不调用会清掉高亮的那条路径，或者调用一条带原因的路径。组件测试，不靠截图。
17. 空页不进入 `markDelivered`。同一 run 的第二次范围读仍能看到「这页没有字」，而不是 `ALREADY_READ_NOTE`。`npx vitest run src/lib/agent-tools/read-tools-contract.test.ts`。
18. `agent.ts:162` 不再许诺阅读附件里有 `` `figures` ``，除非 `ReadAttachments` 真有这个字段。digest 与前缀字节同一提交。前缀仍 ≤ 9,000。
19. `toolStepLabel` 的 `default` 不再落到四个已有工具上。八个 `DOCUMENT_TOOL_NAMES` 各有一句，句子用已有的 `agent.activityFigure` 等 key。缺一个 key，测试红。不新写文案风格，用已有 key。
20. `longchatRequestBytesMax` 进入 `check()`，或从预算对象里删掉。不允许写着 40,000 却没有比较。

不增补：拆 `pdf.ts`，虚拟化消息列表，第九个工具，Zen 的新退出按钮，导出对话框的第四行，砍前缀到某个新数字，在未量输出分布之前拆 `MAX_OUTPUT_TOKENS`。

## 8. 验证记录

**本次父线程执行的**

- 四个片段的结论抽查。改正：`docs/reviews/v21-audit/07-cost-performance.md` 写线上前缀 9,157 B。用测试同一条转换再跑一遍工具自己的 `jsonSchema()`，system 3248、tools 5677、total 8925，`additionalProperties: false` 已在八个 schema 里各一次。9,157 作废。测量文件在 `.audit-tmp/`，已删除。
- 空白页 `markDelivered`：`reading.ts:613` 在推入 `remainingText` 之后、不看是否为空。与片段 08 一致。
- `` `figures` `` 许诺：`agent.ts:162` 有，`result.ts` 的 `ReadAttachments` 无。`pagesWithFigures` 在 `document-outline.ts:128`。与片段 08 一致。
- 步骤标签：`tool-steps-summary.ts:39-51` 与 `:100-101` 的 default。工具自己的 key 在 `read-figure.ts:33` 等，摘要不读。与片段 06 一致。
- `clearSteerNotes` 的生产调用：`rg` 只命中定义和测试。与片段 06 一致。
- 红芯片：`CitationChip.tsx:95-97` 调用 `onReveal`。`reviewable` 排除非 `located`/`mismatch`。与片段 05 一致。
- `buildCitationFeedback` 接到 `agent.ts:356`，只转发三种失败状态。这是闭环，片段 08 写了，父线程确认接线在。

**未量**：红芯片点击的像素、页边卡片是否被裁、1,000 行大纲的挂载、hurry 重绘的毫秒、工具步 `outputTokens`、长线程请求字节、选区浮层的 payload 是否已带页和引文、Zen 里按 Esc 的实际路径（代码路径读了，没在浏览器里按）。

**未跑**：全套 `npm test`、`perf`、`ui:shots`、Playwright、eval。
