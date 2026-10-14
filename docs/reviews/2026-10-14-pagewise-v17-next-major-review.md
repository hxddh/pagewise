# 17.0 方向评估：把答案当读物做

*2026-10-14。基线 16.0.0（main `02c41a8`，即 `v16.0.0`）。*

*每条结论都标了来源：**实测**（在这个 orb 里对运行中的应用量出来的）、**读代码**（文件:行）、**代理核对**（三路并行审计，要点我逐条复核过，复核结果在 §10）。§0 是结论，§1 是现状，§2–§4 是 17.0 提案与验收，§5 是候选对比，§6 是风险，**§7 是依赖与新版本能力的核对**，**§8 是表现层（UI/UE）重构的范围与边界**。*

*本次 review 的第二个问题（"UI 和 UE 非常粗糙，需要彻底重构"）：诊断方向与实测一致，但边界需要划清——粗糙的是**表现层**，不是全部。§8.1 给出逐条校准。*

---

## 0. 结论

1. **工程水准很高，但主分支自己的门是红的。** `npm test`：136 个文件、1,071 条用例，**1 条失败**（实测，`agent-stream-contract.test.ts:238`，"ends a stopped run with abort, not with finish"——AI SDK 现在在 `abort` 之前多发一个 `finish-step`）。危险的那两条断言（不得出现 `finish`、不得出现 `text-delta`）仍然通过，过期的是分块快照；但 `v16.0.0` 这个 tag 不满足自己的验收记录（`docs/reviews/2026-09-30-pagewise-v16-evaluation.md` §7.3 写的是全绿）。

2. **13.0–16.0 把"可信"做完了；此刻产品的短板不在能力，在读。** 14.0–15.0 补核对，16.0 做了减法；而读者花时间最多的两件事——读答案、读文档——的版式与节奏，从 11.0 定下视觉规范之后没有再被当作产品来设计。

3. **答案的排印层级是平的，而提示词偏偏要求它结构化。** 实测：`.markdown h1/h2/h3` 与正文同为 `1em`（`04-chat.css:356-361`，15px/600），答案是"一段不加分的粗体"；回答里的 Markdown 表格**没有任何样式规则**（全文没有 `.markdown table`），而系统提示词明确要求列表/比较题"answer with a Markdown table"（`agent.ts:154`）——读者拿到的是浏览器默认表格：无内边距、无表头线，截图里它看上去像坏掉了。

4. **会话栏宽到不了它的阅读行宽。** `--measure-read: 68ch`（≈649px，实测 `maxWidth` 648.955px）写在 tokens 里并附了一段理由，但会话栏是 `MIN 360 / MAX 480`（`useResizeWidth.ts:4-6`），默认 360（`tokens.css:81`）。**拖到最宽也只有 ≈455px（约 60ch），68ch 这个 token 在任何窗口下都不可达**；默认状态下答案的实际行宽是 335px ≈ 45 字符（实测）。

5. **交互的短板是"隔一层"。** 实测：在页面上选中原文，弹出的 "Ask about this" 把引文塞进输入框、并展开会话栏，**但焦点仍留在 PDF 滚动区**（`document.activeElement` 仍是 `.pdf-scroller`），读者还要再点一次输入框才能打字。会话栏开合没有过渡（实测 `transition: all 0s`，`13-chat-late.css:130` 直接 `width: 0 + visibility: hidden`），其余 13 处动画有一处全局 `prefers-reduced-motion` 兜底（`11-pdf-layers.css:298`），这点是做对的。

6. **简洁的短板在结构，不在界面。** 实测：6 份逐字节相同的 `withStoreLock`（md5 相同）加 1 份改名版；`flushMarkStore` 与 `flushFindingStore` 各 45 行、只差名字（v16 的丢数据缺陷 B6 因此要在两处各修一遍）；同一套状态词有 4 份平行文案（`cite.*` 21 键 / `record.trust*` 9 / `table.status*` 8 / `export-brief.ts` 里的 TS 表 16 条）；`ChatPanel` 34 个 props（实测计数），`SessionContextValue` 30 个字段而全应用只有 1 个消费者（`App.tsx:70`）。

7. **17.0 建议的质变：把"答案"当成一件读物来做，把"问"放到页面上。** 一句话：*读者 90% 的时间只有两件事——读答案、读文档；17.0 让这两件事本身成为产品。* 见 §2。

8. **不做多文档、新格式、语义检索。** 它们是能力扩展（§5），而"质变"这次要从体验兑现：读者感知不到的第二份文档，不解决"读不下去"。

9. **依赖没有大版本落差，但有一段可用的"能力窗口"。** npm 与 crates 都只落后补丁级（`ai` 7.0.122→7.0.139、`pdfjs-dist` 6.3.289→6.4.299、`tauri` 2.12.x、`keyring` 4.1.6→4.2.0…，没有 major 缺口）。值得用上的四样：AI SDK 的停止/重试语义修复（7.0.130 / 7.0.135 / 7.0.136）——顺带给出那条红契约测试的正确答案；pdf.js 6.4 的文本层定位精度修复（#21810 / #22058，与他们自绘高亮的几何同源）；Tauri 的窗口材质（`setEffects`：macOS vibrancy、Windows Mica）——"精致"的原生来源；React Compiler 1.0——删掉手写 memo 比较器与绕过它的 ref。完整清单、升级顺序与暂缓项见 §7。

10. **UI/UE 该重写的是表现层，不是全部。** 与实测一致的部分：平排印、裸表格、45ch 行宽、11px/3.96:1 的操作区、常驻解释性文案、86% 空白的空态、面板瞬时开合、选中→提问差一次点击、6 处手写浮层骨架、4 份状态词。不该丢的部分：token 标尺、焦点环地板、CSS 卫生守卫、三种状态的映射、选中→浮层的交互骨架。范围、库的决定与验收见 §8。

---

## 1. 现状（以实测为主）

### 1.1 这次 review 的方法

| 手段 | 说明 |
|---|---|
| `npm run ui:shots`（实测） | 仓库自带的 12 张主流程截图，逐张看过；今天新拍的 12 张在 `docs/ui-shots/` |
| 三个 DOM 探针（实测） | Playwright + 仓库自己的 `scripts/ui-harness/tauri-mock.mjs`：算字体/行高/对比度/命中区/焦点环/过渡；真拖选一次、双击一次、"Ask about this" 一次、PageDown/Space/Ctrl+= 各一次 |
| 三路并行审计（代理核对） | 文档漂移、结构复杂度、门与 CI；要点我逐条复核（§7） |
| 自己的复核（实测） | `npm test`、`find-dead-css` 的盲区、6 份 `withStoreLock` 的 md5、两份 flush 的 diff、`ChatPanel` props 计数、`useSession()` 消费者计数、v15→v16 词条数 |

对齐一个已知限制：**Rust 工具链在这个 orb 里不存在**，所以 `cargo test`、`npm run eval`（需要 `eval/extract` 的 cargo 构建）都没有跑；真机（macOS/Windows）行为同样未验证。下面凡涉及这些，都写明是"读代码"。

### 1.2 做得好的（不要动）

