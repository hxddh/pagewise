# v20 方向评估：答案住在纸边、每一句都被核对、扫描件配得上同样的问题

*2026-10-14。基线 main `fa1c1fd`、`VERSION 19.0.0`（tag `v19.0.0`）。*

*口径：**实测**＝在这个 orb 里量出来的（`node -e`/`du`/`magick`/`npm view`/crates.io API/`curl`；没有跑构建、服务或 Playwright）；**读代码**＝`file:line`；**上游**＝上游 README/crates.io 的事实；**实测（仓库自带）**＝仓库里已提交的测量产物（`.perf/report.json`、`eval/out/*.json`、`complexity.snapshot.json`）。凡不确信的写明"未量"。*

*本稿合并自四份逐模块审计片段（01 阅读面与文档管道、02 答案列与 agent、03 数据/持久化/Rust 与安全、04 chrome/设计系统/门/i18n/文档）；片段是工作稿，已删除，本稿是唯一在库版本。§1 按模块重排，保留全部 `file:line` 与数字。*

## 0. 结论

1. **v20 的三句话：答案住在纸边；每一句都被核对；扫描件配得上同样的问题。** 三件都是把已有的东西做深——页边列让面板在常见情形下不必打开；句级状态把已经可用的本地核对从"引文"抬到"句子"；扫描件先修"读得贵、读得没有上限"，再决定引擎。
2. **页边列的账（实测换算，1440 窗宽）**：面板关 + 240px 列 → 页宽 **1,096px**；今天（面板开、无列）**911px**；面板**开** + 列 → **676px（−26%）**。**收益只在面板关时成立**——这是决策数；实现上列只在面板关时占宽（§2.1、§6）。
3. **列的前置是 fit-width 的三个接缝**：`fitWidthScale`（`page-layout.ts:227`）、`buildScaleKey`（`pdf.ts:163`）、scale 变化时的滚动锚定（`PageScroller.tsx:191-204`）；另有一条潜伏错用——fit 键只记容器宽度，解析出的 scale 变了而键不变时旧比例位图会被贴回并被 `.pdf-page-slot { overflow: hidden }`（`preview.css:452-466`）裁掉（`pdf.ts:647` + `:631-637`）。列让 scale 随面板开合变化，会把偶发洞变成常态。**先修这三处，再做列。**
4. **句级核对不是新功能**：今天核对只回答"引文在不在页上"（`citation-check.ts` + `quote-locate.ts`）；`claim-review.ts` 是读者手动触发的模型补丁，只存内存、不进任何导出；没有标记的句子不进分母也没有状态；footer 的 "N verified" 数的是**引文**不是句子。本地检查的现成上界（实测（仓库自带））：定位 **1,007/1,022**（98.5%）、改坏引文 **1/1,997** 被误判、数字 **179/179** 零误报、**138/138** 错值全抓。把这三样拼起来，就是"每句一个状态"。
5. **扫描件的原定路线是死的**：上游 README 原文 *"ocrs currently recognizes the Latin alphabet only"*（上游，本次 `curl` 核对）；中文门 ≥85%（`eval/ocr.eval.ts:53-59`）不可达；`ocrs` 0.13.1 不暴露置信度，而 app 在置信度 30/70 上做判据（`ocr-result.ts:67`、`index-queue.ts:92`）；再加 12.2MB 模型与像素过 IPC。今天**换引擎与升级感知两条路都没有达到中文门**，本稿不声称达到（§2.3、§4）。
6. **结构账先还（允许且欢迎）**：store 写入是整文件、非原子的（10,000 标记 = 4.48MB/次 flush；torn write 会读成空再覆盖——读者数据的第一风险）；**`check:budget` 不在任何 CI 或门里**（`rg` 只命中 `package.json:21`、`CHANGELOG.md:11,36`），与 v19 评估稿写的"计数脚本在 CI 里跑"相反；8 个数里**两个不是测量**；`document-scope` 清单不全；`index-cache.json` 版本不匹配即丢已付费文本。
7. **依赖：v20 不需要新依赖**（实测）。前端与 Rust 侧全部已在最新 stable；`npm outdated` 只报 5 个补丁级落后。若走"换一个保中文的识别器"，候选族 `ocr-rs` 2.4.1（PaddleOCR 模型 + MNN）可查，但要一次独立 spike 与自己的门数——在数出来之前不进计划。
8. **数值目标（可验收）**：§4 的 30 条；主决策数见第 2 条与 §2。
9. **不做**：多文档、金额、缓存命中解析、分块重组、首屏包（v19 的结论照旧），外加与"专注与简单"冲突的若干片段提案（双引擎 OCR、"每句必须带标记"的提示词硬规则、运行中成本条、⌘F 下一个命中）——§5 逐条给理由。
10. **一句话的 v20**：*答案回到纸边，每句话各有其状态，扫描件不再低人一等；为此先还掉挡住它们的三笔结构账。*
11. **成本账（新增 §7，逐环节）**：典型一问 **≈$0.0018–0.0023**（3 步，cached/uncached）；20 步整篇一问 **≈$0.010 cached / $0.013–0.019 全价**（输入 4.5 万–11.5 万 tokens，固定前缀 44,640 占 40–47%，gpt-4o-mini 公布价，上游）；**一页扫描件 ≈$0.004–0.006（图像 token ≈2.6 万–3.7 万）≈ 20 页文本阅读**，自动 sweep 默认 20 页 ≈$0.086/文档；一页本地 OCR = $0 但 2.64s CPU。
12. **单笔最大的浪费是"没人要的页"**：OCR sweep 无页数上限（300 页 ≈6.6 分钟 CPU）、视觉 1568 路径（2.0–2.2× 字节）、`index-cache.json` 版本降级即丢已付费文本（≈$0.086–0.21/份）。§7.10 按回报排了 9 项，每项写明 today→target、证明命令、以及**删/退役什么**来支付。

## 1. 现状：逐模块审计

### 1.1 阅读面：一个窗口化滚动列

- **`PageScroller.tsx`（303 行）**：`SIDE_PADDING`=24（`:17`）、缩放 0.25–4（`:18-19`）、hurry = 240px/事件 + 160ms 静默（`:21-22`）、overscan=1（`:114`）、测量窗口＝可见±8 且第 1 页优先（`:120-143`）、scrollTop 每帧一次 rAF 合并（`:223-233`）。实测（仓库自带 `.perf/report.json`，2026-10-14T16:13，Chromium+mock shell）：120 页打开 **slots 2 / nodes 217 / heap 18MB / firstRaster 611ms / firstTextLayer 724ms**；fling 后 settle **608ms**（预算 1,500）；jumpToEnd longTasks 0；**30 页图 PDF firstTextLayer 12,690ms**（预算 40s，走 OCR 路径）；搜索 **342ms / 30 hits**（预算 1,200）；缩略图 first **463ms / 13 项**（预算 600）；100 轮会话 **653ms / 1,017 节点**；启动 appReady **221ms**（预算 800）。
- **`page-layout.ts`（239 行，纯数字）**：`PAGE_GAP:33`、`layoutPages:43`（缺尺寸兜底 `:49`）、`pageAtScroll:93`、`scrollShiftForRelayout:197`、`fitWidthScale:227`（按**已测出的最宽页**取 fit——中途出现横向页＝一次列重排 + 一次 scale 变化）。几何有测试（`page-layout.test.ts` 271 行）。
- **`PageSlot.tsx`（165 行）**：`raster = isRasterHeavyPage || hurried`（`:76`，阈值 48，`pdf.ts:24`）→ 扫描页与快速滚动降为 `performance` 光栅；`wantTextLayer = drawn && !hurried && textLen>0`（`:120`）。
- **键盘表 `usePdfViewer.ts`（246 行）**：⌘ `=`/`+`/`-`/`_`/`0`（`:173-191`）、PageUp/Down 与 `j`/`k` 按视口滚（`:194-209`）、Home/End 到列两端（`:211-218`）、←/→ 整页（`:219-223`）、守卫 `defaultPrevented`/`isTypingTarget`/`isOverlayOpen`（`:165-166`）、`registerPreviewActions`（`:153-158`）与命令面板共用动作。
- **缺陷**：① hurry 结束会把**所有**挂载页重绘一次（`hurried` 在 effect deps 里，`PageSlot.tsx:115`；settle 608ms 容得下，但它是纯浪费）；② 每页最多 4–5 次独立 `getPageGeometry`（`MarkLayer.tsx:45`、`FindingLayer.tsx:74`、`LinkLayer.tsx:54`、`AnnotationLayer.tsx:46`、`SearchHighlight.tsx:32`），无跨层缓存；③ `MarkNote` 是预览底部卡片（`MarkNote.tsx:19` 解释"不放在页上"），与页边注是两套；④ `PreviewPane.tsx` 618 行同时装状态机、重试（`vision_failed` 4s→30s、最多 6 次）、交互与叠加装配——任何页边列改动都要碰它。

### 1.2 页边与六层叠加：今天只到"悬浮可见"

- **页边只有 8px 点**（19.0）：`PageMarginBox:14`（top/left/height 由 scroller 给，`PageScroller.tsx:281-287` 用 `left: calc(50% + width/2)`）、渲染在 `PageGutter.tsx:111`、说明文字只用 `title`（`PageGutter.tsx:49-52` 注释：scroller 的 `overflow:auto` 会裁掉自绘 tooltip）。`MAX_GUTTER_DOTS:47`=12/种，顺序 mark→finding→answer（`page-gutter.ts:62-90`）。
- **`FindingLayer.tsx`（141 行）已算 `noteTop:88`**（锚点 bounds 的页内比例）与 `MAX_MARGIN_NOTES:27`=12——页边列的现成素材。
- **六层叠加**（Mark 101 / Finding 141 / Annotation 87 / Link 101 / Search 65 / Citation 53 行）各自一个 effect + 各自一次几何查询；都按页框百分比定位（页变窄即随动）——这是"页边列能便宜做出来"的原因。
- **缺的一块数据（读代码）**：答案在页边只有页号（`page-citations.ts:27-43`，每答案每页一颗 indigo 点），没有 y 锚；做列需要在答案渲染时保存引文矩形或页内比例。

### 1.3 fit-width 的三个接缝与 `pdf.ts` 的缓存账

- **三个接缝（页边列的前置，读代码）**：① `fitWidthScale`（`page-layout.ts:227`）；② `buildScaleKey`（`pdf.ts:163`，键是 `fit:${quantizeWidth(containerWidth)}`，32px 量子 `:25`）；③ 缩放变化时的滚动锚定——`PageScroller.tsx:191-204` 明确**排除** scale 变化（`if (!node || prev.scale !== scale) return;`），交给 `:209-221` 跳到 `offsetForPage`（页首）。
- **潜伏错用（读代码）**：fit 键不记解析出的 scale。文档中途出现横向页时 scale 变而键不变 → `tryApplyCachedPage`（`:647`）把旧比例位图贴回，而 `applySnapshot` 写的是**位图自己的 inline px**（`:631-637`）→ 页面按旧尺寸绘制、被 `.pdf-page-slot` 的 `overflow: hidden`（`preview.css:452-466`）裁掉，直到 LRU 淘汰。页边列让面板开合改变 scale，会把这条偶发洞变成常态。
- **10 处模块缓存**（读代码）：`pdfDocCache:34`（1 份）、`pdfBytesCache:35`+order（**3 份、无字节上限**，`:37`）、`inFlightDocs:38`、`pageCache:111`+bytes（128MB，`:23`）、`fitScaleCache:112`（**死代码**，只在 `:112` 与 `clearPdfCache` 出现）、`textLayerCache:118`（40 页 `:119`）、`renderQueue:150`、`activePaints:154`、`activeRenderTasks:157`、`cacheResetWaiters:1025`。纪元与门：`renderEpoch:39`、`pdfDocEpoch:42`、`displayGate:324`。
- **一页位图的账（实测换算）**：`getOutputScale:207` = min(2.5, clamp(dpr,1,2)×quality)；1440 宽、911px 页宽的画布 2278×2947 = 6.7Mpx = **25.6MB/页** → 128MB ≈ **5 页**；dpr1 时 6.4MB/页≈20 页。`effectiveDevicePixelRatio:193` 把 dpr 上限设为 2（3x 屏也只渲染 2x）——有意取舍，没写在缓存预算旁边。
- **200MB 扫描件**：字节缓存按**条数** LRU（3）而非字节预算，`loadPdfDocumentOnce:521` 又 `data.slice()` 复制一份交给 worker（`:529`，注释写明是保住缓存 buffer）→ 单份峰值 ≈400MB+，两份交替 ≈400MB 主线程常驻；200MB 本身是允许的（Rust `MAX_READ_BYTES`=256MiB，`lib.rs:223`）。`MAX_CACHE_BYTES` 不覆盖这笔账。
- **注释的错**：`pdf.ts:1098-1100` 称 1568/q0.85 是 1024/q0.80 的"3–4 倍字节"。实测（`magick` 重编码 `eval/out/scans*`，本次复核：paper-en 185→379KB = **2.04×**、contract-zh 96→197KB = **2.05×**；像素比 2.34×）——**2.0–2.2×**。默认值站得住，理由是错的。
- **第三种"指定像素"渲染是第三个复制点**：`visionRenderScale:994` / `regionRenderScale:1186` 的"除以 outputScale"约定（注释自记两次踩坑）；`pdf-render-scale.test.ts`（44 行）只钉住 vision 那一半。
- **大文档的界**：注解 >400 页整篇不采（`ANNOTATION_PAGE_LIMIT:128`、`:788`）；pdf.js 书签 ≤100（`:836`）；Rust 位置扫描 >1,000 页跳过（`inspect.rs:56`）、合成大纲 ≤1,000（`:60`）。是有界设计，但界面不解释"为什么这一页没有链接"。