| 方面 | 事实 |
|---|---|
| 视觉 token | 类型/间距/圆角/影深/时长都收敛成了有理由的标尺（`tokens.css`），并且注释写的是"为什么"，不是"是什么" |
| 守卫密度 | CSS 用法、选择器顺序、手写 `<button>` 的理由、i18n 未用键、焦点环地板、单一选中样式、无死动画——都做成了会在提交上失败的断言（`scripts/css-hygiene.test.mjs`） |
| 键盘与焦点 | 焦点环 2px accent（实测 `:focus-visible` 命中）；PageUp/PageDown/Home/End/←/→ 都作用于滚动区（读代码 `usePdfViewer.ts:167-190`）；Space 翻页实测有效（0 → 752px） |
| 动效克制 | 13 处 `@keyframes`，全是淡入/滑动；一处全局 reduced-motion 兜底（`11-pdf-layers.css:298`），覆盖 `*` |
| 交互骨架 | 选中 → 就地浮出 "Ask about this / Mark"（实测，工作正常）；双击选词正常；hover 才出现的回答操作（实测 `opacity 0 → 1`，120ms） |
| 信任链 | 引文核对、三种状态、缺口反馈、导出证据，这条轴是产品的护城河，17.0 只做减法不动它 |

### 1.3 阅读体验（实测数据）

| 项 | 实测值 | 判断 |
|---|---|---|
| 答案正文字号/行高 | 15px / 24.75px（1.65） | 好——`--text-read` 是落地的 |
| 答案实际行宽 | **335px ≈ 45ch**；栏宽上限 480px ⇒ ≈60ch | **窄**。68ch 的意图不可达 |
| `.markdown h1/h2/h3` | `font-size: 1em; font-weight: 600`（`04-chat.css:356-361`） | **层级是平的**：`## 小节` 与正文同号 |
| `.markdown table` | 全文无规则（记录栏的 `.record-body table` 有，`04-chat.css:963`） | **表格裸奔**，而提示词要求用表格 |
| 回答操作（Copy/Keep/⟳/…） | 11px，对比 3.96:1，命中区 26×24 | 低于 AA（4.5:1），且是常用动作 |
| 输入框提示"Enter to send · Shift+Enter for newline" | 11px，对比 3.96:1，**常驻** | 解释性文案占着主界面最好的位置 |
| `page 1` 页内引用链接 | #5e6ad2 on #0f0f11 = **4.07:1** | 差 0.43 到 AA |
| 活动标签（Chat/Record 选中态） | accent on accent-muted ≈ **3.7:1**（手算：`rgba(94,106,210,.12)` 叠在 `#0f0f11` 上，白字除外） | 12px 小字低于 AA |
| 空会话 | 三枚建议贴在底部，上方 616px 空白（实测块高 716，chips 顶 666，输入框顶 780） | 大片死空间，像未完成的页面 |
| 页码签 | 11px `--text-secondary`，`bottom: -18px`（`preview.css:479-486`） | 在纸面外/被下一页压住，实测在它的包围盒位置取不到像素（§7 列为可疑项） |

三处错配值得单独说：

1. **排印与结构不符。** 提示词要求模型结构化输出（小节、列表、表格），排印系统却没有给这些结构任何视觉差：标题不加级、表格无框线、列表只缩进 1.25em。读者读到的结构感，全是 Markdown 符号被浏览器默认样式凑出来的。
2. **行宽与"读"不符。** `tokens.css:130-132` 那段注释是对的（"设成 chrome 尺寸就是为什么这个面板像设置对话框"），但只做了一半：字号抬到 15px 之后，面板仍然只给 335px。60ch 的上限让 15px/1.65 的优势被打折。
3. **工具噪音与阅读节奏混杂。** "· Read page 1" 这类步骤行（12px，7.18:1，比正文还显眼地贴在答案上方）在 16.0 已经折叠得不错，但它仍然占据答案的第一行视觉入口。

### 1.4 交互（实测记录）

| 动作 | 结果 | 判断 |
|---|---|---|
| 页面拖选 → 浮层 | "Ask about this" + "Mark"，28px 高，贴在选区上方 | 好；浮层略压住上一行 |
| 点 "Ask about this" | 引文进输入框、会话栏展开，**焦点仍在 `.pdf-scroller`** | **差一步**：本意是立刻提问 |
| 双击选词 | 选中 "Lorem" | 正常 |
| hover 回答 | 操作行 120ms 淡入，4 个按钮 | 好 |
| Tab 走查 | 焦点环 2px accent，`:focus-visible` 正常 | 好 |
| PageDown / Space / Home / End / ← → | 都作用于文档 | 好 |
| Ctrl+= / Ctrl+- | **无响应**（缩放标签仍为 "Fit"） | 缺：键盘/触控板缩放是阅读器的常识 |
| ⌘[ / ⌘] 翻页、⌘\ 收起面板、⌘K 面板、⌘F 搜索 | 已实现（16.0 修好 ⌘[/⌘]） | 好 |
| 会话栏开合 | 瞬时，无过渡 | 中：不是错，但少了一次"呼吸" |

### 1.5 结构与简洁（代理核对 + 我的复核）

按（简化收益 × 可信度）排序，只列我复核过或看得到 diff 的：

| # | 事实 | 位置 | 代价 |
|---|---|---|---|
| F1 | **6 份逐字节相同的 `withStoreLock`（md5 相同）+ 1 份改名版** | `allowed-paths.ts:21`、`finding-store.ts:148`、`index-store.ts:69`、`mark-store.ts:93`、`recent-files.ts:44`、`chat/persist.ts:62`；`preferences.ts:85`（改名） | 一份改动要在 7 处同步；B6 那个丢数据缺陷因此修了两遍 |
| F2 | `flushMarkStore` 与 `flushFindingStore` 各 45 行，diff 只有名字 | `mark-store.ts:295`、`finding-store.ts:418` | 同上，且第二次还会漏 |
| F3 | 一套状态词 4 份平行文案 | `cite.*`(21) / `record.trust*`(9) / `table.status*`(8) / `export-brief.ts:56-66,79-89`(TS,16 条) | 16.0 §3.1"共用同一套状态词"只做了一半；改一个词要动 5-6 处 |
| F4 | `ChatPanel` 34 props（其中约 24 个是纯转发），组件 904 行装 ~10 件事 | `ChatPanel.tsx:47-89`、`App.tsx:315-356` | 每个助手交互都是三文件改动；消息行无法单测 |
| F5 | `SessionContextValue` 30 字段 + 两个整对象，全应用 **1 个消费者** | `SessionProvider.tsx:59-96`、`App.tsx:70` | context 目前只买到了"30 个值再逐个透传成 props" |
| F6 | 文档级状态散在 9-10 个模块单例里，靠一份手写 reset 清单拆除 | `SessionProvider.tsx:376-393`、`pdf.ts`（10 个模块级缓存）、`agent-abort`/`agent-steer`/`agent-view-context`/`usage-tracker` | 漏一项就是"上一份文档的文字/高亮漏进下一份"——这个 bug 类在仓库里被记录过三次 |
| F7 | 六个页面覆盖层各自复制同一段"读几何 → 转百分比盒子"的 effect | `AnnotationLayer/FindingLayer/MarkLayer/LinkLayer/CitationHighlight/SearchHighlight` | 换算法要改 5-6 处（v16 待办里"扫描页高亮偏低"正属于此） |
| F8 | `ClearChatConfirm` 就是 `ConfirmOverlay`（`danger` 写死） | `overlays/ClearChatConfirm.tsx`(33 行) vs `overlays/ConfirmOverlay.tsx`(37 行) | 两个组件的差别只是一个布尔 |
| F9 | **6 个死 CSS 类**，而门报的是 0 | `.doc-name`/`.doc-meta`(`02-shell-layout.css:35,42`)、`.doc-search`(`07-preview-chrome.css:149`)、`.tool-debug`/`.tool-fold-state`/`.tool-label`(`04-chat.css`) | 原因是 `find-dead-css.mjs` 把测试文件里的路径字面量 `/doc-${i}.pdf`（`chat/persist.test.ts:34`）当成了类名前缀，于是 `doc-*` 全部豁免 |
| F10 | 约 29 个导出无人引用（如 `savePreferences`、`getActiveProvider`、`combineAbortSignals`、4 个 `Icon*`） | 见 §7 复核记录 | 两个"看起来还活着"的能力其实是死代码，改代码前要多一次 grep |