### 1.4 文档管道与索引队列

- **打开**（`load-document.ts:49`）：`open_document_cmd`（Rust 一次解析，`inspect.rs:657`；≥0.9 置信度的扫描件短路成"每页 needs_vision" `:666-681`）→ 大纲（≤100）→ 页标签 → 注解（≤400 页）→ `loadIndexedPages`（vision 文本）→ `restoreOcr` → `mergePageTextsOnReload`（provenance vision>ocr>native，`page-text-merge.ts:16`/`:51`）→ `scheduleIndex`。进度 5/20/55/60/100%。
- **`doc-cache.ts`（167 行）只留 1 篇**（`MAX_CACHED_DOCS:10`=1）；`upsertPageText:69` 每页重建整个 pages 数组并 notify → `ranked-search.ts:90` 的 BM25 索引（`WeakMap<PageText[]>`）在每次落页后的下次搜索时全量重建。
- **`index-queue.ts`（731 行）**：每文档一队列 + generation（`:228-241`）；vision 池 3（`:48`）；预算：模块默认 50（`:47`）/偏好默认 **20**（`preferences.ts:107`）——agent 单问 20/10（`:73`）；`OCR_TRUSTED_CONFIDENCE:92`=70 以下才让 vision 上，且只有"OCR 读得差"的页用 1568/q0.85（`:99`）；vision 超时 60s（`:40`）；in-flight 合并、显式读不受 sweep generation 影响（`:502-545`）；`readingProgress:180`/`cancelReading:195` 是 19.0 的"正在读第 n/N 页 + 取消"；`reindexDocument:696` 只清要重扫的页。
- **OCR 的 sweep 没有页数上限（读代码）**：`scheduleIndex` 在 OCR 开且未给 cap 时把 cap 置 null（`index-queue.ts:633-641`）→ **全部**无文本页进 OCR 队列。300 页扫描 ≈ 300×2.64s÷2 slots ≈ **6.6 分钟 CPU**（实测（仓库自带）200dpi median 2.64s/页）；只有 vision 受预算。取消＝丢排队项 + abort sweep，**正在识别的那页不取消**（有意，`ocr-service.ts:189-196`）。
- **语言切换**会把在途结果丢弃并重算（`:280` 的 langs 校验，16.0 B7 的代价）。
- **未量**：1,000 页文本抽取（Rust `open_document`）的纯打开耗时——`eval/extract/target/release/pagewise-eval-extract` 已构建并按路径复用 `inspect.rs`，§7.1 本次跑出的 1,000 页 10.9s/RSS 57.2MB 是**含每页 positions 的上界**；纯 `open_document` 仍待量。

### 1.5 本地 OCR 引擎（tesseract.js）的现状与账

- **资源（实测 `du -sb`）**：`public/ocr` **10,678,666B / 7 文件**（2×2.85MB wasm core + 112KB worker + eng 2.95MB + chi_sim 1.72MB gz）；worker/语言/核心全在本地，**无网络**；两套 core 按 SIMD 探测选一（`ocr-engine.ts:29-40`）。
- **服务（读代码）**：`OCR_SLOTS:25`=2；前台请求插队 `pump:182`；`PAGE_TIMEOUT_MS:31`=90s 只重启卡住的 slot；语言切换先落盘再清内存。
- **识别结果（读代码）**：一词一个 run、PDF 点左下原点；`MIN_WORD_CONFIDENCE:67`=30 且只丢无字母数字的噪声词（注释记录：丢掉真词会掉 9 个点的中文）；`ocrDpiFor:76`=中文 300/英文 200。OCR 缓存按 identity 一文件、v2 分区（`ocr-store.ts:22`/`:90-93`），Rust 修剪 48MB/目录 256MB（`ocr_cache.rs:21`/`:23`，原子写 `:86-90`）；`sectionsOf` 解析失败会覆盖另一个语言组（代价是重识别，不产生错误结果——记在案）。
- **一页的账（实测（仓库自带）+本机换算）**：

| 一页 Letter | 画布（RGBA） | 识别 median / p90 | 落盘 JSON |
|---|---:|---|---:|
| 200dpi（英文/默认） | 14.3MB | 2.64s / 4.83s（41 页） | 25.4KB |
| 300dpi（中文） | 32.1MB | 3.58s / 7.28s（10 页） | 38.8KB |
| vision 兜底（1024/q0.80） | 离屏，先过 `displayGate` | 未量（网络） | 61–176KB（实测） |

- **eval 记录是 14.0 的**（`eval/README.md:39-51`：En 99.1% / Zh 87.8% / two-col 78.0% / table 68.7% / corpus 84.1% / median 2.2s）——五版未重测，而 19.0 改过 OCR 的调度（render-idle + 可取消）。

### 1.6 搜索与导航

- **一个 ⌘F**（`DocumentSearch.tsx` 229 行）：文档段（扫页 + `markdownToPlainText` + NFC + 逐码点大小写折叠，命中满 30 提前 break）+ 会话段；输入 120ms 去抖；结果 portal 进面板。实测（仓库自带）：500 页（840,801B）首命中 **342ms**（预算 1,200，hits=30）；19.0 review 记 304ms。**常见词便宜、稀有词最贵**（扫完全篇）。
- **`ranked-search.ts`（178 行）**：BM25 只在 agent 路径精确匹配为空时启用（`document/search.ts:33-42`），CJK 双字对 + 英文轻度词干；WeakMap 按 pages 身份缓存（`:90`）。
- **大纲**：pdf.js 书签 ≤100（`pdf.ts:836`）、Rust 合成/标签大纲 ≤1,000（`inspect.rs:60`）；`OutlineSidebar.tsx`（94 行）**逐条渲染**（无窗口化；`MAX_OUTLINE_DEPTH:15`=5）。`ThumbnailSidebar.tsx`（221 行）是窗口化的（行高 208+8、overscan 4）。缩略图有门（463ms/13 项），**大纲没有**。
- **命中高亮**：`SearchHighlight` 只读 `pageRuns`（扫描页即 OCR 词），上限 60 框，按**行 run** 匹配（跨行短语不亮，`search-highlight.ts:20-23` 如实记录）。
- **缺陷**：① 大纲不窗口化——1,000 条合成大纲＝1,000 个 DOM 行，且无 perf 场景；② ⌘F 关闭即丢结果，没有"下一个命中"；③ 稀有词/无命中的最坏路径**未测**（342ms 是"有 30 个命中"的数）；④ ⌘F 是子串匹配、agent 路径是 BM25——同一查询两套规则。

### 1.7 agent 循环与工具

- **固定前缀实测（本次复测）**：system 3,248B + 工具块 5,677B = **8,925B / 9,000B（余量 75B，0.8%）**；`npx vitest run src/lib/agent-tool-prefix.test.ts` 通过。
- **成本结构**（按 app 自己的估算器，`reading.ts:66,83-86`）：前缀 ≈ **2,232 tokens/步**，20 步 ≈ **44,640 tokens**，与整轮读取预算 **50,000** 同量级；两者在运行中都不显示（`RunPlanStrip` 只显示阶段与步数，`MessageContent.tsx:169-182,360`；用量行结算后才出现，`MessageAssistantFooter.tsx:453-455`）。

| 项 | 数字 / 行为 | 位置 |
|---|---|---|
| 步数 | min(30, max(20, pages)) | `agent.ts:70-77`、`:389` |
| 每步输出 | 8,000 tokens；流中断重试 1 次 | `agent.ts:98` / `:101` |
| 超时 | 首块 90s / 块间 45s / 整轮 45min / 单工具 75s | `agent-timeouts.ts:33,43,60,71` |
| 运行内压缩 | 最近工具结果保留 16,000 字符全长 | `compact-run-messages.ts:33-36` |
| 跨轮窗口 | 12 轮、按 4 轮滑；旧 reasoning 剥掉 | `history-window.ts:25,43,64-88` |
| steering | 运行中 ≤4 条 × 600 字符 | `agent-steer.ts:24-27` |
| 扫描额度 | 每题 20 次（看图与读无文本页共用） | `document/index-queue.ts:73` |
| 缓存断点 | 只对 openai provider 声明 | `agent.ts:184-191` |
| reasoning | 第一步低 effort，之后每步满 effort | `agent.ts:108,133-139,322-323` |

- **8 个工具（6 读 2 写；tools/ 806 行，`reading.ts` 645 行）**，各自的失败模式（读代码）：`read_pdf_range` 页文本为空时 `affordableChars("")` 返回 0（`reading.ts:97-103`）→ 直接 `truncated + budgetExceeded` 并附 `BUDGET_NOTE`（`:542-554,357-360`）——**一张空白页会终止整段阅读并告诉模型"预算已用完"**（静态推理，未执行；`read_section` 继承同一路径）；`read_pdf_page` 空页返回 `""` 且无说明（`tools/read-page.ts:140-166`）；`read_figure` 额度用尽时复用 `SCAN_LIMIT_NOTE`——明明在要图，却被告知"这页没有抽取文本"（`tools/read-figure.ts:65-66` vs `reading.ts:341-345`）；`search_in_document` 对空白敏感（`document-search.ts:71`），跨换行的短语命不中（`contract-zh` 页文本 101 条非空行里 33 条不以句末标点结尾，即折行续行的形态）。
- **三处真实缺陷（读代码）**：① `metaCallSignature` 与 `linksOnPages` 用字面 **NUL（`\x00`）**作 key 分隔符（`agent-loop-guards.ts:35`、`page-links.ts:38`）——`rg` 默认把这两个文件当二进制、只回 "binary file matches"，这些符号在仓库里"搜不到"（上游 main 同样，不是本 checkout 的偶发）；② `AGENT_STOP_WHEN`（`agent.ts:92`）用常量 20，又被 `prepareCall` 的 `stopWhen` 覆盖（`:389`）——同一语义两个来源；③ reasoning 的交易是**自认没量过**的（`agent.ts:121-131`），注释本身就是"要不要量"的证据。
- **盲区**：图不可像文字那样被引用（视觉描述不是页面 run，提示词只允许 `〔p12〕`，`agent.ts:158`）；没有结构就没有章节；矛盾没有本地检测（`revise_finding` 改不改全靠模型）；表格以文本读入，"reflow 会把相邻数字并成一个错数字"只写在注释里（`tools/document-outline.ts:115-117`）。

### 1.8 答案渲染与句级核对