### 1.6 门与文档

| 事项 | 实测/核对 | 影响 |
|---|---|---|
| `npm test` | **1,070/1,071 通过**，失败见 §0.1 | 发布 tag 不满足自己的门 |
| `find-dead-css` | 门报 "0 defined but never applied"；实际 ≥6（F9） | "无死 CSS"这个保证今天是假的 |
| `npm run eval` | **不在任何 workflow 里**（CI 只有 `ci.yml`/`release.yml`/`extraction-drift.yml`，grep 无 `eval`） | 引文定位率的门槛（≥90%）只在人手跑时存在 |
| `npm run ui:inventory` | 同样不在 CI | "回答下 ≤4 个按钮""设置 ≤12 行"这类读者可见的约束无人守 |
| `check:css-order` | 快照只记选择器/at-rule 前导（`check-css-order.mjs:30-38,105-118`） | 在某条规则里删一个声明不会让快照变化 |
| README 的信任模型 | 写"one trust state (*checked*, *found on the page*, *re-check*)" | 与代码的三级（verified / check the page / not found，`trust-level.ts:25-27`）不一致 |
| CHANGELOG 的两个数字 | "Eleven settings"（实测 9 行）；"137 unused keys"（实测 v15.0.0→HEAD 少 115 个键） | 自我评价文档与实测不符 |
| "一个词读未扫页" | 横幅 "Read these pages"（`en.json:97`）vs 命令面板 "Read the unscanned pages"（`en.json:385`） | 16.0 立下的用词规则当场破了 |
| README 的导出 | 仍按 16.0 之前的名字/形状讲（Brief/标记/整份文档三件事） | 读者会去找一个已经合并进"导出…"的入口 |

---

## 2. 17.0：答案是一件读物

### 2.1 目标句（验收单位）

> 读者打开一份 PDF，选中一段话问一句：**光标已经在输入框里**；答案以读物的样子回来——小节有分级、列表有呼吸、表格有框线、工具步骤只占一行；答到一半切走再回来，阅读位置还在；点答案里的引文，页面滚到那句原话并把它点亮；把会话栏拖宽，行宽跟着长，但不会长到眼睛找不到下一行的开头。

### 2.2 支点 A · 读物级答案（阅读体验）

这是 17.0 的主战场。具体改动都在排印层，不动核对逻辑：

- **给结构配上视觉阶。** `h1/h2/h3` 从 `1em` 分成三档（建议 1.35 / 1.2 / 1.08 倍，字重不变），小节之间空出比段落更大的距离；`hr` 有规则；`ol` 用真实序号并缩进对齐。
- **表格是一等公民。** 新增 `.markdown table` 体系：表头底色 `--bg-elevated`、单元格 8/12px 内边距、行分隔用 `--border-subtle`、数值列右对齐；首列不折行（`white-space: nowrap` 只在短列）。提示词已经要求"每个值后面带引文标记"，表格样式必须让标记落在正确的位置上（单元格右上角）。
- **行宽自适应。** 会话栏上限从 480 提到 **640**（`useResizeWidth.ts:5`），默认从 360 提到 **420**；`.markdown` 的 `max-width` 从固定的 68ch 改成"栏宽减内边距"，并把 68ch 变成**上限**而不是目标。同时把这条写进 ui:inventory 的断言。
- **工具步骤退到答案之后。** 现在 "· Read page 1" 在答案上方占第一行；改成答案之下的脚注行（或折叠进答案头部的一行"读 3 页 · 4 步 · 12.4s"）。
- **流式阅读节奏。** 保持 `smoothStream(..., delayInMs: null)`（不人为放慢）；但流式期间不做重新排版式的跳动：新段落落在视口下方时不改变已读部分的位置（`messages` 的 `overflow-anchor` + 只在视口底部时自动跟随）。
- **空会话不是空的。** 三枚建议改为贴着输入框的一组"起句"，并在文档已打开时按当前页生成（"这一页讲了什么？"而不是通用的三句）。

### 2.3 支点 B · 就地提问（交互自然）

- **"Ask about this" 之后，光标在输入框里。** 实测今天不是（§1.4）。一行 `focus()` 加把光标放到末尾；如果会话栏是收起的，展开动画结束后再聚焦。
- **浮层长出输入形态。** 选中的浮层从两枚按钮变成"一片可输入的条"：`Ask about this …` 展开后是输入框（Enter 发送、Esc 收回），Mark 仍在旁边。这样"选中 → 问"不需要把手移到 300px 之外。
- **答案与原文互指。** 由选中发起的提问，答案顶部写清"关于第 12 页的这段"（可点回原文）；答案里的引文点开时，页面滚动 + 高亮 + 一次 160ms 的脉冲（`search-highlight-in` 已有类似实现）。
- **键盘补完。** ⌘+ / ⌘− / ⌘0 缩放（今天没有）；`j/k` 或 `n/p` 在文档里前后翻页；面板收起时 ⌘\ 展开并把焦点送进输入框。
- **面板开合有过渡。** 160ms 的宽度/透明度过渡（`--transition` 已有），并继续由 reduced-motion 兜底。

### 2.4 支点 C · 一个词、一套动效、一处入口（简洁与优雅）

- **状态词收成一份。** F3 的四份表合成一张：`statusText(status)` 返回 `{level, short, long, exportKey}`，`RecordPanel`、`MessageAssistantFooter` 的 CSV 标签、`export-brief` 的中英标签全部读它；模型审阅的降级规则保持不变（16.0 已定的"相悖才降级"）。
- **解释性文案退场。** "Enter to send · Shift+Enter for newline" 改为首次提示（`onboarding-hints.ts` 已有机制，用完就撤）；设置的工程口吻改写（"Billed by your provider" → "按你配置的服务计费"；"the page number is always shared, so 'this page' / '本页' works without this" 这类括号说明收进"关于"）。
- **入口归一。** 未读页的三个名字（横幅/命令面板/追问建议）收成一个（16.0 声明过、没做完，§1.6）；`ClearChatConfirm` 删掉，直接给 `ConfirmOverlay` 传 `danger`（F8）；两个"更多"菜单合并（现在是"此回答的更多操作"与"更多操作"两个无障碍名）。
- **动效统一。** 面板开合、引文点亮、抽屉、浮层、Toast，全部用 `--transition-fast/--transition/--transition-slow` 三档；新增的每一处都在 `css-hygiene` 的 `motion-exception:` 规则下受管。

### 2.5 支点 D · 结构（工程侧的简洁）

不改行为，只去重：F1/F2 合成一个 `jsonStore({key, version, migrate, sanitize, caps})`（去掉约 300-400 行重复，B6 这类缺陷从此只有一处可修）；F4/F5 让 `ChatPanel` 直接消费 `agent`/`connection` 两个切片而不是 34 个 props，`SessionProvider` 拆成三个 hook（`useDocumentSession` / `useChatSession` / `useExports`）；F6 用一个 `releaseDocument(path)` 注册表替代手写清单；F9 把死类清零并修好 `find-dead-css` 的前缀豁免；F10 删掉无人引用的导出。

### 2.6 为什么这是质变，而不是加功能