- **渲染**：结算后工具段被挪到答案之后（`MessageContent.tsx:278-286`）；运行中四相 plan 带（`:169-182,360`）；**消息列表没有虚拟化**（`MessageList.tsx:127-152` map 全部消息）→ 历史上每个答案的每颗 chip 在重开文档时都会发起一次检查（结果按 path+引文缓存，`citation-check.ts:92-118`）。
- **chip 与三态**：`remark-citations.ts:91-96` 为每个标记算出它支撑的那句话（`claimBefore`），把 `{pages, quote, claim}` 编进 `pagewise-cite:` URL；`CitationChip.tsx:44-57` 挂载即发起本地检查；画成三种颜色 + tooltip 里带精确原因（`:77-97`）。
- **判定链（读代码）**：`citation-check.ts:151-190` 的顺序是"越界 → 无引号 → 逐页定位 → 任一页不可读则 `unreadable` → 任一页只有 OCR 词则 `unconfirmed` → 有页有文本且无此词才 `unlocated`"；`quote-locate.ts:49` 最短被检 6 字符、`:52` 单引文最多 40 run、NFKC + 全引号族归一、阅读顺序链式定位（注释记录两栏文档 40% → 98–99%）；`quantities.ts` 只读有把握的量（不读英文数词，宁可漏检）。
- **状态挂在哪（关键）**：挂**引文**不挂句子。`answerLevels` 按 `citationKey`（pages+quote）去重后计数（`answer-levels.ts:14-27`，全文 27 行），所以一句里两颗标记算两颗、没标记的句子算 0；footer "N verified" 的分母是引文（`MessageAssistantFooter.tsx:439-450`）。`verifiedSentences`（`citation-check.ts:257-285`）是**唯一**逐句实现，且只在整行每颗带引号标记都 located 时才收这一行，只在按 Keep 的那一刻跑一次。
- **模型复核**：`claim-review.ts`（164 行）只从 footer 的 More 菜单触发（`MessageAssistantFooter.tsx:295-341`），逐条一次 `generateObject`，判定 supports/contradicts/insufficient；结果只存在内存 Map（`:41`），随 document scope 清掉；除 chip tooltip/level 与计数外**不进任何导出**——CSV 与 brief 只写本地检查结论（`answer-tables.ts:151-157`、`export-brief.ts:130-133`）。
- **句子切分今天只有两处**：`citations.ts:120` 的 `SENTENCE_END`（把标记前文字归成一句）与 `keep-answer.ts:28`（把答案截成 claim）。全仓没有"一篇答案的句子表"（`rg` 全量确认）。
- **诚实边界**：本地能判"词在不在页上、句中数字在不在引文所在段落里"（`quantities` → `withClaim`）；**不能判蕴含**——正确的改写、条件丢失、否定翻转都超出本地能力，这是 `claim-review` 存在的唯一理由。`trust-level.ts`（75 行）已把 8 status → 3 level，且 `contradicts` 只能降级、永不上调（`:48-52`）。
- **两处表达要顺手修**：短引文（<6 字符）落 `uncheckable → unchecked → none`，读者看到"没有状态"而不是"太短没法查"；运行中 footer tally 被 `!live` 挡着（`MessageAssistantFooter.tsx:229,239-253`），读者看不到核对进度——而 chip 在标记闭合时就已经在检查了。

### 1.9 记录与出口（三套 key）

- **`finding-store.ts`（535 行）**：500/文档 / 5,000 总；claim 500、evidence 1,000、body 20,000 字符、单条 ≤20 页；handle 6 字符（`:58-72,266-269`）；写入 400ms 合并落盘。修订是单时间线（`supersedes`，旧条目保留）；`struck` 只由读者按；**位置永不持久化**（`finding-anchors` 每次重算，读不到 run 就不缓存空结果）。
- **`mark-store.ts`（314 行）**：2,000/文档 / 20,000 总、note 2,000 字符；标记**不写回 PDF**，只能随导出离开（`export-document.ts:5-8` 把理由写死了）。
- **导出四种**：brief（结论/依据/待复核 + 保留的整篇 body）、注释 PDF（只有 located/confirmed 才写，`export-annotated.ts:219-233`）、聊天 md、表格 CSV（BOM+CRLF、每行来源+状态、"found X of Y"；**只写本地检查**）。
- **三套 key**：引文 `pages+quote`（`citations.ts:100`）、复核 `path+claim+quote`（`claim-review.ts:55`）、记录 `id`；keep-verified 写进记录的 `claim/quote/page` 已经与答案句一一对应（`useRecordBridge.ts:62-79`）——"答案的每句话"与"记录的一条"天然是同一对象。记录与对话只有一条连线：`source.messageId`；聊天的持久化与记录是两个文件，谁的写入失败都不会互相回滚。
- **导出到不了的地方**：模型 verdict 到不了 CSV/brief（上节）；短引文的"没状态"也到不了任何地方。

### 1.10 持久化层与 document-scope

- **八个 JSON 文件**（`<app_data_dir>/`）+ 一个 Rust 管的 OCR 缓存目录 + `.window-state.json`。**每个 store 的一次保存 = 整文件重写**：插件 `save()` 就是 `create_dir_all` + pretty JSON + `fs::write`（读代码 `tauri-plugin-store-2.5.0/src/store.rs:306-314`、`lib.rs:335`），没有 temp+rename、没有 fsync、没有备份。到顶实测大小：10,000 条标记 pretty **4.48MB**（compact 2.44MB）、findings 到上限带 body **104MB**、100 个会话 **16.5MB**；flush 去抖 400ms（marks）/800ms（index）/500ms（会话自动保存）。
- **torn write 会把整个文件读成"空"，然后写回去**：插件在 `build_inner` 里 `let _ = store_inner.load()` 吞掉解析错误（`store.rs:225-229`）→ 缓存留作默认空表 → 下一次 `save()` 用新内容覆盖原文件。各 store 的字段级 sanitize 防单个坏字段，防不到"整个文件被覆盖"——而 marks/findings/chats 里装的是读者自己的东西。
- **`writeDocs`（`json-store.ts:206-210`）把整个 docs 数组序列化过 IPC** 再整文件写；`maxTotal` 按顺序裁、裁掉整篇文档（`:299-305`）——受害的永远是**没打开的**文档。
- **`settings.ts`（612 行）自己又写了一遍同样的锁**（`:128-137` 与 `json-store.ts:62-69` 逐行同构）。明文密钥镜像有去无回：keychain 写入失败一次 → 值落进 `settings.json` 的 `keys`（`:357-363`，注释写明故意）；此后 `readPayload` 见 v3 不再跑迁移（`:381-386`）、`loadApiKey` 见镜像是 string 直接返回（`:412-421`）、`saveSettings` 原样再存时 `keyArg = undefined`（`:598-611`）——**没有任何出口**，除非读者输入一个**不同**的 key。UI 只把它标出来。
- **`index-store.ts`（424 行）不吃 `migrateStored`/`preserveNewer`**：版本不匹配直接 `return []`（`:99`）——降级一次（新版写过 v2 索引）＝所有已付费 vision 文本被丢弃并重新计费；marks/findings 在 12.0 就有迁移保护，这里没有。
- **`document-scope.ts`（102 行）**：11 个注册项（`:42-70`：index-queue / ocr-service / doc-cache / mark-store / finding-store / finding-anchors / citation-check / claim-review / index-events / agent-view-context / pdf-render）；marks 与 findings 先 flush 再 forget。**清单不完整（读代码）**：注册表之外还有 `usage-tracker` 两张 map（`docVisionCalls:45`、`docVisionUsage:66`——按 path 累加、从不清理、不在 scope；表现：重开文档时 scan-all 确认框显示上一次的调用数，`App.tsx:348-353`）、`index-store.identityByPath`（`:164` 只增不减）、`preview-actions`（单槽）。机制是对的，清单会漏是机制的一部分。

### 1.11 Rust 后端、安全与打包