- **主界面没有变多，变的是密度与节奏。** 不加新面板、不加新模式；改的是读者停留最久的那 40 行文字怎么排、问句从哪里开始。
- **它把已有的能力兑现给眼睛。** 13.0 的引文、15.0 的核对、记录与简报都在，但今天它们被一个 45ch 的窄栏和"平排版"包着。
- **可测。** 每一条都能用 §4 的数字验收（字号阶、对比度、行宽、焦点、按钮数、死类数），不依赖主观判断。
- **它接的是 16.0 立的方向。** 16.0 说"打开一份文档、问一个问题，读者不用学任何术语"；17.0 把这句话的后半段做完：*答案要配得上被读*。

---

## 3. 交付包与顺序

包 1–3 合起来就是 §8 的表现层重构；包 0 先做依赖补丁（§7.4）与那条红测试，因为后面每个包的"测试通过"都建立在它之上。

### 包 0 · 度量与依赖（前置，一天）

- 把 `npm run ui:inventory` 与 `npm run eval` 接进 CI（两者今天都不在，§1.6）。
- 修掉过期快照（`agent-stream-contract.test.ts:238`）。上游的答案已经明确（§7.3）：**停下的运行以 `abort` 收尾是最终状态，最后一步发 `finish-step` 是设计行为**；该测试应断言"最后一块是 `abort`、不存在 `finish`、不存在 `text-delta`、信号已释放"，而不是"`abort` 紧跟在 `tool-output-available` 之后"。
- 升级补丁级依赖（§7.4 第一组），随后再动表现层。
- 给 `ui:inventory` 加四条读者可见的断言：答案标题存在字号阶（≥1.2 倍）、`.markdown table` 有规则、会话栏默认宽 ≥420、动作按钮 ≥12px 且对比 ≥4.5:1。

### 包 1 · 读物级答案（支点 A）

改：`04-chat.css`（markdown 块）、`tokens.css`（字号阶）、`useResizeWidth.ts`（默认与上限）、`MessageContent`（工具步骤位置）、`agent.ts`（提示词长度/结构一节：先说结论、能用列表不用长段落、超过 6 行就给小节标题）。验收见 §4 第 1-6 条。

### 包 2 · 就地提问（支点 B）

改：`useAskSelection`（浮层长出输入）、`App.askAboutSelection`（聚焦）、`usePdfViewer`（⌘+/⌘−/⌘0、j/k）、`13-chat-late.css`（面板过渡）。验收见 §4 第 7-10 条。

### 包 3 · 一个词与一套动效（支点 C）

改：`statusText` 合并（F3）、i18n 两条漂移（未读页一名字、退出提示）、`onboarding-hints` 首次提示、`ConfirmOverlay` 合并、动效统一。验收见 §4 第 11-13 条。

### 包 4 · 结构（支点 D）

按 F1 → F4/F5 → F6 → F9/F10 的顺序做，每步行为不变、测试不变。验收：`withStoreLock` 剩 1 份；`flush*` 剩 1 份；死类 0 且门能抓到新的死类；`npm test` 数量不减。

---

## 4. 验收（全部可测）

1. **排印阶**：`h2/h1` ≥ 1.2 倍正文、`h3` ≥ 1.08 倍；小节间距 > 段落间距。（断言 DOM 计算样式）
2. **表格**：`.markdown table` 规则存在且生效——截图对比"无样式"与"有样式"；表头有底色、单元格有内边距、引文标记在单元格内不换行。
3. **行宽**：默认会话栏 420（±1），上限 640；答案块实测宽度 ≥ 60ch；`--measure-read` 成为上限而非目标。
4. **对比度**：正文级文本 ≥ 4.5:1（含动作按钮 11px→≥12px、`page-ref-link`、活动标签、`composer-hint`）；`ui:inventory` 里加一条"无低于 4.5:1 的正文文本"的门。
5. **工具噪音**：答案的第一行是答案本身；工具步骤在答案之后或折叠进行内。
6. **空会话**：建议与输入框的间距 ≤ 24px，空白比例从 86% 降到视觉合理（截图验收）。
7. **聚焦**：选中 → "Ask about this" 后 `document.activeElement` 是输入框（自动化断言）。
8. **键盘**：⌘+/⌘−/⌘0 改变缩放；j/k 翻页；⌘\ 展开并聚焦输入框。
9. **面板过渡**：开合有 160ms 过渡；reduced-motion 下瞬时（两态各测一次）。
10. **引文互指**：从答案点引文 → 页面滚动、高亮、脉冲一次；从选区发起的答案标明页码并可点回。
11. **一个词**：未读页动作在横幅与命令面板同名（断言 i18n 值相等）。
12. **首次提示**：用满 N 次后 `composer-hint` 不再出现（有测试）。
13. **门**：`npm test` 全绿；`eval` 与 `ui:inventory` 在 CI 中运行；`find-dead-css` 报 0 且能抓到 `.doc-name` 这类新增死类（用一个反例测试证明门的有效性）。

---

## 5. 候选对比

| 候选 | 是否质变 | 改动面 | 判断 |
|---|---|---|---|
| **读物级答案 + 就地提问（本文）** | 是：读者停留最久的两件事被重新设计 | 中：排印层、浮层、几个 hook；不动核对 | **17.0** |
| 多文档工作集 | 是（作用域）×能力，不是体验 | 大：§F6 那张单例清单要全部改键 | 18.0。理由同 13.0 的判断：跨文档的断言更难核对，先让单文档好读 |
| 语义检索 / 向量 | 否：基础设施 | 中，另有隐私决定 | 不进 17.0 |
| 新格式（docx/epub/html） | 否：换一种输入 | 中，需新提取器 | 不进 17.0；每种格式都要单独补一遍核对与高亮 |
| 页边批注（答案贴在所选段落旁） | 是：交互范式变化 | 大：需要会话栏可完全退场 | 作为 17.x 的实验：先在"选中 → 提问"这条路上把答案锚到段落（包 2 的延伸），验证后再决定 |
| 继续加强核对（第五种状态、更多评测） | 否：边际收益递减 | 中 | 不做；16.0 已把状态压到三种，读者侧没有新需求 |

---

## 6. 风险

- **排印变更会牵动 11.0/16.0 的视觉规范。** 需要同步更新 `css-hygiene` 与 `ui:inventory` 的断言，否则门会在第一次提交就红。对策：包 1 里把两条断言与代码放在同一个提交。
- **换组件库会动到 11 个文件的无障碍骨架**（§8.4）。对策：先在一条路径（例如"菜单 + 对话框"）上替换，跑通 `npm test` 与 `ui:shots` 再铺开；旧的手写 hook 在新原语覆盖前不删。
- **面板加宽挤占页面。** `useResizeWidth.ts:13-18` 已经记录过 480px 在 900px 窗口下把工具栏挤出界的事故；把上限提到 640 必须同时保留 `PREVIEW_FLOOR` 的钳制，并在 900×600 下重拍截图。
- **就地输入浮层要处理中文输入法。** 组合期（composition）不得触发发送；CJK 折行要用 `Intl.Segmenter`（仓库已有 `stream-transform.ts` 的经验）。
- **提示词改动有一次缓存前缀失效。** 与 13.0 同量级（一次性），但要在 CHANGELOG 里写明。
- **结构简化动的是数据路径。** F1/F2/F6 都直接连着"丢数据"的缺陷类（B6/B7）；每一包都要先有用例，再改，再跑一遍 `audit:*`。
- **不能在真机验证的部分**：macOS/Windows 的拖放、文件关联、keychain 行为；Rust 工具链缺席导致 `cargo test`、`npm run eval` 未跑。

---

## 7. 依赖与可用的新能力（2026-10-14 核对）

方法：`npm view <pkg> version|dist-tags`（跟随最新发布）与 crates.io API 逐个查询；能力部分读的是上游 changelog / 发布说明 / 文档。**没有 major 缺口**——所有依赖都只落后补丁或小版本，问题不是"太旧"，而是"新版本里的哪几项能力正好对上 17.0 的验收"。

### 7.1 JavaScript / TypeScript（锁定版本 → 最新）

| 包 | 仓库锁定 | 最新 | 动作 |
|---|---|---|---|
| `ai` | 7.0.122 | 7.0.139（7.0.140 已有） | 升。停止/重试语义修复在 §7.3 |
| `@ai-sdk/react` | 4.0.125 | 4.0.142–4.0.143 | 升；4.0.143 需要 `ai@7.0.140`，两者一起 |
| `@ai-sdk/openai` | 4.0.80 | 4.0.93 | 升（他们走 `createOpenAI` + 自定义 baseURL） |
| `pdfjs-dist` | 6.3.289 | **6.4.299** | 升；文本层精度修复，见 §7.3 |
| `react` / `react-dom` | 19.3.0 | 19.3.0 | 已最新 |
| `react-markdown` / `remark-gfm` | 10.1.0 / 4.0.1 | 同 | 已最新（表格/脚注能力都在，缺的是样式，§1.3） |
| `zod` | 4.6.5 | 4.6.7 | 顺手 |
| `lucide-react` | 1.48.0 | 1.56.0 | 顺手；升级后 `rg "from \"lucide-react\""`（14 处）核对图标名 |
| `tesseract.js` | 7.0.0 | 7.0.0 | 已最新 |
| `vite` / `vitest` / `@vitejs/plugin-react` | 8.3.1 / 5.0.2 / 6.1.1 | 8.3.4 / 5.0.4 / 6.1.2 | 顺手 |
| `playwright` | 1.63.0 | 1.64.0 | 顺手（`ui-shots`/`ui-inventory`/四个 `audit:*` 的底座） |
| `jsdom` | 30.1.1 | 30.1.2 | 顺手 |
| `typescript` | 7.0.2 | 7.0.2 | 已最新 |
| `@tauri-apps/api` / `cli` | 2.12.0 | 2.12.3 / 2.12.2 | 顺手 |
| `plugin-dialog` / `plugin-opener` / `plugin-store` | 2.8.0 / 2.6.0 / 2.5.0 | 2.8.2 / 2.7.1 / 2.5.0 | 顺手 |

### 7.2 Rust（crates.io）

| crate | 声明 | 最新 | 动作 |
|---|---|---|---|
| `tauri` | `2` | 2.12.3 | `cargo update`；窗口材质能力见 §7.3 |
| `tauri-build` | `2` | 2.7.2 | 同上 |
| `tauri-plugin-dialog` | 2.7.1 | 2.8.2 | 同上 |
| `tauri-plugin-opener` | `2` | 2.7.1 | 同上 |
| `tauri-plugin-window-state` | `2` | 2.5.0 | 同上（**3.0.0-alpha.2 不采纳**） |
| `tauri-plugin-single-instance` | `2` | 2.5.3 | 同上 |
| `tauri-plugin-store` | 2.4.3 | 2.5.0 | 同上（**3.0.0-alpha.2 不采纳**） |
| `pdf-inspector` | 1.25 | 1.25.2 | 补丁；`extraction-drift.yml` 已在周度跟踪 |
| `lopdf` | 0.45 | 0.45.0 | 已最新 |
| `keyring` | 4.1.6 | 4.2.0 | 升（`v1` shim 不变） |
| `serde` / `serde_json` | `1` | 1.0.229 / 1.0.154 | 已最新 |

### 7.3 值得用的能力（按 17.0 的验收对应）

**a. AI SDK 7.0.123–7.0.139：停止与重试的语义（对应"停下的运行不能被当成完成"）**

- `7.0.130`：abort 一触发就立即 settle 结果 promise 并取消流；`7.0.135`：`Chat.stop()` 会等整条管线清理完再 resolve。这两条正对他们自己记录过的"Stop 之后马上重问"竞态（B13/B14 那一类）。
- **那条红测试的正确答案**：上游确认"停下的运行以 `abort` 收尾、它前面可以有 `finish-step`"是设计行为（`abort` 是最后一块，`finish` 不出现）。所以 `agent-stream-contract.test.ts:238` 不是"升级就能变绿"，而是断言写得太紧：应改为"最后一块是 `abort`、不存在 `finish`、不存在 `text-delta`、`getAgentRunAbortSignal()` 已释放"。
- `7.0.136`：长工具 + `streamRetries` 的超时预算修复——他们正是"本地读页/视觉调用 + 重试"的组合。
- `7.0.132` `onUIMessageStepEnd`：每步转成 UI 消息部分后回调，可在其里落盘。他们现在用三个定时器做 settle/历史压缩（F9），这是收口点。
- `@ai-sdk/react` `4.0.141`：自定义 transport 的 `resumeStreamIsReplay` 透传修复——他们用的正是自定义 transport；将来做"切走再回来继续流"这是前提。
- `7.0.140` `toolCallConcurrency`：需要把工具串行（例如记录写入）时可用。
- 上游 7.0.138 起有 provider 原生 citations 的表示。他们的 `〔p12 "…"〕` + 本地核对是更强的模型，只需把原生 citations 作为补充，不替换。

**b. pdfjs-dist 6.4.299：文本层几何精度（对应高亮对齐、选词准确）**

- `#21810`（Firefox 字号量化）与 `#22058`（测量字体缓存）修的是 span 的 `--scale-x`/度量——他们自绘的高亮框、标记、结论下划线全都建立在同一批页文本度量上，所以这是"高亮压线"类问题的上游修复。
- `#21829`：画布文字描边宽度缓存 bug（他们自己光栅化页面，直接受益）。
- 字体/字形映射修复（Type1 ToUnicode、CID、缺少 TrueType 字形）→ 提取与搜索质量。
- 6.0 起上游的"更可见的选区"（`enableSelectionRendering` + draw layer）是 viewer 级特性，自定义 UI 用不上；但方向一致：他们也应把 `::selection` 样式调成同一种理念。
- **没有**可脱离 viewer 的高亮编辑器 API（`AnnotationEditorLayer` 需要 viewer 的 EventBus/UIManager 全套）。结论：**自绘标记 + Rust 写批注的路线保持**，升级只取精度。
- 下一个版本会把 `textLayer` 的 `update()` 改成不再重新布局（commit `049f59a`，已进 dev）——缩放/高亮更新会更便宜，列入观察。

**c. Tauri 2.12.x：窗口材质（"精致"的原生来源）**

- `Window.setEffects()`（JS）/ `tauri::window::EffectsBuilder` + `Effect`（Rust，29 个变体）：macOS 的 `Sidebar` / `UnderWindowBackground` / `HudWindow` / `ContentBackground` / `Popover` 等 vibrancy 材质、macOS 26 的 `LiquidGlassRegular/Clear`、Windows 11 的 `Mica/MicaDark/MicaLight/Tabbed/Acrylic`。冲突项按顺序取第一个被支持的，所以可以同时写 Windows 与 macOS 的候选。
- 前提：窗口 `transparent: true`、页面背景透明、`core:window:allow-set-effects` 权限（**不在默认权限集**）。Linux 不支持——必须按"无效果即可用的不透明降级"设计。
- 附带：`window.setBackgroundColor` 按主题设置底色，消除启动白闪（现在是"先黑后白"或反之）。

**d. React Compiler 1.0：结构（对应 F4/F7 的根源）**