- **命令面（`lib.rs` 475 行 / 18 命令）**：形状统一（`Result<_,String>`、`ensure_allowed:34-40`、`spawn_blocking`、`run_blocking_pdf` 的 `catch_unwind:42-52`）；`read_file_bytes:261-288` 是全仓唯一的原始 IPC（256MiB 上限、1MiB 分块 + `AtomicU64` 代际取消，`lib.rs:223`）。白名单**会话级、只增不减**（`:54-59` 有明确论证）；写路径单独一套（只认注册的父目录 + 拒绝 `/`、`\`、`..`，`:297-336`；leaf symlink 一律拒绝含悬空 symlink，`:342-359`）；`export_annotated_pdf` 拒绝覆盖源文件（`:389-391`）。指纹是自家 12 行 FNV-1a64（首/末 64KiB + 长度，`:117-157`），注释写明"这是指纹不是签名"。
- **`inspect.rs`（1,378 行）**：唯一一次解析；`reflow_lines`（接回行末断词、CJK 不加空格）、`strip_running_lines`（页眉页脚同位置重复 ≥3 页才删）；**可见框原点修正（13.1）**用 `visible_origins`（`:746-774`）把 CropBox∩MediaBox 原点加回去，缓存按 (len, mtime) 失效、上限 8 条；`page_text_items` 逐页取、丢零面积 run（实测 75/23,107）；`extract_region`（`:903-935`）每次 `std::fs::read` 整文件 + 全页 positions——拖选一次读两次全文件，是已知的贵。
- **`annotate.rs`（408 行）**：先删上次自己写的（`PageWise:` 前缀识别）、上限 5,000 注释/256 矩形/contents 8,000；`annotate_file` 写到 `.partial` 再 rename（本仓第二个原子写）。
- **安全**：CSP（`tauri.conf.json:24`，`wasm-unsafe-eval` 今天是必需——tesseract core 与 pdf.js 的 JPX/JBIG2 都走 wasm）；asset scope 默认空、按文件 `allow_file`。**两处审阅者会挑的**：① capabilities 里 `plugin:store` 的 `store:default` 是全开（`capabilities/default.json:12`），而插件把路径 `BaseDirectory::AppData` 下 `push`（`store.rs:40-45`）——`PathBuf::push` 遇绝对路径会替换基目录（`tauri-2.12.3/src/path/mod.rs:353-369`），文件命令白名单管不到这条（威胁模型是"webview 里的任意脚本"）；② `check-secrets.mjs` 只看 `git ls-files`，`public/ocr`、`public/pdfjs`、`dist` 都在 `.gitignore` 里，误写进的凭据扫不到；`SECURITY.md` 没列 `index-cache.json`/`marks.json`/`findings.json`/OCR 缓存目录这四类本地文字。
- **打包**：`dist` 18MB（实测：assets 3.5 + pdfjs 4.0 + ocr 11）由 Tauri brotli 压缩**嵌进可执行文件**——10.18MiB 的 OCR 资源进二进制。四道自检各有盲区：`verify-bundle-version.mjs` 只 macOS；`check-bundle.mjs` 只扫 `dist/assets/*.js` 的 console；`check-entitlements.mjs` 钉 17.0.1 的教训（受限 entitlement＝进程在 exec 被杀、无 crash log）；`copy-ocr-assets.mjs:30-33` 在 tesseract.js 缺席时**警告并 exit 0**（整包能在没有 OCR 资源时构建成功）。未 notarize；Linux 需要运行中的 Secret Service（没有就是明文回退）；Rust 的 `cargo test` 只在 CI 跑，release 链只有 `npm test`。

### 1.12 chrome 与设计系统

- **`WorkspaceHeader.tsx`（384 行）**：面板开 6 个控件（prev/页码/next、2 个 tab、1 个 overflow）、关 4 个；overflow 7 行（最多 10）。缺陷：① `totalPages<=1` 时 `PageNav` 直接 `return null`（`:124`）——单页文档的 header 中间空着；② `AnchoredMenu` 没有自己的 z-index，靠父级 `.preview-toolbar { z-index: var(--z-toolbar) }` 排 20，而给它准备的 `--z-menu: 2500`（`tokens.css:261`）**零引用**——浮层顺序靠"互斥打开"而不是层级。
- **同一动作的第二条路**：search/export/clear chat/hide panel 同时活在 overflow 与 ⌘K 面板里（12 个 palette 命令里 4 个重复）；打开文档 5 个入口；rail 的 `+` 与 library 是两个按钮干一件半的事；`WelcomeView` 的 `welcome.toolsHint` 与 `empty.agentToolsLead`（`en.json:38,250`）**逐字节相同**。
- **`ReadingLine.tsx`（51 行）**：只有"在读/不在读"两态；取消后这行直接消失——**没有终态**，读者分不清"取消成功"和"界面没了"。
- **Zen**：状态在 App、CSS 落在被当作沉积层的 `13-chat-late.css`；进入后 ⌘K 仍能开 palette、没有键盘可达的退出提示（Esc 只关浮层）。
- **瞬时面**：toast/banner 都收敛到 `StatusLine`（19.0 最干净的收口）；`LoadingOverlay` 在 progress 为 null 时**无声**（`:12`，靠调用方 `App.tsx:323` 兜）；`DropOverlay` 是 `role="dialog" aria-modal="true"`（`DropOverlay.tsx:12`）但里面没有任何控件；进度条没有 `role="progressbar"`。
- **`SettingsDrawer.tsx`（260 行）+ `settings/*`**：**第三种 tablist 实现**（`:182-199` 手写 `role="tab"` 裸 button，而 `ui/Tabs` 就在旁边）；关闭键三种画法（`IconClose` / lucide `X` / 文本 `×`）；两种 alert 面（`settings-error-banner` ×2、`settings-callout-warning` ×1），都不是 `StatusLine`；`SettingsSkeleton.tsx` **零引用**；General 页读者看到 9 行（4 pill + 3 开关 + 模型 + Advanced）。
- **设计系统测量（本次）**：tokens 89 定义 / 86 被引；`--topbar-h`（`tokens.css:89`）、`--z-menu`（`:261`）是死的；CSS **5,985 行 / 18 文件**（budget 记 6,003，差在 `split("\n")` 每文件 +1）；规则 14 parts / 486 条；文件外只剩 5 hex / 5 rgba（其中 `04-chat.css:496: color: #fff`）；`!important` **9 无门**；z-index 24 处全 token；原语落地：Button 67 处/23 文件、裸 `<button>` 26（19 手写带理由 + 7 在原语内）；**焦点环的地板是 `:where()`（零特异性）**，撑住它的是 6 条组件规则 + 4 个 `outline: none` 的 `focus-exception:`——**任何新加的 `outline: none` 只要写了理由就能关掉焦点环**。

### 1.13 门、CI 与工具链（本稿最该先修的一半）

- **`check:budget` 不在任何 CI 或门里（实测）**：`rg check:budget` 只命中 `package.json:21`（定义）、`CHANGELOG.md:11,36`；不在 `prebuild`（`package.json:20`）、不在 `ci.yml` 任何 job、不在任何 test。而 v19 评估稿 `:177` 写"计数脚本（进 CI）"、`:189` 写"计数脚本在 CI 里跑"——**事实相反**。今天 8 个数全绿，但没有机器会在别人把它改回 18.0 时报警。
- **8 个数里两个不是测量（读代码）**：`tabs` 的 panel 项是 `? 2 : 2`（`complexity-budget.mjs:118`，两边都返回 2，且它读的 `PANEL_TABS`/`["chat","record"]` 在 `ChatPanel.tsx` 里已不存在）；`settingsRows` 数的是三个文件里 `settings-row-toggle|settings-pill-row` 这两个**类名字面量**出现 5 次，而读者在 General 页（Advanced 关闭）看到 9 行（按 `ui-inventory` 自己的选择器 `.settings-row-toggle,.settings-pill-row,.ui-field` 是 7 行）。`faces` 是手维护数组（`complexity-budget.mjs:50-69`）。真正可靠的是 `commands`（12 个 `id:`）与 `copyKeys`。

| 数 | snapshot | 口径 |
|---|---:|---|
| faces | 15 | 手维护数组 |
| tabs | 7 | 侧栏 union + **常数 2** + 设置 TABS |
| commands | 12 | `id:` 计数 |
| scanKnobs | 2 | 只认两个特定 i18n key |
| settingsRows | 5 | 类名字面量 |
| copyKeys | 473 | en 目录递归（本次复核 =473 ✓） |
| cssLines | 6,003 | 每文件 `split("\n")` +1 |
| srcLines | 38,564 | 非测试 .ts/.tsx/.css |

- **其它工具**：`css-hygiene.test.mjs`（41,603B / 24 test，`npm test` 会跑；它明确写下缺口：几何断言是"读源码文本"而非布局引擎、死 class 豁免来自 class 位置、`outline: none` 有理由就放行）；`perf-probe.mjs`（4 场景 / 21 检查；**只有 `answer.heapMb` 一个内存点**；整条链是 Chromium + mock shell）；`ui-shots.mjs`（13 张图，**不断言任何事**；注释指向的 `WelcomeView.test.tsx` **不存在**；Zen/ReadingLine/ExportDialog/ConfirmDialog 都不在图里）；`ui-inventory.mjs`（11 条断言，本半最有用的一条 DOM 不变量）。
- **CI 6 job**：test / windows-checks（check:secrets、css、css-order、buttons + hygiene——三个 Windows 回归换来的）/ rust / eval / ui-inventory / perf；另有 `extraction-drift.yml`（周一 cron）与 `release.yml`。`eval/` 6 套件（location ≥90%、改动 ≤1%；search ≥80%；ocr En 0.95 / Zh 0.85 / corpus 0.80 / FP ≤0.01 / median ≤5s；annotate ≥97%；numbers ≤0.5% 误报、≥85% 命中；live-score 无门）；`coverage.eval.ts` 19.0 已退役但 `ci.yml:121` 的注释还在列它。
- **`vitest.config.ts` 没有 `include` 过滤**（只有 `environment: "node"`）→ 仓库根任何 `*.test.ts` 都会进套件（片段审计时就观察到根目录一个未跟踪的临时测量文件被 `npx vitest list` 收进）。
- **整个门系统三个最大盲区**：① 没有任何自动化跑 `check:budget`；② "数出来的东西"没有 DOM/行为交叉验证；③ 跨端/多层只测一半（DOM 不变量只跑 Chromium+mock、性能不测 WebKitGTK 与真 IPC）。

### 1.14 i18n 与文档

- **i18n**：`en/zh-CN` **473 叶键**（本次复核 =473）；**55 个键在说 24 句已经说过的话**（31 个可去重）；**20 条英文 >90 字符**（最长 `llm.providerReturnedError` 204 字符、`settings.plaintextKeysWarning` 194）——几乎全是错误/确认文案，**为读者写得很负责任，但承担了界面不该承担的说明责任**。zh 整体像母语（术语稳定、量词标点正确），三个真问题：① `en.json:25,26,27` / `zh-CN.json:25,26,27` 都写 **Settings → AI Provider / 设置 → AI 提供商**——该 tab 在 18.0 就被删了；② `zh-CN.json:28` 引用旧控件名（"提问时包含当前页码" vs 今天的"提问时附带当前页截图"）；③ `toast.reindexStarted` 的 zh 里有英文 "vision"；"扫描"（16 次）与"扫页"（10 次）并用。
- **文档漂移**：`README.md:51,52,65`（文本缓存/截屏开关的实际位置；"nine scenarios, twenty budgets" 与实际 4 场景/21 预算不符）、`:56`（20/10 只是中间档）、`docs/RELEASE.md:31`（AI Provider）、`:88-94`（只列 5 个 job，漏 4 个）、`docs/SECURITY.md:28`（"one thread per document path"——13.0 起按内容指纹）、`ci.yml:121`（coverage 已退役）、`eval/README.md:39-51`（14.0 的 OCR 记录 + "Median 2.2 s"）、`scripts/complexity-budget.mjs:5,6,168,185`（教人跑不存在的 `npm run budget`）。
- **旧 review 没有作废头**：v14/v13/v12 及 7.x 描述的界面（两个 header、三个侧栏 tab、AI Provider、逐条 follow-up）早已不在；从 `docs/reviews/` 从上往下读会以为仍成立。最该先修的是 v19 评估稿的 CI 说法（`:177,189`）。
- **`CONTRIBUTING.md:24-30`** 的"提交前"只有 `npm test`/`check:secrets`/`build`——贡献者看不到决定这个仓库形态的门（`scripts/*.mjs` 28 个、`package.json` 12 个 `check:*`/`audit:*`）。

## 2. v20 的三个支点

### 2.1 支点 A · 答案住在纸边

**一句话**：面板关时，短答案和它的验证状态住在它引的那一页的右边（240px 列）；面板退回"长答案与记录"这一态。

**为什么**

- 页边是 19.0 已经承认的位置（A1 的落点），但它今天只到"8px 点 + title 悬浮"（§1.2）。答案的检验结果住在两处：流里的 chip 与侧栏的记录面板；而**读一条短答案**不该要求打开整个面板。
- **决策数（实测换算 @1440）**：

| 状态 | 页宽 | 算术 |
|---|---:|---|
| 今天：面板开、无列 | **911px** | 964−48−5 |
| 面板关 + 列 240 | **1,096px** | 1384−48−240 |
| 面板开 + 列 240 | **676px（−26%）** | 964−48−240 |

- **收益只在面板关时成立**——这不是口径问题，是决策：*面板开着时，列是在用页宽买一个读者已经用面板买过的东西。* 实现按此设计：列只在面板关时占宽；面板开时列收成点（或 0）。
- 便宜的原因在 §1.2 最后一条：叠加层是百分比定位，页变窄即随动；要改的只有容器与页边本身。

**做什么**

1. 右边保留 240px（左 24 / 右 240 不对称），列宽与页面一起参与 `fitWidthScale`；`PageScroller` 的保留宽从常量变成输入。
2. 列的条目＝该页的答案引文（indigo）、记录（violet）、标记（yellow）中"留在列里"的部分；**每条要有 y 锚**。数据的现成程度：finding 已有 `noteTop`（`FindingLayer.tsx:88`）；mark 可从 `mark.rects` 取；**answer 只有页号**（`page-citations.ts:27-43`）——需要在答案渲染时把引文矩形或页内比例保存下来（chip 的 reveal 路径已有 rects）。
3. `MAX_GUTTER_DOTS`（`page-gutter.ts:47`）与 `MAX_MARGIN_NOTES`（`FindingLayer.tsx:27`）的语义从"点的上限"变成"列的排版规则"——哪些条目留在列里、哪些只留记录面板。

**精确改动点（6 处，均已在本 checkout 复核）**

| # | 位置 | 改动 |
|---|---|---|
| 1 | `PageScroller.tsx:17,102,296` | `SIDE_PADDING` 常量 → 左 24 / 右 240 的保留宽；`fitWidthScale` 输入带保留宽；列 `minWidth` 同步 |
| 2 | `pdf.ts:163`（+`:25`） | `buildScaleKey` 带上保留宽与解析 scale（量化），两个不同 scale 不得共用 `fit:<qwidth>` |
| 3 | `page-layout.ts:197` + `PageScroller.tsx:191-204` | scale 变化（列开合）不再跳页首；改为"页内比例锚定" |
| 4 | `PageGutter.tsx:14` / `page-gutter.ts` | `PageMarginBox` 加列宽；条目规则重写 |
| 5 | `FindingLayer.tsx:27,88`、`page-citations.ts` | 答案锚数据补齐；两类上限语义升级 |
| 6 | 六层叠加 | **不用动**（页变窄随动）——这是回归面，不是改动面 |

**先决（顺序不可反）**：先修 §1.3 的三接缝与位图错用，并用测试钉住；否则列一落地就会看到"页面被裁"与"读者被弹回页首"两种新 bug——因为列让 scale 在容器宽不变的情况下变化，正好踩在两条潜伏错上。

**删/退役（为了不长大）**

- 8px 点 + 只在悬浮时可见的模型退役（点 → 列条目）。
- `MarkNote`（预览底部的注卡片）与页边注两套表达合并——`MarkNote.tsx:19` 给的理由（"不放在页上"）在有了列之后不再成立。
- 面板本身不删，但**"每条答案都要开面板"这件事删掉**；`page-citations.ts` 的"每页一颗 indigo 点"不再独自承担答案的页边表达。

### 2.2 支点 B · 每一句都被核对

**一句话**：把已有的本地核对（引文定位 + 数字覆盖）从"引文级、事后、手动的 patch"抬成"句子级状态"，让没有标记的句子也有一句话——"未核对"。

**为什么**

- 今天核对发生在答案写完之后、只发生在**有引文标记的句子**上；两句之间的散文句既不进分母、也没有状态；footer 的 "N verified" 数的是引文（§1.8）。读者得到的印象是"这条答案被核对了"，而实际被核对的是一部分。
- 本地检查的现成上界说明"抬到句子"有空间（实测（仓库自带）`eval/out/*.json`）：

| 检查 | 结果 |
|---|---|
| 引文定位 | **1,007 / 1,022（98.5%）**（`location.json`） |
| 故意改坏的引文被误判 located | **1 / 1,997**（`false-positives.json`） |
| 诚实数字被误报 | **0 / 179**（`numbers.json`） |
| 错误数字被抓住 | **138 / 138**（同上） |

- 成本上，机制已经存在：chip 在标记闭合时就开始检查（`CitationChip.tsx:44-57`）；`verifiedSentences` 已经做过一次"答案句 ↔ 记录"的连接（`citation-check.ts:257-285`）。缺的只有三件：**没有标记的句子的索引、流中的聚合视图、以及"verified 在本地能意味着什么"的诚实定义**。
- 边界要说死：**本地不能判蕴含**（正确的改写、条件丢失、否定翻转）；模型 verdict 只降不升（`trust-level.ts:48-52` 已是不变式）。任何"每句绿勾"的读法都是过度承诺；v20 卖的是"每句都有状态"，不是"每句都正确"。

**做什么**

1. **句子表**：本地切句（今天只有 `citations.ts:120` 与 `keep-answer.ts:28` 两处切分）→ 每句落 5 类之一：① 带引号 located/mismatch；② 带引号 unlocated/outOfRange；③ 带引号 unreadable/unconfirmed（OCR 页，只能请人看）；④ 只有页号、无引号（今天落 none）；⑤ **无标记（新增，最有价值的一类）**——把"没有说这句话有依据"从沉默变成一个词。
2. **分母换掉**：footer 的 tally 从引文计数改成句子计数（`answerLevels` 的口径抬到句子）；`verifiedSentences` 泛化（不再要求整行全 located）。
3. **流中可见**：运行中显示核对进度（tally 不再被 `!live` 挡）；短引文（<6 字符）显示"太短无法核对"而不是没有状态。
4. **模型 verdict 的去处**：`claim-review` 保持手动（它是本地判不了蕴含的唯一补丁），但它的 verdict 若进入句子状态，必须**带模型标签**；是否进导出（CSV/brief）作为一次显式产品决定记录在案——本稿建议进，带标签（今天不进；"每句被核对"在导出里断链）。
5. **提示词不加"每句必须带标记"的硬规则**：固定前缀余量 **75B**（实测 8,925/9,000）；任何新规则先从这 75B 里出，并说明删哪句换来（`agent-tool-prefix.test.ts` 就是那把尺）。"未核对"本身不需要模型——本地判"这句里有没有标记"即可。

**精确改动点**

- 新模块：句级状态表（本地切分 + 聚合 + 文案）。
- `answer-levels.ts:14-27`（引文去重 → 句子计数）；`MessageAssistantFooter.tsx:439-450`（tally）与 `:229,239-253`（live 抑制）；`citation-check.ts:257-285`（`verifiedSentences` 泛化）；`trust-text.ts`（chip/记录/CSV/brief 共用文案表，加"未核对"与"太短"两条）；`useRecordBridge.ts:62-79`（Keep 已是句子口径，保持）。
- 导出：`answer-tables.ts:151-157`、`export-brief.ts:130-133`（模型列/句子列的决定）。

**删/退役**

- footer 的"引文 verified"口径退役；
- 短引文的静默退役；
- `claim-review` 的"只有手动才有意义"定位退役（它仍手动触发，但结果进入句子的状态）。

**需要测量（进 §4）**：录制答案的句子数/带标记句数/located 比例——`live-score.eval.ts` 的 harness + scripted 模型现成（不用 key）；任何提示词改动的前缀字节 before/after。

### 2.3 支点 C · 扫描件配得上同样的问题

**一句话**：先把"读扫描件"的成本与上限修成可解释的（页数上限、进度、终态、分辨率与置信度判据），再决定引擎——换引擎按原定的 `ocrs` 路线是死的，中文门今天没有任何路线达到。

**为什么（成本实测）**

- `public/ocr` **10.3MB / 7 文件**（实测 `du -sb` 10,678,666B）在阅读同一个 webview 的资源池里；2 slots（`ocr-service.ts:25`）；单页 90s 看门狗（`:31`）；**sweep 无页数上限**（`index-queue.ts:633-641`）→ 300 页 ≈ **6.6 分钟 CPU**；中文 300dpi 一页 32.1MB 画布。
- vision 兜底 1024/q0.80 = 61–176KB/页（实测）；1568/q0.85 是 **2.0–2.2×**（实测复核 2.04×/2.05×；注释的"3–4×"是错的）。
- **原定路线的死因（上游核对）**：`ocrs` 0.13.1 README 原文 *"ocrs currently recognizes the Latin alphabet only (eg. English)"*；中文门 **≥85%**（`eval/ocr.eval.ts:53-59`）不可达。它也不暴露置信度（公开 API 只有 char/rect，无 probability——上游 docs.rs），而 app 有两处靠它（`MIN_WORD_CONFIDENCE`=30 的噪声过滤 `ocr-result.ts:67`、`OCR_TRUSTED_CONFIDENCE`=70 是否转 vision `index-queue.ts:92`）——**换引擎不是换一个数，是换掉一套判据**。代价面：+12.2MB 模型（上游下载地址 `curl -sI` 实测 2,499,479B + 9,713,177B，发布日与 0.13.1 同日），像素要过 IPC（200dpi A4 ≈3.7Mpx；JSON/base64 ≈5MB/页，或者给 Tauri 开原始请求体这条路今天没有先例），而渲染今天在 webview（`pdf.ts:1139`）。

**做什么（两条路，二选一，都要先有数）**

- **路 A · 换一个保中文的识别器**：候选族 = PaddleOCR 模型 + MNN（`ocr-rs` 2.4.1、`mnn-rs` 0.1.7，crates.io 可查；`rust-paddle-ocr` 这个名字不存在）。**先进 spike，不进计划**：塞进现有 `eval/ocr.eval.ts` harness（同页图、同 quote、同词→run 映射），给出 En ≥0.95 / Zh ≥0.85 / corpus ≥0.80 / FP ≤0.01 / median ≤5s 与 **p90**（今天 200dpi p90 4.83s、300dpi 7.28s），外加三件：产物增量 MB、每页峰值内存、"没有 confidence 之后"噪声判据怎么重定。**任一门不过 = 不换。**
- **路 B · 升级现有引擎的感知**（不换依赖）：分辨率按页型/区域（`ocrDpiFor:76` 今天只有两档）、区域 OCR（复用 `extract_region` 的表格/分栏路径，`inspect.rs:903-935`）、置信度感知的接受（两处判据已有，把"读得差的页才花 vision"做得更准）、sweep 的页数上限与可解释的进度。
- **无论哪条**：OCR 的评估数先重测（`eval/README.md:39-51` 还是 14.0 的记录，五版未动，而 19.0 改过调度）。

**精确改动点 / 删减量**

| 项 | 内容 |
|---|---|
| sweep 上限 | `index-queue.ts:633-641` 是唯一入口；`All`（真整篇）仍是显式动作 |
| 进度终态 | `ReadingLine.tsx`（取消后"已读 n/N，剩 m 页按需"）；`ocr-service.ts:189-196` 的"当前页不取消"保持 |
| 判据 | `ocr-result.ts:67`、`index-queue.ts:92`；读得差的页 1568/q0.85 路径（`:99`）随路 B 或保留 |
| 路 A 过门后删除 | `public/ocr` **10.3MB 全删**（2×2.85MB wasm + 112KB worker + 4.67MB 语言包）；**撤 vision 的 20 页预算**（它存在只因每页要花钱——`preferences.ts:30-39` 自述）；撤 1568/q0.85 路径；Rust 侧新 `ocr.rs` + 进程内引擎一次构建 |
| 路 B | 资源不删；删"没有上限"这件事；vision 预算保留（钱是真花的） |

**明确不做**：双引擎并存（tesseract + 原生）——两份资源、两条评估线，与专注直接冲突（§5）。

## 3. 依赖与内部 CLI/SDK 能力

**结论：v20 不需要新依赖。** 这是"把已有的东西做深"最直接的证明——三个支点用的（`radix-ui`、`motion`、React Compiler、`pdfjs-dist`、`tesseract.js`、AI SDK、Tauri 2 与插件）全已装，且除下面 5 个补丁级外全部已在最新 stable。

**前端（实测 `npm outdated --json` + `npm view`，2026-10-14）**

| 包 | 声明 | 装到 | 最新 | 判断 |
|---|---|---|---|---|
| react / react-dom | ^19.3.0 | 19.3.0 | **19.3.1** | 补丁级；v20 无新能力要用 |
| lucide-react | ^1.48.0 | 1.56.0 | **1.57.0** | 图标库；页边列若补图标可升 |
| oxc-transform-react | ^0.152.0 | 0.152.0 | **0.154.0** | React Compiler 转换；可升，不依赖其新特性 |
| playwright | ^1.63.0 | 1.64.0 | **1.64.1** | 测试用 |
| 其余全部 | — | — | 已最新 | vite 8.3.4、typescript 7.0.2、vitest 5.0.4、pdfjs-dist 6.4.299、tesseract.js 7.0.0、ai 7.0.140、@ai-sdk/react 4.0.143、@ai-sdk/openai 4.0.93、radix-ui 1.8.1、motion 14.2.0、zod 4.6.7、react-markdown 10.1.0、remark-gfm 4.0.1、@tauri-apps/{api 2.12.3, plugin-store 2.5.0, plugin-dialog 2.8.2, plugin-opener 2.7.1, cli 2.12.2}、jsdom 30.1.2、wasm-feature-detect 1.9.0 |

**Rust（实测 crates.io API + `Cargo.lock`）**

| crate | lock/声明 | 最新 | 判断 |
|---|---|---|---|
| tauri | 2.12.3 | 2.12.3 | 已最新；`macos-private-api` 与 `protocol-asset` 保持 |
| pdf-inspector | 1.25.2（声明 "1.25"） | 1.25.2 | 已最新；版本范围靠黄金样例挡漂移 |
| lopdf / keyring | 0.45.0 / 4.2.0 | 0.45.0 / 4.2.0 | 已最新 |
| 五个 tauri-plugin | store 2.5.0 / dialog 2.8.2 / opener 2.7.1 / window-state 2.5.0 / single-instance 2.5.3 | 同左 | 全部已最新 |
| ocrs | — | 0.13.1 | **上游：Latin-only、无置信度**——不进依赖 |
| rten | — | 0.27.0（ocrs 0.13.1 钉 0.26） | 不进依赖 |
| ocr-rs / mnn-rs | — | 2.4.1 / 0.1.7 | 候选族，仅 spike（路 A） |

**会用到的能力（不是"拥有"）**：① React Compiler（已开；页边列与句子表的组件不手写 memo）；② Tauri 原始 IPC 的 `Response` 方向（`read_file_bytes` 已有先例）——路 A 若需要像素过 IPC，`Request` 方向今天无先例，属 spike 内容；③ 内部工具面：`eval/extract/target/release/pagewise-eval-extract`（按路径复用 `inspect.rs`，是 1,000 页抽取耗时的现成测量路径）、`eval/live/run.mjs` + `live-score.eval.ts`（scripted 模型，句子统计的 harness）、`perf-probe.mjs` 场景框架（页边列跑新场景）、`ui-inventory.mjs` 断言框架、`check:budget --update`（只允许在"哪个面回来了"的提交里用）。
**不会用到**：AI SDK / Vite / pdfjs / Radix 的新版本特性（没有新版本或没有对应需求）。
**未验证**：路 A 候选族的识别率、内存、许可证与三平台构建（需要 spike）；macOS/Windows 真机行为。

## 4. 验收（30 条，全部可测；每条给出命令或 harness）

**页边列与 fit（先决）**
1. `buildScaleKey` 带上保留宽与解析 scale：两个输入各自改变时缓存 miss；单测（`npx vitest run src/features/preview/page-layout.test.ts src/features/preview/PageScroller.test.tsx` + 新增键测试）。
2. 位图错用回归：容器宽不变、scale 变（横向页/面板开合）时不得贴回旧比例位图（今天被 `overflow:hidden` 裁掉）；单测 + `ui:shots` 场景。
3. 页内比例锚定：面板开合后 scrollTop 停在同页同比例（位移 ≤1 行高）；`PageScroller.test.tsx` 扩展。
4. 页宽决策数（1440 窗宽，运行态实测）：面板关 + 列 240 → 页宽 **≥1,090px**；面板开 → 列不占宽；度量 = `perf-probe` 新场景或 `ui-inventory` 读 `.pdf-page-slot` clientWidth。
5. 列条目数据完整：finding/mark/answer 都有 y 锚；列排版规则有单测（谁留列、谁进记录）；页框 x 在列开合时不变（零布局位移）。
6. `SIDE_PADDING` 变不对称后，`page-layout.test.ts` 的几何与 `pageAtScroll`/`offsetForPage` 往返测试全绿。

**句级核对**
7. 句子覆盖：scripted 模型答案（`eval/live/run.mjs` 路径）经句子表后**没有句子没有状态**（每句落 5 类之一）；harness = `live-score.eval.ts` + 句子统计列。
8. footer 分母 = 句子（一个 2 句 2 引文的答案分母为 2）；单测 + 截图。
9. live 期间可见核对进度（tally 不再被 `!live` 挡）；组件测试。
10. 短引文显示"太短无法核对"（`MIN_QUOTE_CHARS` 边界单测）。
11. 模型 verdict 的出口决定落地并带标签（`answer-tables.test.ts` / brief 测试）；若决定不进，写明理由。
12. 前缀字节不涨：`npx vitest run src/lib/agent-tool-prefix.test.ts`，今天 8,925/9,000；任何新规则附 before/after 与"删了哪句"。
13. Keep 的句子口径与句级状态一致：keep-verified 保留的句子 = 状态为 verified 的句子集（现有测试 + 一条断言）。

**扫描件（perception）**
14. 现状重测进 `eval/README.md`：En / Zh / corpus / FP / median **+ p90**（今天 4.83s@200dpi、7.28s@300dpi）；命令 `npm run eval`（或既有缓存 + 显式重跑说明）。
15. sweep 有页数上限：`src/document/index-queue.test.ts` 断言给定 cap 时 OCR 队列不超；300 页场景的时间进报告；`All` 仍是唯一整篇入口。
16. 路 A spike 的门数（同 harness）：通过则换，输出产物增量 MB / 每页峰值内存 / 无 confidence 的噪声判据重定；任一不过 = 不换，记录在案。
17. 路 A 过门才允许删 `public/ocr`（`du -sb` = 0 + 构建断言无 OCR 资源）并撤 vision 20 页预算；不过门则本项标记"未发生"，现状保持。
18. OCR 取消有终态（ReadingLine："已读 n/N，剩 m 页按需"）；组件测试（`ReadingLine.test.tsx`）。

**门的诚实与结构还债**
19. `check:budget` 进 `prebuild` + `windows-checks`；本地把任一表面改回旧值，`npm run build`（走 prebuild）必须报红（手动验证一次并记录）。
20. `tabs` 删 `? 2 : 2`、`settingsRows` 从 DOM 数（与 `ui:inventory` 的 7 行口径一致）；`faces` 的来源写明（或同样从 DOM）。
21. `document-scope` 清单补齐或写明排除：打开 50 篇后 `usage-tracker` 两张 map 与 `index-store.identityByPath` 的 size 回到 ~1（测试）。
22. `index-cache.json` 加 `preserveNewer`：写入 v2 后用旧版读取，`index.newer` 存在且不产生重新计费（测试）。
23. store 写入安全：先记录（10k marks / 100 chats 的每次 flush 字节与耗时 + 中途杀进程的现状断言），再做原子写（temp + rename + fsync），torn write 后旧内容仍可读（测试）。
24. 收尾：明文密钥镜像出口单测（keychain 先拒后允 + reset 后镜像上交删键）；`plugin:store` scope 的 capability diff + webview 拒绝断言；文档漂移 8 处 `rg` 复核为 0；i18n 去重 ≤442 键且 `check:i18n` 绿；`role=tab|option|alert` 在 `ui/*` 外为 0（源码门）；`vitest.config.ts` include 收进 `src`+`scripts`+`eval`。

**成本目标（§7 的门；每条一个命令/harness）**
25. sweep 的 CPU 有数：OCR 开启时一次打开的 sweep 页数 **≤50**、300 页扫描件的 sweep CPU **≤90s**（今天无上限、≈6.6 分钟）；`All` 是唯一整篇入口；`npx vitest run src/document/index-queue.test.ts`（新场景断言页数）+ 计时记录进报告。
26. 视觉每页只有一条页面渲染路径：页面走 **1024/q0.80**，每页编码 ≤176KB、图像 tokens ≤3.7 万/页（`getDocumentVisionUsage` 或用量行读）；`rg '1_568|0\.85' src` 的命中只允许出现在 `read-figure.ts` 与测试；`magick` 复核方法 + `npx vitest run src/lib/pdf-render-scale.test.ts`。
27. 20 步的 token 账可复现：scripted 模型（无 key）跑 20 步 run，输出 前缀/读取/输出 三段与 `cachedInputTokens`；断言前缀 8,925B/9,000B、OpenAI 路径 `cached > 0`、前缀占比 ≤ 记录值；harness = `eval/live/run.mjs` + `live-score.eval.ts`（加 token 段）。
28. 重复读取为 0：同一 run 内第二次读同一页不发全文（已有，`read-runs.test.ts`）；第二次 `read_figure` 同一图 **0 次 vision 调用**（今天每次一次）；`npx vitest run src/lib/agent-tools/read-tools-contract.test.ts` + scripted run 的 `getVisionCallCount`。
29. 写放大与原子性：10k marks / 100 chats / 500 findings 三档的每次 flush 字节与耗时记录在案（今天上界 4.5MB / 16.5MB / 104MB），原子写（temp+rename）后杀进程不丢旧数据；`npx vitest run src/lib/mark-store.test.ts src/lib/finding-store.test.ts` + 新增 torn-write 测试（与 #23 是同一件事的两面：那条要机制，这条要数字不许涨）。
30. 重计费 = 0：`index-cache.json` 写 v2 后由旧版读取不丢页、不产生新的 vision 调用；`npx vitest run src/lib/index-store.test.ts src/lib/index-store-identity.test.ts` + `getVisionCallCount` 快照不变（与 #22 同面：那条要机制，这条要计数）。

## 5. 明确不做

1. **多文档 / 跨文档提问 / 库级搜索 / 分屏**（v19 §0.1 的结论照旧：读者的动作是"读这一份、问这一份"）。
2. **金额与账单**（一行数字换一张会腐烂的表；用量行已经完成成本可见）。
3. **缓存命中解析**（为一家提供商解析原始响应体，只为一行里多一个数字）。
4. **分块重组**（chunk shuffling）：不为省 token 切碎/重排页文本——页是读者与模型共享的单位。
5. **首屏包**（`ai` 移出 preload）：启动 221ms、预算 800ms，改动不可感知。
6. **双引擎 OCR 并存**（tesseract + 原生）：两份资源、两条评估线；要么换、要么不换。
7. **`ocrs` 0.13.1 这条具体路线**：中文门不可达（上游 Latin-only + 无置信度）；只作为"换引擎族"的背景，不作为交付。
8. **运行中成本条**：结算后的用量行保留；运行中不加新面（前缀/步骤的 token 可视化等它有一天有归属再说）。
9. **⌘F 的"下一个命中"与结果保持**：新交互/新状态；单次路径（342ms/30 hits）已够。
10. **"每句必须带标记"的提示词硬规则**：75B 余量出不起；用本地"未核对"状态代替。
11. **模型 verdict 自动升级任何状态**：只降不升的不变式保留（`trust-level.ts:48-52`）。
12. **顺手重构与顺手新面**：每项改动要么有数字、要么有门对应；没有的进 backlog，不进 v20。

## 6. 风险

- **页边列在面板开着时压 26% 页宽**（唯一要用两组数说话的风险）：实现上列只在面板关时占宽；两态都进验收；如果实现上做不到两态，宁可降列宽或不做。
- **fit 三接缝**：列之后，裁剪与跳页顶会变得容易触发；缓解 = 先修（§4 #1–#3）再做列（#4–#5）。
- **句级状态会过度承诺**："verified"的定义必须继续是"引文在页上 + 数字在段落里"；模型 verdict 带标签且只降不升；用 `live-score` 的录制答案覆盖，而不是靠文案自觉。
- **前缀字节**：新规则从 75B 里出；缓解 = 字节门与改动同提交，涨了就报红。
- **扫描件方向未证实**：两条路都可能不达门；缓解 = 先测量再决定；任何删除（`public/ocr`、vision 预算）只发生在门数通过的提交里。
- **读者数据风险优先于任何新面**：torn write / 非原子 / 整文件重写（§1.10）比三个支点都要先行（§4 #23）。
- **度量诚实**：`check:budget` 未进门、两个数不是测量、`faces` 手维护；在 §4 #19–#20 落地前，不拿 budget 当对外承诺。
- **未验证面**：macOS/Windows 真机（签名、材质、IME）、rten/Paddle 的许可与体积、1,000 页纯 `open_document` 耗时（§7.1 已给含 positions 的上界）、空闲 CPU 与每步 outputTokens 的基线（§7.8/§7.10）。

## 7. 成本账：每个环节

*三种货币：钱（tokens 折算）、CPU/内存、磁盘/写放大。价格只在模型可从代码确认时给出，且标 上游：2026-10-14 取 OpenAI 公布价（`developers.openai.com/api/docs/pricing`）——gpt-4o-mini **$0.15 / $0.075（cached）/ $0.60**、gpt-4.1-mini **$0.40 / $0.10 / $1.60**（每 1M input/cached/output tokens）；两者是 openai / openrouter 预设的默认模型（`types.ts:179,189`）。默认 provider 是 `deepseek-v4-flash`（`types.ts:164-166`），其公布价本次不可得——**未量**，所以钱按 OpenAI 路径算，换算过程全部写出来，读者可按自己的价重算。*

### 7.1 打开文档

| 项 | 今天的成本 | 组成 / 出处 |
|---|---|---|
| 原始 IPC | 文件字节的 2–3 份内存动作：Rust 读进 `Vec<u8>`（1MiB 分块 + 代际取消）→ `tauri::ipc::Response` 原样过 IPC → webview `Uint8Array`；再 `data.slice()` 一份交给 pdf.js worker（buffer 转移后缓存仍可用） | `lib.rs:223-224,226-268,287`、`pdf.ts:521,529`；读代码 |
| 字节缓存 | 按**条数** 3 份、**无字节预算**：200MB 扫描件单份加载瞬时 ≈400MB+（主线程缓存一份 + worker 一份）；两份 200MB 交替打开时主线程常驻可达 ~400MB（不含 worker 的那份）。256MiB 读取上限本身允许 200MB | `pdf.ts:35-37,521-529`、`lib.rs:223`；读代码 + 算术 |
| Rust 抽取（`inspect.rs`，一次开文档） | **实测（本次，`eval/extract/target/release/pagewise-eval-extract`）**：19 页真实语料 0.40s；300 页 1.33s / RSS 22.6MB；1,000 页 10.9s / RSS 57.2MB（1 页基线 0.01s / 11.4MB）。口径：harness 每页还跑一次 `page_text_items`（整篇重解析 + origins），**这些数是打开成本的上界**；纯 `open_document` 的耗时 **未量**——测量路径：harness 加 `--open-only` 模式，或前端计 `open_document_cmd` 的墙钟 | 实测（本次）；`inspect.rs:657-712,867-900` |
| 文本层首屏 | 120 页：firstTextLayer 724ms / firstRaster 611ms；30 页图 PDF 12,690ms（走 OCR 路径） | 实测（仓库自带）`.perf/report.json` |
| 大纲仲裁 | pdf.js 书签 ≤100（`pdf.ts:836`）、Rust 合成/标签大纲 ≤1,000（`inspect.rs:60`）；`usableOutline` 的耗时 **未量**（测量路径：perf-probe 加“1,000 条大纲”场景，或前端计 `usableOutline` 的墙钟） | 读代码 |
| 索引 bootstrap | `loadIndexedPages` → `restoreOcr` → `mergePageTextsOnReload` → `scheduleIndex`（顺带触发后台索引，见 §7.8）；BM25 索引在每次落页后的下次搜索全量重建，重建耗时 **未量**（测量路径：`node -e` 构造 1,000 条 `PageText` 调 `rankPages`，或 perf-probe 的搜索场景） | `load-document.ts:49`、`doc-cache.ts:69`、`ranked-search.ts:90`；读代码 |

### 7.2 页面渲染与驻留

| 项 | 数字 | 出处 |
|---|---:|---|
| 一页位图（fit 911px、dpr2、crisp；`getOutputScale`=2.5） | 2278×2947 = 6.7Mpx = **25.6MiB/页** | `pdf.ts:193,207`；实测换算（§1.3） |
| 位图缓存上界 | `MAX_CACHE_BYTES` 128MiB ≈ **5 页**（dpr1 6.4MiB/页 ≈20 页；performance 质量 dpr2 ≈16MiB/页 ≈8 页） | `pdf.ts:23,111`；算术 |
| 文本层缓存 | 40 页；密页 100KB+ → 数 MB 常驻 | `pdf.ts:118-119`；读代码 |
| 离屏 OCR/vision 画布 | 200dpi 14.3MiB、300dpi 32.1MiB/页，与阅读在同一个 webview 进程 | 换算（Letter RGBA）；§1.5 |
| 原文缓存 | 3 份 × 文件大小（无字节预算；`MAX_CACHE_BYTES` 不覆盖这笔账） | `pdf.ts:35-37` |
| 重绘浪费 | hurry 结束把**所有**挂载页重绘一次（`hurried` 在 effect deps 里）；settle 608ms 容得下，但它是纯浪费 | `PageSlot.tsx:115`；实测（仓库自带）settle 608ms |

### 7.3 扫描件 OCR（本地 tesseract.js）

| 一页 Letter | 画布（RGBA） | 识别 median / p90 | 落盘 JSON | 钱 |
|---|---:|---|---:|---:|
| 200dpi（英文/默认） | 14.3MiB | 2.64s / 4.83s（41 页） | **25.4KB**（本次复核：41 个缓存文件的中位数） | **$0** |
| 300dpi（中文） | 32.1MiB | 3.58s / 7.28s（10 页） | **38.8KB**（10 个文件的中位数） | **$0** |

- **资源**：`public/ocr` **10,678,666B / 7 文件 = 10.3MiB**（实测 `du -sb`；2×2.85MB wasm core + 2.95MB eng + 1.72MB chi_sim gz + worker）。`dist/ocr` 是同一份（10,678,666B），Tauri brotli 后 **+10.18MiB 进可执行文件**；`dist` 合计 17,844,553B（assets 3,615,688 + pdfjs 3,544,967 + ocr 10,678,666）——**不读扫描件的人也为它付安装与更新包**。
- **并发与看门狗**：2 slots（`ocr-service.ts:25`）、单页 90s 看门狗（`:31`）、结果 4s 批量落盘（`:33`）；Rust 修剪 48MB/文件、256MB/目录（`ocr_cache.rs:21,23`）。无网络。
- **缺页数上限（读代码）**：`scheduleIndex` 在 OCR 开且未给 cap 时置 null（`index-queue.ts:633-641`）→ 全部无文本页进队列：**300 页 ≈ 300×2.64s÷2 slots ≈ 6.6 分钟 CPU**（vision 有钱闸，OCR 没有）。取消＝丢排队项，**正在识别的页不取消**（`ocr-service.ts:189-196`，有意）。
- 每 slot 的 worker/WASM 首次初始化成本 **未量**（测量路径：perf 场景记首次 ready）。
- eval 记录仍是 14.0 的（`eval/README.md:39-51`），五版未重测——§4 #14 是这一项的门。

### 7.4 视觉回退（vision API）

| 项 | 今天 | 出处 / 标签 |
|---|---|---|
| 每页字节 | 1024/q0.80 = **61–176KB/页**（前稿实测；本次 `magick` 复核 5 页：62–185KB） | 实测 |
| 1568/q0.85 | **2.04–2.14×** 字节（本次复核：paper-en 185→379KB=2.04×、contract-zh 96→197KB=2.05×、另加两页 2.09×/2.14×）；代码注释说 3–4×（`pdf.ts:1089-1098`；§1.3 引作 `:1098-1100`，同一段） | 实测（本次） |
| 图像 token | gpt-4o-mini 的图像计法 base 2,833 + 5,667/512px tile（33.3×，上游）：一页 1024 边 ≈ **4 tiles ≈ 25.5k tokens**（宽/方形页可到 6 tiles ≈ 36.8k）→ 每页 **≈$0.0038–0.0060**（gpt-4o-mini）/ **$0.010–0.016**（gpt-4.1-mini），含 ~800 tokens 输出 | 上游公式 + 算术；app 不 tokenize，实际值在 `addDocumentVisionUsage`（`usage-tracker.ts:66`）里记着 |
| 相对成本 | 一页文本阅读 ≈1,500 tokens ≈ $0.0002 → **一页扫描 ≈ 17–24 页文本（≈20）** | 算术 |
| 预算 | 自动 sweep 默认 **20 页**（偏好，`preferences.ts:107`）→ ≈**$0.086/文档**；agent 单问 **10 页**（`preferences.ts:108`）→ ≈**$0.043/问**；模块兜底 50/20（`index-queue.ts:47,73`）。18.0 把两者砍半（50/20 → 20/10），是已经落地的省钱动作 | 读代码 + 算术 |
| figure | `read_figure` 走区域渲染 **1568/q0.85**（`read-figure.ts:73`），额度与扫描共用（`read-figure.ts:65`）；**重复读同一图 = 重新计费**（无去重） | 读代码 |
| index-cache 重计费 | 版本不匹配 → `[]`（`index-store.ts:99`），已付费的 vision 文本全丢重付：一份 20 页扫描 ≈ **$0.086**、50 页 ≈ **$0.21** | 读代码 + 算术 |

### 7.5 一次问答的 token 账（最重要的一环）

- **固定前缀 8,925B**（system 3,248 + tools 5,677；余量 75B/9,000B）≈ **2,232 tokens**（app 自己的估算器：4 ASCII 字符/token，`reading.ts:83-97`）→ **每一步重发一次**：20 步 = **44,640 tokens**（$0.0033 cached / $0.0067 uncached）、30 步 = 66,960。步数 = min(30, max(20, pages))（`agent.ts:70-77`）。
- 其余固定成本：每步输出 ≤8,000（`agent.ts:98`）、第 1 步 reasoning 低其后满（`agent.ts:108,133-139,322-323`）、整轮读取预算 **50,000 tokens**（`reading.ts:66`）、运行内压缩保留最近 16,000 字符全长（`compact-run-messages.ts:33`）、跨轮 12 轮 4 轮一滑（`history-window.ts:25,43`）。

| 一次工具结果 | 默认预算/上界 | tokens（EN / CJK，按 `estimateTokens`） |
|---|---|---|
| `read_pdf_page` | 6,000 字符默认（可 500–50,000） | 1,500 / ≤6,000 |
| `read_pdf_range` / `read_section` | 6,000 字符默认（section 同一读者） | 1,500 / ≤6,000 |
| `search_in_document` | 12 hits 默认；每 hit 前后 80 字符上下文 | ~600 |
| `document_outline` | previews 200 页 = 19,693 字符（代码里量的）；默认摘要小得多 | ≈4,900 |
| `read_figure` | 1 次 vision 调用 + 描述 | 图 ≈25.5k + 描述 |
| marks/links 附件 | mark 片段 120 字符 + note 全文 | 视读者数据 |

- **缓存断点**：`systemMessageFor`（`agent.ts:184-191`）只对 openai 声明，骑在 system 消息上（工具块之后、对话之前的最后一块固定字节）；SDK 序列化成 `prompt_cache_breakpoint`（`node_modules/@ai-sdk/openai/dist/index.js:480-495`），18.0 有测试钉住（`agent-cache-breakpoint.test.ts`：只对 OpenAI、且到达请求体）。18.0 起 `cachedInputTokens` 进用量行（`MessageAssistantFooter.tsx:513-519`；读取口径的修正记在 `message-metadata.ts:68-75`）。gpt-4o-mini 本身有自动前缀缓存（≥1,024 tokens，上游）；DeepSeek 报命中 tokens（v19 稿决定不解析，SDK 给的照旧显示）。
- **可命中比例**：每步的固定前缀 2,232 tokens 是 100% 可命中（字节不变由 digest 测试与注记 4 轮量化保证）；对**整轮**来说前缀占 input 的 **40–47%**（读得少时 44,640÷(44,640+读取) 接近 47%，读满预算时 ≈40%）——这是下界；每一步除最新一条结果外都与上一请求共享前缀，真实命中率 **未量**（每轮用量行记 `cachedInputTokens`；测量路径 = scripted 20 步 run 汇总）。

| 形态 | input tokens | output tokens | 钱 @gpt-4o-mini（cached 前缀 / 全价） |
|---|---|---:|---|
| 3 步短答（1 搜索 + 1 页） | ≈11k（前缀 6,696 + 结果 2.2k + 携带 2.2k） | ~1,000 | **$0.0018 / $0.0023** |
| 20 步整篇（读 12 页；典型） | ≈75k（前缀 44,640 + 读 18,000 + 携带 ≈12k） | ~3,000 | **$0.010 / $0.013** |
| 20 步读满预算 | ≈115k | ~3,000 | **$0.016 / $0.019** |
| 30 步上限 + 输出满载（最坏） | ≈120k | 240,000（30×8,000） | **≈$0.16**（其中输出 $0.144 占九成——输出是唯一没有整轮上限的一项） |

### 7.6 核对

| 项 | 今天 | 出处 |
|---|---|---|
| 本地三项（citation-check / quote-locate / quantities） | **0 tokens**（纯 webview 计算）；现成上界：定位 1,007/1,022（98.5%）、改坏引文误判 1/1,997、数字 179/179 零误报、138/138 错值全抓 | 读代码 + 实测（仓库自带）`eval/out` |
| chip 重开文档 | 每条历史答案的每颗 chip 挂载即查一次（结果按 path+引文缓存）——只花 CPU | `citation-check.ts:92-118` |
| `claim-review`（模型复核，手动触发） | 每条引用 **1 次** `generateObject`（顺序、可中止）：prompt = 段落 ≤3,000 字符 + 引文 + 句子 + ~1k 字符指令 ≈ **900–1,100 tokens 输入**；输出 ≤400 字符 ≈100–150 tokens → **≈$0.0002/条**，一条 8 颗引文的答案 ≈ **$0.0017** | `claim-review.ts:38-79,145-164`；算术 |
| 缓存与撤销 | verdict 只存**内存** Map（键 path+claim+quote，`claim-review.ts:41`），document scope 清（`document-scope.ts:62`）——不进磁盘，重开文档再按一次即重付；运行中关文档立即停止后续调用（16.0 B12） | 读代码 |

### 7.7 持久化与写放大

| 项 | 今天 | 出处 |
|---|---|---|
| 每次 flush = 整个文件重写 | 10,000 条标记 **4.48MB**（片段实测；本次同形复算 466B/条 → 4.66MB，同量级）；100 个会话 **16.5MB**；findings 到总上限（5,000 × 20,000 字符 body）**≈101MB**（片段记 104MB 含信封） | §1.10 + 本次复算 |
| 去抖 | 400ms（marks/findings）、800ms（index）、500ms（chats）、4s（OCR） | `mark-store.ts:42`、`index-store.ts:29`、`useWorkbench.ts:218`、`ocr-service.ts:33` |
| 写放大 | 一次编辑 = 整个文件序列化过 IPC + 落盘；读得重的一天（200 次 flush @10k marks）≈ **0.9GB 写**——SSD TBW 数百 TB 级，磨损可忽略；真正的代价是下一条 | 算术 |
| torn write | 插件吞解析错误 → 文件读成空表 → 下一次 save 覆盖：**丢的是该 store 里所有文档**（marks/findings/chats 都是读者自己的东西） | 读代码 `tauri-plugin-store-2.5.0/src/store.rs:225-229,306-314` |
| 最坏文件 | findings 101–104MB 在 400ms 去抖下反复整写；单次 flush 的序列化 + IPC 墙钟 **未量**（测量路径：`node -e` 造同形记录 + 计实际 `save()`） | 未量 |
| OCR 缓存磁盘 | Rust 修剪 48MB/文件、256MB/目录 → 上限 256MB | `ocr_cache.rs:21,23` |

### 7.8 后台 CPU

| 项 | 今天 | 出处 |
|---|---|---|
| 打开后的 sweep | OCR 开：**无页数上限**（300 页 ≈6.6 分钟 CPU，2 slots）；vision 开：≤20 页（默认） | `index-queue.ts:633-641`、`preferences.ts:107` |
| 并发 | vision 3（`index-queue.ts:48`）、OCR 2（`ocr-service.ts:25`）；`render-idle` 是单向门——显示屏先走，OCR/vision 排队等 | 读代码 |
| 定时器 | 空闲路径**没有** `setInterval`（全仓 grep 实测）；只有两处在“运行中”存在：footer 250ms ticker（live 且未完成，`MessageAssistantFooter.tsx:176`）、流式追字 12ms ticker（`useStreamingReveal.ts:68`）；另有流结束前的短轮询（`agent-stream-idle.ts:21,26`） | 实测 grep |
| 索引落页 | 每次落页重建 pages 数组并 notify → 下次搜索全量重建 BM25；sweep 期间的反复重建成本 **未量**（测量路径：perf-probe 打开 120 页扫描件的场景 + 搜索计时） | `doc-cache.ts:69`、`ranked-search.ts:90`；读代码 |
| 空闲 CPU | **未量**（测量路径：`npm run perf` 加 idle 场景、60s 采样；今天 4 场景只有 `answer.heapMb` 一个内存点） | 未量 |

### 7.9 三张总账

| 环节 | 钱 | CPU / 内存 | 磁盘 |
|---|---|---|---|
| 打开文档 | 0 | 抽取 1.33s/300 页、10.9s/1,000 页（上界）；首屏 611/724ms；200MB 文件 ≈400MB+ | 0 |
| 渲染驻留 | 0 | 25.6MiB/页、128MiB≈5 页；原文缓存 3 份 × 文件大小 | 0 |
| OCR | **0** | 2.64s/页；无上限 = 300 页 6.6 分钟 | 缓存 ≤256MB |
| vision | **$0.004–0.006/页**；20 页 sweep = $0.086 | 每页一次离屏渲染（主线程，render-idle 后） | index-cache |
| 问答 | 3 步 $0.002；20 步 $0.010–0.019；最坏 $0.16 | 前缀 2,232 tokens/步 | 0 |
| 核对 | 本地 0；claim-review $0.0002/条 | CPU | 0（只存内存） |
| 持久化 | 0 | 序列化过 IPC | 4.5MB–104MB/次 flush；torn write = 数据全丢 |
| 后台 | 0 | sweep 是最大一笔；空闲无定时器 | OCR 缓存 256MB |

### 7.10 优化：按回报排序

**1. sweep 的页数上限（CPU 最大一笔，钱 = 0）** — 今天：OCR sweep 无上限（`index-queue.ts:633-641`），300 页 ≈6.6 分钟 CPU；vision 那半已有 20 页预算（偏好）。改法：OCR 也给默认 **≤50 页/次**（与 `DEFAULT_AUTO_INDEX_PAGES` 同数；vision 仍按偏好 20），`All` 才整篇；取消保留“正在识别的页”。目标：**300 页 → ≤50 页 ≈66s（−83%）**。证明：`npx vitest run src/document/index-queue.test.ts`（新场景断言页数）+ 计时记录（§4 #25）。**删**：`cap=null` 分支与“没有上限”的语义。

**2. 视觉只有一条页面渲染路径（1024/q0.80）** — 今天：两条路径（`index-queue.ts:99-100,325-326`），OCR 读得差的页走 1568 = **2.0–2.2× 字节**（实测），宽页还会多 tile → 更多 tokens。改法：删第二条；`read_figure` 的区域渲染（`read-figure.ts:73`）是另一条路径，保留，但要用数说明。目标：每页 ≤176KB、页面图像 token 落在 4-tile 桶 ≈25.5k（**每页 ≤$0.006** @gpt-4o-mini）。证明：`magick` 复核方法 + `npx vitest run src/lib/pdf-render-scale.test.ts` + `getDocumentVisionUsage` 的每页 tokens（§4 #26）。**删**：`VISION_OCR_POOR_*` 常量与分支；注释里的“3–4×”改成实测的 2.0–2.2×。

**3. `index-cache.json` 的 `preserveNewer`（救援已付费文本）** — 今天：版本不匹配即 `return []`（`index-store.ts:99`），一份 20 页扫描 ≈ **$0.086** 重付（50 页 ≈$0.21）。改法：照搬 marks/findings 的迁移保护（`store-migrate.ts` 的 `newer` 分支）。目标：**重计费 = 0**。证明：`npx vitest run src/lib/index-store.test.ts src/lib/index-store-identity.test.ts` + `getVisionCallCount` 不涨（§4 #30）。**删**：`parsed.version !== VERSION → return []` 这一条。

**4. 前缀字节门进 prebuild，新规则必须付字节** — 今天：8,925B/9,000B 只在 `npm test` 里，`prebuild`（`package.json:20`）不含它；余量 75B。每减 1,000B ≈ −250 tokens/步（−5,000/20 步 run）；19.0 的减法示范 **−2,207B**（11,132→8,925，≈−11,040 tokens/20 步，−20%）。改法：门进 `prebuild` + `check:budget` 同批（§4 #19）；任何新规则附 before/after 与“删了哪句”。目标：**不涨（≤8,925B）**；下一次减法以 **8,600B** 为靶（−325B ≈ −1,600 tokens/20 步）。证明：`npx vitest run src/lib/agent-tool-prefix.test.ts` + digest 变化必须说明。**删/退役**：静默涨字节。

**5. 同一件东西只买一次：figure 也去重** — 今天：页文本有 `alreadyDelivered` 去重（7.3/16.0 的杠杆），**图没有**——同页同图第二次 `read_figure` = 又一次计费调用。改法：并入同一个 delivered-set 模式，键 `path#figure`，命中时回 `ALREADY_READ_NOTE` 式指针（描述就在上文）。目标：**第二次 0 次调用 / 0 tokens**（一次 ≈$0.004–0.011）。证明：`npx vitest run src/lib/agent-tools/read-tools-contract.test.ts` + scripted run 的 `getVisionCallCount`（§4 #28）。**删**：无（补一个洞）。

**6. 写放大先保命：原子写 + 记录每次 flush 的字节** — 今天：4.48MB / 16.5MB / 104MB 三档、整文件重写、非原子（torn write = 整个 store 丢）。改法：temp+rename（`annotate.rs` 已有先例）+ 三档 flush 字节与耗时入账。目标：**torn write 0 丢失；flush 字节不许涨**。证明：`npx vitest run src/lib/mark-store.test.ts src/lib/finding-store.test.ts`（字节断言）+ 新增杀进程测试（§4 #29）。**删**：非原子写；可选减法（另评）：findings 的 body 与索引分开存，最坏 104MB → 索引 ~5–10MB（本次复算：100 条无 body = 0.11MB）+ 按需 body。

**7. claim-review：一张票一次调用（N 条引用 → 1 次）** — 今天：逐条 1 次调用（`claim-review.ts:145-164`），每条都重付指令 ≈900–1,100 tokens 输入。改法：一次调用核 N 条（schema 数组），失败隔离保留。目标：**N=8 时输入 ≈−40%、调用 8→1**。证明：`npx vitest run src/lib/claim-review.test.ts` + scripted run 的用量行。**删**：逐条循环里的指令重复。

**8. `public/ocr` 的 10.3MB：删的时机挂在 route A 门后** — 今天：`dist` 17.8MB 里 10.7MB 是 OCR 资源，brotli 后 **+10.18MiB 进可执行文件**——每个读者为它付安装与更新包的体积。改法：route A 过门 → 删全量 + 撤 vision 20 页预算（§2.3 原案）；不过门 = 不动。目标：**dist 17.8MB → ~7.2MB（−60%）、可执行 −10.18MiB**。证明：`du -sb public/ocr` = 0 + 构建断言无 OCR 资源 + `check-bundle`（§4 #17）；顺手把 `copy-ocr-assets.mjs:30-33` 的“缺资源也 exit 0”修成非零。**删**：2×2.85MB wasm + 4.67MB 语言包 + worker。

**9. 机械步的输出上限（先量后切）** — 今天：每步 ≤8,000 output、30 步 = 最坏 240,000 tokens ≈ **$0.144**（输出单价是输入的 4×），是账里唯一没有整轮上限的一项。改法：先量 scripted/live run 的每步 outputTokens（用量行已有）；机械步（工具调用）给 1,500–2,000 的盖，合成步保留 8,000。目标：**最坏 240k → ~55k output tokens（−77%）、$0.144 → ~$0.033**。证明：`npm run eval:live` 的 outputTokens 分布 + `npx vitest run src/lib/agent-run-steps.test.ts`。**删/退役**：没有要删的代码；退役“所有步骤共用一个 `MAX_OUTPUT_TOKENS` 常量”的约定（`agent.ts:98` 拆成机械/合成两档）；门是“合成答不缩短”，量出来再切。

*九项合计的可赎回量：CPU ≈ −5.5 分钟/300 页扫描（#1）；受影响页的视觉字节 −50%（#2）、重复读图 −100%（#5）；已付费文本不再重付（#3）；前缀与输出的账按字节/步数明码标价（#4/#9）；读者的数据不再有“整 store 丢”这一档（#6）；安装包 −10.7MB 挂在引擎门后（#8）。*

## 8. 验证记录

**本次在这个 orb 里执行的**

- 四份审计片段全文（01–04）；本稿的 `file:line` 取自它们并在本 checkout 上抽查复核（逾 40 处；勘正三处：`MIN_WORD_CONFIDENCE` 在 `ocr-result.ts:67`（片段作 `:57`）、`ocrDpiFor` 在 `:76`（片段作 `:66`）；`answer-levels.ts` 的去重口径在 `:14-27`（片段作 `:211-224`，该文件只有 27 行））。
- `npm outdated --json`：5 个包落后（见 §3 表）；`npm view` 13 个关键包核对其余为 latest。
- crates.io API：tauri 2.12.3 / pdf-inspector 1.25.2 / lopdf 0.45.0 / keyring 4.2.0 / 五个插件 / ocrs 0.13.1 / rten 0.27.0 / ocr-rs 2.4.1 / mnn-rs 0.1.7 全部核对；`rust-paddle-ocr` 不存在。
- `curl` 上游核对：ocrs README 的 Latin-only 原句；模型下载地址 `curl -sI`（2,499,479B + 9,713,177B，Last-Modified 2026-09-13）；docs.rs 0.13.1 的 `TextChar` 只有 `char`/`rect` 两个字段（无置信度）。
- `npx vitest run src/lib/agent-tool-prefix.test.ts`：通过；临时测量脚本复测前缀 **8,925B**（system 3,248 + tools 5,677，每工具的 desc/schema 字节一并量过），脚本已删除，`git status` 干净；§7 工作前再跑一次仍通过（digest 未动）。
- `.perf/report.json` 逐字读（342ms/30 hits、463ms/13、653ms/1,017、12,690ms、611/724ms、608ms、221ms）。
- `eval/out/*.json` 复核：`location.json` 1,022/1,007；`false-positives.json` 1,997/1；`numbers.json` 179/0/138/138；OCR ms 本次重算（200dpi 41 页 2.64s/4.99s、300dpi 10 页 3.32s/7.28s；片段记 2.64/4.83 与 3.58/7.28——分位口径差异，结论不变；本稿采用片段口径并在此记录重算值）。
- `du -sb public/ocr` = 10,678,666B / 7 文件；`magick` 重编码复核 2.04× / 2.05×。
- `complexity-budget.mjs`、`ci.yml`、`perf-probe.mjs`、`css-hygiene.test.mjs` 等的关键段阅读与 grep 交叉（`check:budget` 的命中面、`? 2 : 2`、类名计数、CI job 列表）。
- **§7 的成本测量（本次新增）**：`eval/extract/target/release/pagewise-eval-extract` 计时（本机）：19 页真实语料 0.40s；合成 300 页 1.33s / RSS 22.6MB；合成 1,000 页 10.9s / RSS 57.2MB（1 页基线 0.01s / 11.4MB）；口径（harness 每页含 `page_text_items` 的整篇重解析，是打开成本的**上界**）写进 §7.1，合成 PDF 与生成脚本是 `/tmp` 临时文件、已删除。
- `magick` 重编码复核（5 页）：1024/q0.80 = 62–185KB、1568/q0.85 = 132–379KB，比值 **2.04–2.14×**（§7.4）。
- OCR 缓存 JSON 中位数复核（`eval/out/ocr`、`eval/out/ocr-300`）：200dpi 41 文件 **25.4KB**、300dpi 10 文件 **38.8KB**（与 §1.5 表一致）。
- `du -sb`：`public/ocr` **10,678,666B / 7 文件**；`dist` **17,844,553B**（assets 3,615,688 / pdfjs 3,544,967 / ocr 10,678,666）。
- 持久化同形复算（`node -e`）：10,000 条标记 pretty **466B/条 → 4.66MB**（片段记 4.48MB，同量级）；findings 5,000 × 20,000 字符 body ≈ **101MB**（片段记 104MB 含信封）；findings 无 body 时 100 条 = 0.11MB（→ 上限 ≈5.4MB）。
- 价格与图像 token 计法：gpt-4o-mini / gpt-4.1-mini 的 input/cached/output 单价本次从 `developers.openai.com/api/docs/pricing` 读取（上游，2026-10-14）；图像 33.3× 计法（base 2,833 + 5,667/512px tile）为 上游 公式，app 侧实际值以 `usage-tracker.ts:66` 的逐文档记录为准。
- `git status`：本稿完成后只有一份未跟踪文件（本文件）。

**读代码（未运行）**：§1 列出的全部模块与出处；四份片段的其余数字沿用其口径（与本稿同一 commit）。

**未验证**：① 没有跑 build/dev/Playwright（按任务约束）——"页宽两态、列开销、设置行 DOM 数"都还不是运行态数字，它们在 §4；② `npm run check:budget` 本次没跑（片段跑过 8/8 绿；本次只确认它不在 CI）；③ `ui:inventory`/`perf`/`ui:shots` 未实跑；④ OCR 的 14.0 数字未重测（本次只做重算）；⑤ ocrs/Paddle 的识别率、内存、许可证与构建可行性（需要 spike）；⑥ 1,000 页**纯** Rust 抽取耗时（§7.1 已给含 positions 的上界）、1,000 条大纲挂载成本、200MB 文件在真 IPC 下的常驻、空闲 CPU 与每步 outputTokens 的基线；⑦ macOS/Windows 真机。