- `babel-plugin-react-compiler@1.0.0` 已稳定；`@vitejs/plugin-react@6` 移除了内联 `babel` 选项，Vite 8 路线是 `reactCompilerPreset()` + `@rolldown/plugin-babel`（另有一条实验的 Rust 编译器路径 `react({ compiler: true })`，需 `oxc-transform-react`）。
- 收益：自动记忆化，Meta 实测交互最高快 2.5×。**可以直接删掉手写 `React.memo` 比较器和为绕过 memo 边界而存在的三个 ref**（F7）——那正是"粗糙结构"的核心。
- 前提：Rules of React（那些"故意不做依赖"的写法要一并清）。因此它必须与 §8 的组件重构同一个包做，否则会重复劳动。

**e. 组件栈（"组件"这一问的正面回答）**

现状是全部手写：`useOverlayLock` 6 处、`useFocusTrap` 6 处、11 个文件各自处理 Escape/背板（实测 grep）。这是"粗糙"最结构性的一处：一次浮层的正确行为（层叠、焦点归还、Esc、点击外部、滚动锁）被复制了 11 次。

| 选项 | 版本 | 判断 |
|---|---|---|
| **Radix UI**（`radix-ui`） | 1.8.1，React 19 | **建议**：headless，正好替换菜单/弹出/对话框/工具提示/开关的无障碍与定位骨架，样式仍归他们的 token 体系；把 11 份手写协议收敛成一套 |
| Base UI | 1.0.0-rc.0 | 观察，未 GA 不采纳 |
| **motion** | 14.2.0，React 19 | 建议：面板开合、答案插入（FLIP）、列表增删、浮层进入离开；纯呼吸/脉冲仍用 CSS |
| `@tanstack/react-virtual` | 3.14.19 | 可选：`ThumbnailSidebar` 手写窗口化、超长会话 |
| `shiki` | 4.5.0 | 可选：论文/代码类文档的答案高亮 |

### 7.4 升级顺序与暂缓

1. **第一组（低风险，包 0）**：`ai`+`@ai-sdk/react`+`@ai-sdk/openai`、`pdfjs-dist` 6.4.299、`cargo update`（tauri 2.12.3 + 六个插件）、`vite`/`vitest`/`playwright`/`jsdom`/`zod`/`lucide`/Tauri JS 补丁。验收：`npm test` 全绿（含按 §7.3a 改写的契约测试）、`ui:shots` 12 张无回归、`cargo check` 通过。注意 pdf.js 的两条 `[api-minor]`（`operationsFilter` 收到 `operatorList`、worker 不再发 "test" 消息）——两者他们都没用。
2. **第二组（与表现层同包）**：React Compiler + Radix + motion，在 §8 的重构里一次引入，配着删掉手写骨架与手写 memo。
3. **暂缓**：store/window-state 的 3.0.0-alpha、Base UI rc、`WebSocketChatTransport`（桌面不需要）、tool search（8 个工具用不上）、`toolCallConcurrency`（除非要串行写记录）。

### 7.5 一句话

依赖本身不需要"换"，需要的是**把四个已经躺在补丁版本里的能力用起来**：更可靠的停止语义（AI SDK）、更准的文本层几何（pdf.js）、真正的窗口材质（Tauri）、以及一个能替掉手写记忆化与手写浮层的编译器与组件栈（React Compiler + Radix）。

---

## 8. 表现层（UI/UE）重构：范围、边界与库

### 8.1 判断校准：哪一部分"粗糙"站得住

| 观察 | 结论 | 证据 |
|---|---|---|
| 排印没有层级 | 站得住 | `04-chat.css:356-361`（h1–h3 = 1em）；实测 h2 与正文同为 15px |
| 表格/结构裸样式 | 站得住 | 无 `.markdown table` 规则；而提示词要求表格（`agent.ts:154`） |
| 行宽过窄 | 站得住 | 实测 335px≈45ch；栏宽上限 480（`useResizeWidth.ts:5`），68ch 不可达 |
| 小字与低对比 | 站得住 | 动作按钮 11px/3.96:1、`composer-hint` 11px/3.96:1、活动标签 ≈3.7:1、`page-ref-link` 4.07:1 |
| 解释性文案常驻 | 站得住 | `composer-hint` 常驻；设置有工程口吻的整段说明 |
| 空态/首屏单薄 | 站得住 | 空会话块高 716px、建议贴底；欢迎页 28px 标记 + 一行字 |
| 面板开合瞬时 | 站得住 | `13-chat-late.css:130` 直接 `width: 0 + visibility: hidden` |
| 交互差一步 | 站得住 | 选中→"Ask about this" 后焦点仍在 `.pdf-scroller` |
| 浮层骨架重复 | 站得住 | 11 个文件手写 Escape/背板；`useOverlayLock` 6 处、`useFocusTrap` 6 处 |
| 状态词四份 | 站得住 | §1.5 F3（21/9/8 + TS 16 条） |
| 基础体系也粗糙 | **不成立** | token 标尺（类型/间距/圆角/影深/时长）、焦点环地板、CSS 卫生守卫、动效克制、三种状态映射——这些在同类产品里属于上游水平 |

**所以"彻底重构"的正确边界是：表现层重写，能力层保留。** 把 token 体系当作新表现层的输入，而不是被重写的对象。

### 8.2 重写的六层

1. **版式系统（为"读"服务）**：给"读"单独一套阶——display / title / section / body / quote / caption / micro；答案与记录共用；表格成为一等公民（表头、行分隔、数值对齐、单元格内引文标记位）；列表的真实序号与缩进；脚注/引用块；行宽随容器而变，68ch 是上限。
2. **布局与信息层级**：三区职责写清（rail = 场所、preview = 文档、panel = 对话与记录）；面板默认 420、上限 640，折叠态记忆并带过渡；答案头部一行（读了哪几页、几步、多久），工具噪音退到其后；空态与首屏重做（建议贴着输入框、随当前页生成）。
3. **组件骨架**：用 Radix 原语重建菜单/弹出/对话框/抽屉/工具提示，删掉 11 份手写协议；消息行从 `ChatPanel` 抽成 `MessageRow`；`ChatPanel` 的 34 props 收敛成 `agent`/`connection` 两个切片 + composer；React Compiler 兜底重渲染，删掉手写比较器与三个绕行 ref。
4. **动效系统**：三档时长（120/160/250）不动，补四类动作——进入/离开（面板、抽屉、浮层）、布局变化（答案插入、列表增删）、状态切换（选中、开关）、进度（读取、流式）。用 `motion` 做跨元素协作，CSS 保留呼吸/脉冲。reduced-motion 全覆盖（现有一处全局兜底，继续保留）。
5. **文案与状态**：状态词一份（F3 合并）；首次提示机制（`onboarding-hints` 已有）；去掉解释性长句与工程口吻；一个概念一个名字（§1.6 的两处漂移）。
6. **原生质感（可选，需真机）**：Tauri `setEffects`——macOS vibrancy 材质（侧栏与面板坐在真实材质上）、Windows Mica；`setBackgroundColor` 消除启动白闪；Linux 无效果时退回不透明底色。这一层是"精致"最直接的来源，但**只有真机可验证**，因此列为可选包。

### 8.3 不重写（边界）

- **能力层**：agent 循环、工具、引文核对与三种状态、记录/标记 store 的语义、导出（报告/证据 PDF/CSV）、OCR 管线。
- **守卫体系**：CSS 卫生、选择器顺序、i18n 未用键、raw-button 理由、焦点环地板——它们会在重构中不断失败，这是要的（它们是"重构没有偷偷降低标准"的证明）。需要同步更新的断言与 §8.2 一起提交。
- **手写骨架的替代顺序**：先替换一条路径（菜单 + 对话框），跑 `npm test` 与 `ui:shots` 后铺开；旧 hook 在新原语覆盖前不删。

### 8.4 验收（在 §4 之上追加）

14. 正文级文本 ≥ 12px 且 ≥ 4.5:1；**不存在**低于该线的常驻文字（动作按钮、提示、标签）。
15. 版式阶成立：答案内 h1/h2/h3 至少三档且相邻比 ≥1.2；`.markdown table` 有规则，截图验收（浅色/深色各一张）。
16. 浮层协议收敛：`useOverlayLock` / `useFocusTrap` 的**直接调用点**从 12 处降到 ≤2 处（其余经 Radix 原语）；Esc/背板/焦点归还由原语保证。
17. 动效覆盖：面板开合、浮层进入离开、引文点亮三处都有过渡；`prefers-reduced-motion` 下全部瞬时（两种状态各断言一次）。
18. 面板宽度：默认 ≥420、上限 ≥640；900×600 下预览工具栏无遮挡（沿用他们已有的 `PREVIEW_FLOOR` 断言）。
19. 原生质感（真机，可选）：macOS/Windows 有材质且主题切换同步；Linux 无效果时底色正确无透明洞。

### 8.5 视觉方向（草案）

两条方向供选择，都是"同一套 token、不同的信息组织"，不是换皮：

- **A · Quiet Reader（安静的书桌）**：文档是主角（画布更中性、页间节奏清楚），会话栏像一页排好版的纸（真实台阶、表格有框线、工具噪音退成脚注），rail 与面板用材质/阴影分层。克制、通用、改动面最小。
- **B · Margin Notes（页边批注）**：同一套版式，但答案与结论以卡片锚在所选的段落旁（会话栏可完全退场），长回答才回到侧栏。更"顶级"，但需要先在"选中→提问"这条路上把答案↔原文的锚定做扎实（§2.3）。

概念图（仅供方向讨论，不是规范）：见本次 thread 的 `.amp/in/artifacts/v17-direction-concepts.png`。**建议先做 A，把 B 的锚定能力作为包 2 的延伸验证。**

### 8.6 风险

- 组件栈替换是本次最大的一次性风险（11 个文件的无障碍骨架）；用"一次一条路径 + 守卫不放松"消化。
- React Compiler 会暴露 Rules of React 违规，重构前先跑 `eslint-plugin-react-hooks` 的 compiler 规则热身。
- 原生材质只在真机可验，且 Linux 缺支持——先按"无效果也正确"实现，再加效果。
- 表现层重构期间禁止同时改核对逻辑（避免"颜色变了还是判定变了"分不清）。


## 9. 实施记录（17.0.0，同日）

方向确认：做"读物级答案 + 就地提问 + 一个词/一套动效 + 结构去重"，依赖按 §7.4 的第一组升级；表现层的三条（Radix / motion / React Compiler）与浮层内输入留待下一次，理由见下。

### 9.1 做了什么

| 块 | 结果 |
|---|---|
| 包 0 · 门 | `eval` 与 `ui:inventory` 接进 CI（新增两个 job）；契约快照按上游语义改写（`abort` 收尾、无 `finish`、信号释放），**`npm test` 从 1 红变全绿**；依赖第一组升到 `ai` 7.0.140 / `@ai-sdk/react` 4.0.143 / `@ai-sdk/openai` 4.0.93 / `pdfjs-dist` 6.4.299 / `vite` 8.3.4 / `vitest` 5.0.4 / `playwright` 1.64 / `jsdom` 30.1.2 / `zod` 4.6.7 / `lucide-react` 1.56 / Tauri JS 2.12.3；`cargo update` 到 `tauri` 2.12.3、`pdf-inspector` 1.25.2、`keyring` 4.2.0 |
| 包 1 · 读物级答案 | 阅读字号阶（`--text-read-display/title/subtitle`，21/18.5/16.5，正文 15）驱动 h1–h4；`.markdown table` 体系（表头底色、1px 行分隔、数值列右对齐 + `tabular-nums`、`md-table-wrap` 横向滚动、单元格内数字识别在渲染器里做）；列表/`hr`/`blockquote` 节奏；**工具步骤移到答案之后**（仅已结束的消息；流式期间保持原位，段索引保留以便 key 稳定）；会话栏默认 360→**420**、上限 480→**640**（拖动分栏时禁用过渡，否则手柄会延迟跟随）；空会话首条建议=当前页（"What is on page N?"） |
| 包 1 · 对比度 | `--accent-text`（6.5:1 深 / 6.4:1 浅）用于句内链接与活动标签（4.07 → 6.5）；`--finding-text`（浅色 5.7:1）；引文标记 `max(11px, 0.72em)`；`Copy`/`Keep` 12px/7.5:1（原 11px/3.96:1）；输入框提示 12px/7.5:1 且**只说一次**（`onboarding-hints`） |
| 包 2 · 就地提问 | "Ask about this" 之后**光标落在输入框末尾**（`focusComposer` + 隔帧请求，实测 `activeElement` 为 textarea、caret=27=末尾）；⌘+/⌘−/⌘0 缩放、`j`/`k` 滚动一屏；面板开合 160ms 过渡（收起用 opacity 而非 visibility，避免首帧内容先消失） |
| 包 3 · 一个词 | 三份状态词 + TS 里的两份 brief 表合成 `src/lib/trust-text.ts` 一张表（删 25 个键、加 26 个；40/41 条读者可见文案逐字节不变）；"读取未扫页" 统一为 **Read pages with no text / 读取没有文字的页**（横幅、命令面板、给模型的那句提示三处一致）；设置里两段工程口吻的说明改写（中英）；`ClearChatConfirm` 仍是 `ConfirmOverlay` 的调用（未删文件——它表达的是"destructive confirm"，语义保留） |
| 包 4 · 结构 | `src/lib/json-store.ts`：七处 store 骨架合一（六份 md5 相同的 `withStoreLock` + 一份改名；`flushMarkStore`/`flushFindingStore` 只差名字的两个 45 行函数）——七个模块净减 317 行，B6/B7 回归测试原样通过；**29 个死导出删除**（含 `savePreferences`、`getActiveProvider`、`combineAbortSignals`、`summaryToMarkdown`、四个未用图标、`@deprecated` 的 provider 别名）及其只服务于它们的类型/常量；**6 个死 CSS 类删除**，并修好 `find-dead-css` 的豁免漏洞（豁免只来自 class 位置，且只跟进一层的字面量类表；`css-hygiene.test.mjs` 新增四条测试把"路径字面量"和"类名前缀"分开） |
| 包 0 · 度量 | `ui:inventory` 新增四条读者可见断言：会话栏 ≥420、答案标题/正文 ≥1.2、表格有内边距与行线、动作按钮 ≥12px 且 ≥4.5:1 |
| 包 1 · 证据 | `ui:shots` 新增第 13 张 `07b-answer-typography`（结构化答案：标题、列表、带引文的表格），表格与标题的版式从此有截图可比 |

### 9.2 与计划不同之处

- **浮层内输入（§2.3）没做。** 现在"Ask about this"把选区送进输入框并聚焦，读者直接打字；浮层内输入需要第二条发送路径（与 composer 的 steering/中断逻辑并存）和 IME 组合期的处理。收益是省一次指针移动，风险是两条发送路径长期分叉。留待 17.x。
- **Radix / motion / React Compiler 没做（§8.2 第 3、4 层）。** 三者是同一个包：Compiler 要求清掉"故意不写依赖"的写法，Radix 会替换 11 处手写浮层协议，motion 只在两者完成后才有意义。它们动的是运行时结构而不是版式，且无法在本环境验证 macOS/Windows 上的表现；在没有真机反馈前引入，会把"版式回归"和"结构回归"混在一起查。§7.4 第二组的完整清单与顺序保留在案。
- **`ChatPanel` 的 34 props 与 `SessionProvider` 的拆分（F3/F4）没做。** 它们与包 1/2 改的是同一批文件，同一次提交里做会让 diff 无法按意图阅读。
- **文档面的两处漂移只修了一处。** README 的信任模型与导出已改；`eval/README.md` 里 15.0 的旧数字未改（它是评测语料自己的说明，改动会牵动门槛叙述）——列入 17.x。
- **`reading.ts` 的 `SCAN_LIMIT_NOTE` 改了措辞**（把命令面板里的名字对齐）：它属于模型看到的那段文字，`README` 的"系统提示字节不变"只约束系统提示，不约束工具结果；已确认无测试断言其字面量。

### 9.3 实测

| 项 | 结果 |
|---|---|
| `npm test` | **137 文件 / 1,078 用例全绿**（基线 1,071 全绿 + 新增 7 条） |
| `npm run eval` | 6 套件通过；location 98.5%（≥90）、altered 1/1997（≤1%）、search 32/36（≥80）、coverage 6/9（≥60）、ocr 84.1%（≥80）、annotate 626/629（≥97）、numbers 0 误报 / 138 漏检 0 |
| `audit:citations` / `tables` / `claims` / `ocr` | 15/15 · 9/9 · 10/10 · 9/9 |
| `ui:inventory` | 10 条全 PASS；读数：会话栏 420、正文 15px、h2 18.5px（步进 1.233）、单元格内边距 9.1px + 1px 行线、动作按钮 12px / 7.47:1 |
| `ui:shots` | 13 张，无 console/page error；逐张看过（`02-document`、`07-answered`、`07b-answer-typography`） |
| `npm run build` | 通过（8 chunk，无 console 残留）；`check:css` / `check:css-order` / `check:buttons` / `check:i18n`（480 键）/ `find-dead-css`（0 死类）全绿 |
| `cargo update` + `cargo test` | 见 §10（工具链在本次评审中才装好） |

### 9.4 仍未验证

- 真机：macOS/Windows 的窗口材质、IME 组合期、真实键盘上的 ⌘+/⌘0、拖动分栏的手感；Linux 上的行为只在 Chromium（非 WebKitGTK）里看过。
- `cargo test` 与 release 构建在 CI 三平台上；eval 的 OCR 中位耗时门槛（5000ms）在更慢的 runner 上可能接近。

---

## 10. 核验记录

### 我实测的

- 依赖版本：`npm view` 与 crates.io API 逐个查询（2026-10-14 当天），表见 §7.1/§7.2；`npm view <pkg> dist-tags` 确认 `ai` 无 v8 线、`react` 无 20、`pdfjs-dist` 只有 6.4 一条 latest。
- `npm test`：136 文件 / 1,071 用例 / 1 失败（`agent-stream-contract.test.ts:238`，`finish-step` 在 `abort` 前）——本机 Node 26、锁文件与 tag 一致。
- `npm run ui:shots`：12 张，无 console/page error。
- DOM 度量：正文 15px/24.75px、行宽 335px、`maxWidth` 648.955px、`h1-h3: 1em`、动作按钮 11px/3.96:1/26×24、`composer-hint` 11px/3.96:1、`page-ref-link` 4.07:1、`.empty-example-chip` 12px/7.47:1、`.sidebar-tab`（未选中）12px/7.47:1。
- 交互：拖选 → 浮层（"Ask about this"/"Mark"）；"Ask about this" 后焦点仍在 `.pdf-scroller`；双击选词正常；PageDown 0→796、Space 0→752、Ctrl+= 无响应；`.chat-column` 无过渡。
- 结构：6 份 `withStoreLock` md5 相同（`1f75edb…`）+ 1 份改名；两份 flush 各 45 行、unified diff 23 行；`ChatPanel` 34 props；`SessionContextValue` 30 字段、`useSession()` 1 个调用点；`cite.*` 21 / `record.trust*` 9 / `table.status*` 8（python 计数）；`.doc-name`/`.doc-meta`/`.doc-search`/`.tool-debug`/`.tool-fold-state`/`.tool-label` 6 个死类（用 `find-dead-css` 的逻辑、把 `composed` 前缀只从非测试文件取）；v15.0.0 词条 593 → HEAD 478（少 115）。
- CI：三个 workflow 里 grep 不到 `eval`、`ui:inventory`、`audit`；`check-css-order` 的快照函数只收集选择器/at-rule 前导。
- 死导出抽样：`savePreferences`、`getActiveProvider` 无任何引用（`zoom.ts` 的 `ZOOM_STEPS` 是"导出但仅内部用"，不算死——与代理报告不同，见下）。

### 读代码（未运行）

- `usePdfViewer.ts:167-190` 的键盘表；`11-pdf-layers.css:298` 的全局 reduced-motion；`tokens.css` 的 token 依据；`agent.ts:154` 的表格要求；`find-dead-css.mjs` 的豁免逻辑（配 `chat/persist.test.ts:34` 的 `/doc-${i}.pdf`）。

### 上游资料（读文档，未运行）

- 依赖能力来自上游文档：AI SDK changelog（`ai` 7.0.123→7.0.140、`@ai-sdk/react` 4.0.126→4.0.143，逐条核对到 commit 级）、pdf.js v6.3.289/v6.4.299 release notes 与 PR（#21810/#22058/#21829 等，以及 `049f59a` 尚未发版）、Tauri `Effect` 枚举与 `setEffects()` 参考（docs.rs 2.12.x / v2.tauri.app）、React Compiler 1.0 与 `@vitejs/plugin-react@6` 的 Vite 安装说明。这些是"上游这么写"，不是"本项目已验证"。

### 代理核对、我复核后修正的

| 代理结论 | 我的复核 | 采纳 |
|---|---|---|
| 死 CSS 类 36 个 | 只有 **6** 个（其余是代理的补丁版把测试文件的"应用"也算进去了） | 采纳 6 |
| `ZOOM_STEPS` 等"零引用" | `ZOOM_STEPS` 在 `zoom.ts` 内部有用，属"导出但无外部引用" | 归类修正 |
| 设置 11 行 vs 21 | CHANGELOG 写 11；`ui:inventory` 与代码是 9 行（通用 6 + AI 3） | 采纳 9 |
| v16 删了 137 个未用键 | 我数到少 **115** 个键；代理用 check-i18n 在 v15 源码上数到 96。"137"不可复现 | 采纳"不可复现" |
| 页码签对比 2.56:1 | 该值来自我的对比度脚本对"祖先白底"的判断，不是实际绘制背景；实测在它的包围盒位置取不到像素（z-index 提升后仍取不到），而元素自身截图能拍到数字 | **列为可疑项**，不计入缺陷，留待真机确认 |

### 未验证

- `cargo test` / `cargo clippy`（无工具链）；`npm run eval`（同上，需 `eval/extract` 构建）；`audit:ocr`（需生产构建 + `pypdfium2`）。
- 真机 iOS/macOS/Windows 的拖放、文件关联、keychain、字体光栅化差异。
- 页码签的可见性（上表）；扫描页高亮的 25% 偏低（v16 待办，读代码可见它在 `FindingLayer` 一侧，未复现）。
