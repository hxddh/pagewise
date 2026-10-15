# v21 方向评估：核对要能离开这一次会话，扫描表格配得上同样的问题

*2026-10-15。基线 main `0c43505`、`VERSION 20.0.0`。*

*口径：**实测**＝在这个 orb 里量出来的（`node`/`npx vitest`/`npm outdated`/`du`/crates.io API/`curl`）；**读代码**＝`file:line`；**上游**＝本次 `curl` 或 crates.io 读到的事实；**实测（仓库自带）**＝已提交的测量（`eval/README.md`、`complexity.snapshot.json`、`.perf` 若引用）。不确信的写**未量**。*

*本稿合并自四份逐模块审计片段（阅读面与文档管道、答案列与 agent、数据/持久化/Rust、chrome/门/i18n/文档）。片段是工作稿，合并后删除。§1 按模块重排，保留 `file:line` 与数字。父线程抽查了会改结论的几处，并改正一处：空白页不再被说成预算用尽（见 §1.7）。*

## 0. 结论

1. **20.0 把上一稿的三句话做完了。** 答案住在纸边（面板关时 240px 列，开时收回点）；每一句有状态（verified / check / notFound / noQuote / unchecked，加上 pending）；扫描件的自动 sweep 有 50 页帽，视觉页面只走 1024/q0.80，`index-cache` 版本不匹配不再直接当空读。结构账的大头也还了：store 原子写、`store:default` 删除、finding body 旁路、密钥镜像有出口、`check:budget` 进了 `prebuild` 和 `windows-checks`。v21 不是再做一遍这些。
2. **20.0 没做完的是「核对能不能过夜」。** 句级状态、页边列、CSV/brief 里的模型列，全部活在这一次会话里。`claim-review` 仍是逐条一次 `generateObject`，结果只在内存 Map（`src/lib/claim-review.ts:41,145-163`）；关文档即清（`src/lib/document-scope.ts:65`）。重开之后导出里的模型列是空的——读者看到的是「没复核」，不是「复核没留下」。无标记的句子有状态，但那个状态不进页边（`src/lib/page-citations.ts:88-91` 只收集带 citation 的页）。图的描述不能被核对（`src/lib/agent.ts:158` 要求无引号标记，句子落 `noQuote`）。
3. **扫描件的下一道门不是换引擎，是表格。** 引擎决定已经做过，而且有数：维持 tesseract.js（`docs/reviews/v20-ocr-spike.md`）。中文散文 87.8%（79/90）过了 ≥85% 的门，差 2.8 点。**表格单元格 125/182 = 68.7%，两栏 124/159 = 78.0%，都只报告、不设门**（`eval/ocr.eval.ts:13` 写明 table 是 reported）。spike 在有界 7 页上看到 ocr-rs 的中文表格页 27/27、两栏英文 38/94（差于现状 67/94），并写明：若产品把门扩到扫描表格，换引擎从「可选」变成「唯一有证据的路径」。那扇门今天仍然关着，代码里也没有区域 crop 路径（`src/lib/ocr/ocr-service.ts` 只 `recognizeCanvas` 整页）。
4. **还没收口的结构账，比新表面值钱。** 三笔：① `store_write_cmd` 不看旧文件（`src-tauri/src/store_io.rs:127`），body 走 `writeStoreFile` 直写（`src/lib/finding-bodies.ts:121`）——「解析不了就永不覆盖」只覆盖 TS 的 `save()`；② OCR 缓存与注释导出是 temp+rename、没有 `sync_all`（`src-tauri/src/ocr_cache.rs:86-90`、`src-tauri/src/annotate.rs:265-272`），而 `docs/SECURITY.md:23` 把「每个 JSON」写成 temp+fsync+rename；③ `preserveNewer` 会把读不懂的 blob 收到 `index.newer`，但本树没有读者，下一次 `writeDocs` 把主键写成 v1（`src/lib/index-store.ts:174-189`）——降级再升级，已付费文本仍会丢。另有一条构建洞：`scripts/copy-ocr-assets.mjs:30-33` 在 tesseract.js 缺席时 `exit 0`。
5. **依赖：v21 不需要新依赖**（实测）。前端落后的全是补丁（react 19.3.0→19.3.1、ai 7.0.140→7.0.141、Tauri API 2.12.3→2.12.4 等 12 个）；Rust 侧 tauri lock 2.12.3，crates.io 稳定版最新 2.12.4，pdf-inspector 1.25.2 / lopdf 0.45.0 / keyring 4.2.0 已是最新稳定。`ocrs` 0.13.1 仍是 Latin-only，不进依赖。`ocr-rs` 2.4.1 仍是唯一像引擎的候选，只在表格门被采纳、且同一 harness 过门之后才进计划。
6. **数值目标见 §4。** 主决策数是两条：模型复核要么一次调用核 N 条并落盘，要么明确不进导出；表格要么进门（≥80% located，与 corpus 同级），要么在 `eval/README.md` 写明「不承诺」。
7. **不做**（v19/v20 的结论照旧，加上本轮片段里与专注冲突的提案）：多文档、金额、缓存命中解析、分块重组、首屏包、双引擎 OCR、`ocrs` 这条具体路线、运行中成本条、⌘F 下一个命中、「每句必须带标记」的提示词硬规则、模型 verdict 自动升级。页边列不在面板开着时占宽——20.0 已经按这个决策做了，v21 不翻案。
8. **一句话的 v21**：*核对要能离开这一次会话；扫描表格要么进门，要么明说不承诺；挡住这两件事的写路径先收口。*

## 1. 现状：20.0 落地之后还在的东西

### 1.1 阅读面

几何已经是 20.0 的形状（读代码）：左 24（`PageScroller.tsx:18`）、面板开时右 24（`:23`）、面板关时列 240、实际右保留 188（`:32,47`，dock 占掉 52）。页间距 16（`page-layout.ts:33`；v20 评审记的 33 已改）。fit 用 computed `paddingRight`，所以过渡中的中间宽度会进 `fitWidthScale`（`PageScroller.tsx:110-113`）。

v20 的三个 fit-width 接缝都落地了：`fitWidthScale` 吃不对称 padding（`page-layout.ts:295-311`）；`buildScaleKey` 是 `fit:${qWidth}:${qScale}:${qReserve}`（`pdf.ts:163` 起的注释，键在同函数）；scale 变化按页内比例锚定（`page-layout.ts:241-288`，`PageScroller.tsx:249-295`）。测试钉的是终态（`PageScroller.test.tsx:326-400`，误差 <24px），不是过渡帧。

新的接缝，都是读代码、运行态未量：

- 量子把小于 0.032 的 scale 变化吞掉（`pdf.ts:158,192`）。列开关约 20%，会 miss；过渡中间帧若落在同一档，旧位图按自己的像素宽贴回（`pdf.ts:171-172` 自己写的失败模式），槽 `overflow: hidden`（`preview.css:483`）裁掉多余。
- `scrollShiftForScale` 把比例夹在 [−1, 2]（`page-layout.ts:278`）。读过页底再往下超过一页高，锚定不再是「同一处」。
- fit 仍按迄今最宽页（`page-layout.ts:297-299`）。中途出现横向页仍整列重排一次；20.0 补的是滚动，不是重排本身。
- 页码画在槽外：`.pdf-page-number { bottom: -18px }`（`preview.css:492-495`）对 `overflow: hidden`（`:483`）。读代码会被裁。浏览器里是否真裁，**未量**。
- hurry 结束仍重绘全部挂载页（`PageSlot.tsx:121` 的 effect deps）。v20 记的纯浪费还在。

### 1.2 页边列

列在面板关时占宽，开时收成点。这是 v20 的决策，实现按此做了（`App.tsx:493` `marginColumn={!s.assistant.open}`）。

进列的：该页答案里带 citation 的句子、findings、marks，各最多 12，碰撞下推，被推开的卡片画 tie（20.0 后两轮修过车道和墨色）。不进列的：

- **无标记的句子。** `unchecked` 在 `answer-sentences.ts:341-346` 产生，`page-citations.ts:88-91` 只收集 `citation.pages`。纸边对「没说依据」仍是沉默——状态在答案脚下的那一行，不在它该在的页旁边。一句不引任何页的话确实没有页可靠；一句引了页但邻句没有标记，邻句不会出现在那一页的列里。
- 超过 12 的，以及划掉或被取代的 findings。这些留在记录里，是有意的帽。
- 面板开着时整列收成点。长答案和记录仍是面板的事。

`MarkNote` 仍是第二套表达（预览底部的注卡片）。v20 写过「有了列之后不再成立」；列落地了，卡片还在。六层叠加加页边，各自一次 `getPageGeometry`，函数本身无缓存（`pdf.ts:1332-1340`；调用点含 `MarkLayer.tsx:45`、`FindingLayer.tsx:74`、`LinkLayer.tsx:54`、`AnnotationLayer.tsx:46`、`SearchHighlight.tsx:32`、`CitationHighlight.tsx:27`、`PageGutter.tsx:204`）。

### 1.3 缓存与打开

字节缓存按条数，不按字节：`pdfBytesCache` 留 3 份（`pdf.ts:35-37`），`loadPdfDocumentOnce` 再 `data.slice()` 一份交给 worker（`:553` 一带）。200MB 扫描件过 Rust `MAX_READ_BYTES` 256MiB（`src-tauri/src/lib.rs:224`）之后，主线程一份加 worker 一份 ≈400MB+。这是算术上界，不是测到的常驻。**未量**：真 IPC 下的 RSS。

`VISION_OCR_POOR` 与 1568 的页面路径已删。`rg '1_568|1568' src` 的命中只剩 `read-figure.ts:38` 的 `FIGURE_MAX_EDGE`。v20 要的「页面一条路径」成立。

`public/ocr` 目录本次不在（gitignore，未跑 `copy-ocr-assets`）。脚本要拷的 7 个源文件在 `node_modules` 里，`du -sb` 合计 wasm 两份 2,857,601 + 2,855,361、eng 2,952,873、chi_sim 1,718,768、worker 111,307。这是源，不是打包体积，不能拿去对 v20 的 10,678,666。要量打包：`node scripts/copy-ocr-assets.mjs && du -sb public/ocr`。

### 1.4 索引队列

自动 sweep 的 50 页帽在（`DEFAULT_AUTO_INDEX_PAGES`，`index-queue.ts` 的 `sweepWindow`）。停在未读完时 `readingProgress` 返回 `stopped`，ReadingLine 画出「已读 n/N，剩 m 页按需」（`ReadingLine.tsx:38`）。这是 v20 #15 和 #18，已落地。

帽有旁路（读代码）：停在一页超过 settle 会 `indexPageInBackground`（`PreviewPane.tsx:234-246`），不占 `sweepWindow`；`reindexDocument` 把 `visionBudget` 设成 `null`（`index-queue.ts:791` 一带）。「Read pages with no text」和 Reindex 是读者点名的动作，changelog 说它们报页数、按读者同意的量读——旁路里逐页滚动触发的那条不是。语言切换不再覆盖另一分区（16.0 的分区还在）。

`doc-cache` 每次落页重建 pages 数组；`ranked-search` 的 BM25 按 pages 身份缓存，落页后的下次搜索全量重建。重建耗时 **未量**。

### 1.5 OCR

引擎决定维持（spike，2026-10-15，基线 `d534553`）。门数在 `eval/README.md:39-66`，日期和 commit 都有了（2026-10-15，`cdd9684`），不再是 14.0 的「Median 2.2 s」：

| 面 | 记录 | 门 |
|---|---:|---|
| 英文散文 | 229/231 = 99.1% | ≥95% 过 |
| 中文散文 | 79/90 = 87.8% | ≥85% 过，差 2.8 点 |
| 生成语料 | 557/662 = 84.1% | ≥80% 过 |
| 改坏引文误定位 | 1/1,997 = 0.05% | ≤1% 过 |
| 两栏 | 124/159 = 78.0% | 无门 |
| 表格单元格 | 125/182 = 68.7% | 无门 |
| 200 dpi median / p90 | 2.49 s / 4.90 s | median ≤5 s 过 |
| 300 dpi median / p90 | 3.46 s / 4.17 s | 同 |

识别路径自 14.0 未改，所以准确率是重测而不是新算法。区域/表格 crop 在 tesseract 侧不存在：`ocr-service.ts` 的 `recognize` 只拿整页 canvas。spike 把这件事标成路 B 唯一有希望、且 **未量** 的项。ocr-rs 的完整门数（51 页 / 662 引文、词级 run 映射、FP、median）仍 **未量**；有界 7 页不能当门。

### 1.6 搜索与导航

一个 ⌘F，文档段加会话段。关闭即丢结果，没有「下一个命中」。v20 把它放进不做，本稿维持。

两套规则还在：⌘F 是折叠后的子串（`document-search.ts:54-71`），agent 路径精确匹配为空才走 BM25（`ranked-search.ts`）。跨行短语精确命中失败。v20 的「33/101 行不以句末标点结尾」本次 **未量**。

大纲逐条挂载（`OutlineSidebar.tsx:62`），合成大纲上限 1,000（`inspect.rs:60`）。缩略图是窗口化的（`ThumbnailSidebar.tsx:149`）。1,000 行 DOM 的挂载耗时 **未量**。搜索高亮按行 run，跨行短语不亮——20.0 没动这条，注释里写着。

### 1.7 Agent 循环与工具

固定前缀本次复测 **8,925 B / 9,000 B**（system 3,248 + 八个工具的 wire JSON 5,677；`npx vitest` 跑测试同一条转换，8 个工具）。余量 75 B。测试只断言 ≤9,000，不把 8,925 写进断言；digest 八条未动。任何新规则先从这 75 B 里出。

| 项 | 今天 | 位置 |
|---|---|---|
| 步数 | min(30, max(20, pages)) | `agent.ts:70-77`、`:389` |
| 每步输出 | **一个** `MAX_OUTPUT_TOKENS = 8_000`，机械步与合成步共用 | `agent.ts:98,392` |
| 超时 | 首块 90s / 块间 45s / 整轮 45min / 单工具 75s | `agent-timeouts.ts` |
| 扫描额度 | 每题与看图共用 | `index-queue.ts` |
| 缓存断点 | 只对 openai 声明 | `agent.ts` |
| reasoning | 第一步低、其后满；注释自认没量过 | `agent.ts:121-131` |
| 停止条件 | `AGENT_STOP_WHEN` 常量 20，又被 `prepareCall` 的 `stopWhen` 覆盖 | `agent.ts:92,389` |

空白页的旧缺陷**不再成立**，写在这里以免下一轮再报。v20 评审说 `affordableChars("") === 0` 会让空页带上 `BUDGET_NOTE`。今天 `estimateTokens("") === 0` 时函数返回 `text.length`（`reading.ts:97-102`），但 `readPageRange` 在量 room 之前就把空正文写出去（`:610-616`），`room <= 0` 的分支走不到。空页是 `--- Page N ---` 加一个空行，循环继续，不标预算用尽。**缺的是一句「这页没有字」**，`read_pdf_page` 同样（`read-page.ts:140-166`）。这是说明，不是错误的账。

`read_figure` 同轮同图第二次返回指针、0 次 vision 调用（`read-figure.ts:66-73`）。额度用尽仍复用扫描那句文案（`:78-79`）——在要图，却被告知这页没有抽取文本。图的描述不能当引文：提示只允许无引号的 `〔p12〕`（`agent.ts:158`），句子落 `noQuote`（`answer-sentences.ts:293`）。

NUL（`\x00`）仍是两处 map 的 key 分隔符（`agent-loop-guards.ts:35`、`page-links.ts:38`）。`rg` 默认把这两个文件当二进制。不是新的，也不是本轮要修的产品行为。

### 1.8 句级核对：状态有了，过夜没有

五态加上 pending（`answer-sentences.ts:65`）：`verified` / `check` / `notFound` / `noQuote` / `unchecked` / `pending`。最差的标记决定句子（`:38-41`），所以脚下那一行不能在芯片显示失败时说 verified。无标记的句子是 `unchecked`，永不 verified（`:287`）。短引文有 `tooShort`（`citation-check.ts:217`）。直播 tally 不再被 `!live` 挡住（`MessageAssistantFooter.tsx:232-235`）。Keep 读同一张句子表。这些是 20.0 的交付，不要再写成开放项。

`verified` 的意思没有变，也不该变：引文在页上，且句中数字在那段里。本地不能判蕴含。`contradicts` 只降不升（`trust-level.ts:51`）。

模型复核没跟上这张表：

- 仍是逐条一次 `generateObject`（`claim-review.ts:145-163`），N 条引用 = N 次调用，每条重付指令。
- 结果只在内存 Map（`:41`），document scope 清掉（`document-scope.ts:65`）。不落盘。
- 当次会话里按过复核，CSV 和 brief 会带 `cite.review.*`（`answer-tables.ts:168-172`、`export-brief.ts:115-119`）——标签是对的，寿命是错的。重开文档再导出，模型列为空。

无标记句的数字可以对照答案自己已经定位的引文（`numbersInEvidence`，`answer-sentences.ts:305`），记在句子上，eval 有列。它不是一次核对，也不进页边。

### 1.9 记录与出口

finding body 已旁路：`finding-bodies/<id>.json`，索引里剥离（`finding-bodies.ts`）。一次编辑不再重写所有 body。索引本身仍整文件重写（`finding-store.ts` 的 flush）。去抖 1.5s（20.0 从 400ms 拉开）。

本次 `node -e` 同形夹具（pretty，`JSON.stringify(obj, null, 2) + "\n"`）：

| 夹具 | 字节 |
|---|---:|
| 10,000 marks | 4,316,658 |
| 5,000 findings，无 body | 2,004,204 |
| 一个 20,000 字符的 body 文件 | 20,002 |
| 5,000 个这样的 body | 100,010,000 |

changelog 写的「500 条满 body、flush 216KB、占 2.1%」本次没有复跑那个测试，不引用为本次实测。测试自己的门是「这一次 flush < 索引加 body 的 3%」——卡住的是「不要把 body 写回去」，不是「索引不许再涨」。

三套 key 还在：引文 `pages+quote`、复核 `path+claim+quote`、记录 `id`。聊天与记录仍是两个文件，写入失败不互相回滚。标记不写回 PDF，只能随导出离开。

### 1.10 持久化：原子写盖住了主路径，没盖住边

八个 JSON store 的 `save()` 走 `store_write_cmd`：临时文件、`sync_all`、rename、目录 fsync（`store_io.rs:78-104`）。`tauri-plugin-store` 不在 `Cargo.toml` 里，`store:default` 不在 capability 里。这两条 v20 的债还清了。

没盖住的：

- **「解析不了就永不覆盖」只在 TS 的 `save()`。** `store_write_cmd` 不读旧文件（`store_io.rs:127`）。finding body 用 `writeStoreFile` 直写（`finding-bodies.ts:121`）。撕坏的 sidecar 在下一次编辑时会被盖掉。
- **OCR 缓存与注释导出没有 fsync。** `ocr_cache.rs:86-90` 是 `fs::write` + `rename`；`annotate.rs:265-272` 写 `.pdf.partial` 再 rename，无 `sync_all`。`SECURITY.md:23` 的「每个 JSON」比代码宽。
- **窗口状态**仍是 `tauri-plugin-window-state` 2.5.0 的 `fs::write`。丢的是窗口几何，不是读者的记录。不进 v21 的必做。
- **`preserveNewer` 本树不读回来。** 版本更新时 blob 进 `index.newer`（`index-store.ts:174-179`），`readDocs` 当空，下一次 `writeDocs` 把主键写成当前 `VERSION`（`:185-189`）。当前进程继续索引，等于重付。美元数 **未量**；路径是读代码。
- **关文档不清两张账。** `index-store` 的 `pending`（`:256`）不在 `forgetIndexIdentity`（`:203`）里——800ms 去抖未到就关文档，已付费页文本留在 map 里直到 flush。`pageIndexFailure`（`index-queue.ts:265`）不在 `cancelIndex`（`:756`）里。一条失败字符串不是串台，但五十篇之后 size 不回到 1。`usage-tracker` 和 `identityByPath` 已登记，不要再写成开放项。

密钥镜像的出口在：打开 Settings 时再交给 keychain，读回成功才从磁盘删（20.0，`settings.ts`）。`settings.ts` 自己的锁与 `json-store` 仍是两份同构代码。不是数据丢失，是两处要一起改。

### 1.11 Rust、安全、打包

22 个命令（`lib.rs:445-467`）。路径白名单、写路径拒绝 `..`、leaf symlink 拒绝、导出不覆盖源文件，这些 20.0 没动，也没坏。指纹仍是 FNV-1a64，注释写明不是签名。`extract_region` 仍每次读整文件加全页 positions——拖选贵，是已知的。

CSP 仍要 `wasm-unsafe-eval`（tesseract 与 pdf.js 的 wasm）。`check-secrets.mjs` 仍只看 `git ls-files`；`public/ocr`、`public/pdfjs`、`dist` 在 gitignore 里，误写进的凭据扫不到。这是 v20 点过、没改的。

`copy-ocr-assets.mjs:30-33`：tesseract.js 不在 `node_modules` 时警告并 `exit 0`。缺单个文件才 `exit 1`。整包可以在没有 OCR 资源时构建成功。v20 #17 的「构建断言无 OCR 资源」没落地，因为引擎没换；「缺资源应失败」这条与换不换引擎无关。

未 notarize。`docs/RELEASE.md` 与 README 的安装说明仍是 `xattr` 那一条。不进 v21 的产品面；它是发布链的事，单独说。

### 1.12 Chrome 与门

`check:budget` 在 `prebuild`（`package.json:26`）和 `ci.yml:82`。本次 `node scripts/complexity-budget.mjs` 8/8 绿：

| 数 | 现在 | 口径 |
|---|---:|---|
| faces | 15 | 手写数组（`complexity-budget.mjs:56-74`） |
| tabs | 7 | 侧栏 union + 面板参数 + 设置 TABS |
| commands | 12 | `id:` 计数 |
| scanKnobs | 2 | 两个 i18n key |
| settingsRows | 7 | `<PillRow` / `settings-row-toggle` / `ui-field` |
| copyKeys | 482 | en 目录递归；`check-i18n-keys.mjs` 本次退出 0 |
| cssLines | 6,179 | 每文件 `split("\n")` +1 |
| srcLines | 41,036 | 非测试 .ts/.tsx/.css |

`tabs` 的 `? 2 : 2` 不在了。`settingsRows` 仍漏一行读者看得见的：模型行（`AssistantSettings.tsx:230-244`）是 `settings-row` 加一个按钮，不在三个选择器里。`faces` 仍是手写数组——删一个表面不删数组项，数字不动。v20 #20 要的「与 DOM 同口径」只做了一半。

`vitest.config.ts` 仍只有 `environment: "node"`，没有 include。仓库根的 `*.test.ts` 会进套件。本次测前缀时就用过这条（`.audit-tmp/`，已删）。

其它漂移，都是读代码：

- `README.md:65` 写「nine scenarios, twenty budgets」。`perf-probe.mjs` 是 4 个场景函数、21 条 `check()`（`:370` 起、`:743-764`）。
- `en.json:20,25-27` 与 `zh-CN.json` 同号仍写 Settings → AI Provider / 设置 → AI 提供商。该 tab 在 18.0 删除。`docs/RELEASE.md:31` 的核对清单同样。
- 单页文档的页码控件 `return null`（`WorkspaceHeader.tsx:124`），header 中间空着。
- Zen：Esc 只关浮层，不离开 Zen（`useAppCommands.ts:190` 一带）；⌘K 仍能开调色板（`App.tsx:338`）。
- `--z-menu` 已经有引用（`AnchoredMenu.tsx:108`）。`--topbar-h` 本次未再证死活。`SettingsSkeleton` 是否仍零引用，片段说是，父线程未再打开文件——标 **未复核**。
- `!important` 与 `outline: none` 的「写了理由就放行」还在。css-hygiene 的几何断言仍是读源码文本，不是布局引擎。

i18n 482 键，两边对齐，每个键有引用（`check-i18n-keys.mjs` 本次绿）。v20 #24 写的「≤442」没有发生——20.0 自己加了页边和停态的键，把目标冲掉了。不要在 v21 把「减到 442」再写一次；要减的是指向死界面的那几句，不是键的个数。

## 2. v21 的两个支点

### 2.1 支点 A · 核对要能离开这一次会话

**一句话**：读者按过的模型复核、以及「这句没被核对」这件事，在重开文档之后仍然在——导出里、页边里，用 20.0 已经有的词。

**为什么**

- 20.0 把状态做出来了，寿命停在内存。一次 8 条引用的复核 ≈ 8 次调用；关文档再打开，导出说没复核过。这不是文案问题，是状态没有主人。
- 页边列是 20.0 承认的位置。无标记句的状态已经算出来了，只是 `page-citations` 不收集它。让它进列，不需要新组件；不让它进列，就要在答案脚下那一行之外不再暗示「这一页的话都在边上」。
- 图是扫描件里最贵的一次调用（区域 1568，与扫描额度共用），而它的描述今天不能被核对。要么给描述一个可定位的去处（描述不是页上的 run，本地只能标 `noQuote`，这已经是诚实的），要么在额度用尽和「无引文」两处停止复用扫描文案。

**做什么**

1. **复核一次调用核 N 条，结果落盘。** schema 用数组；一条失败不废掉其余。键沿用 `path + claim + quote`。落盘走现有原子写，挂在 document scope 的 flush 上，而不是新文件格式的发明——若放进 findings 会把「模型的话」和「读者留下的记录」混成一类，不要。单独一个小 store，或挂在 index 文档条目上，二选一；本稿倾向单独小 store，因为 index 的版本故事已经够复杂（§1.10）。
2. **重开之后 CSV/brief 的模型列与芯片读同一份。** 没有落盘记录时列为空，这是对的；有记录时必须出现，并继续只通过 `cite.review.*`。`contradicts` 只降不升，不变。
3. **无标记句：要么进它所在答案引用过的页的列（状态就是 unchecked），要么写明不进。** 进的帽仍是 12。不进的话，删掉「纸边是答案的家」这句话在无标记句上的暗示——脚下行已经说了。本稿倾向进，因为沉默是 20.0 故意换成一个词的东西，不该在纸边换回沉默。
4. **空页给一句「这页没有字」。** `readPageRange` 与 `read_pdf_page`。不是新工具，是现有返回值补 `note`。不要再标 `budgetExceeded`。
5. **提示词不加新规则。** 前缀 8,925/9,000。图的「不可核对」用本地状态表达，不写进 system。

**删/退役**

- 逐条 `generateObject` 循环里重复的指令。
- 「复核结果不过夜」这件事。手动触发保留——本地仍不能判蕴含，自动跑每一句是账单，不是核对。
- `read_figure` 额度用尽时的 `SCAN_LIMIT_NOTE` 复用。换成一句说的是图，不是页文本。

### 2.2 支点 B · 扫描表格要么进门，要么明说不承诺

**一句话**：68.7% 的表格单元格定位率今天没有门。v21 二选一：把表格放进与语料同级的门，并为此做区域识别或换引擎的 spike；或者在 `eval/README.md` 和读者能看见的地方写明扫描表格不在承诺里。不允许继续「报告一行、产品不说」。

**为什么**

- 散文门是紧的（中文差 2.8 点），表格没有门，所以引擎可以「全过」而一张扫描发票上的格子有三分之一找不到。读者问的常常就是格子。
- spike 已经写了反转条件：若产品把门扩到扫描表格，ocr-rs 的表格页证据（有界 27/27）把换引擎从可选变成唯一有证据的路径；两栏英文同时变差（38/94 vs 67/94），所以不能只看表格就换。完整门数没量过。没量过就不声称达到。
- 不换引擎的那条路（区域 crop）在代码里不存在。`extract_region` 只服务文本层。这是路 B 唯一还开着的项，也是 **未量**。

**做什么（二选一，先写决定再写代码）**

- **路 1 · 表格进门。** 先在现有 harness 上把表格从 reported 改成门，门槛与语料同级（≥80% located）或写明为什么更低。不过门再开 spike：tesseract 区域 crop（同一 182 个单元格，crop 前后的 located 差），以及 ocr-rs 在同一 51 页 / 662 引文上的五门加表格面。任一门不过 = 不换、不删 `public/ocr`。区域 crop 若净增不到一个可写进 changelog 的数（spike 的预处理是 +4/228，被判不做），也不做。
- **路 2 · 明说不承诺。** `eval/README.md` 的表格行从「reported」改成「not a promise」，读者侧扫描页上的表格答案在 `noQuote` / `unconfirmed` 之外不新增状态。这条便宜，而且诚实。它的代价是 v21 的扫描故事停在 20.0。

本稿倾向路 2 作为默认、路 1 作为有数之后的升级。原因：路 1 的两个候选今天都没有过门的数，而「先写进门再发现过不了」会把一个版本耗在引擎上——20.0 的 spike 已经证明这条路会这样耗。路 2 一天能写完，并且让下一轮的 spike 有一个不会被人误读的基线。

**删/退役**

- 不删 tesseract。不删 vision 预算。不引入第二个引擎「先并存看看」。
- 若走路 2：删掉任何「扫描件配得上同样的问题」在表格上的暗示。20.0 的 changelog 没有这句；README 的「scanned pages too」是指引文高亮，不是表格。核对 README 那一句，不要让它比门宽。

## 3. 依赖

**v21 不需要新依赖。** 两个支点用的存储、导出、eval harness、原子写都已在。

**前端（实测 `npm outdated --json`，2026-10-15）**

落后的 12 个全是补丁或小版本：`@ai-sdk/openai` 4.0.93→4.0.94，`@ai-sdk/react` 4.0.143→4.0.145，`ai` 7.0.140→7.0.141，`@tauri-apps/api` 2.12.3→2.12.4，`@tauri-apps/cli` 2.12.2→2.12.3，`plugin-dialog` 2.8.2→2.8.3，`plugin-opener` 2.7.1→2.7.2，`lucide-react` 1.56.0→1.57.0，`oxc-transform-react` 0.152.0→0.154.0（latest，wanted 仍是 0.152），`playwright` 1.64.0→1.64.1，`react` / `react-dom` 19.3.0→19.3.1。没有 v21 要用的新能力。升不升是卫生，不是方向。

**Rust（实测 crates.io API，2026-10-15）**

| crate | lock | 最新稳定 | 判断 |
|---|---|---|---|
| tauri | 2.12.3 | 2.12.4 | 补丁；`max_version` 字段是 3.0.0-alpha.5，不采用 |
| pdf-inspector | 1.25.2 | 1.25.2 | 已最新 |
| lopdf / keyring | 0.45.0 / 4.2.0 | 同左 | 已最新 |
| tauri-plugin-window-state | 2.5.0 | 2.5.0 | 已最新稳定；3.0 alpha 不采用 |
| tauri-plugin-dialog / opener | 2.8.2 / 2.7.1 | 2.8.3 / 2.7.2 | 补丁 |
| tauri-plugin-single-instance | 2.5.3 | 2.5.4 | 补丁 |
| ocrs | — | 0.13.1 | Latin-only，不进 |
| ocr-rs / mnn-rs | — | 2.4.1 / 0.1.7 | 仅当 §2.2 路 1 的 spike；mnn-rs 不是引擎 |

**未验证**：macOS/Windows 真机、ocr-rs 完整门数、表格 crop 的 located 差。

## 4. 验收

**核对过夜**

1. 一次复核调用携带 N 条引用的 schema；N=8 时 `generateObject` 调用次数为 1（失败隔离：一条 schema 失败不丢其余）。`npx vitest run src/lib/claim-review.test.ts`。
2. 复核结果在关文档、再开、再导出之后仍在 CSV 与 brief 里，且只通过 `cite.review.*`。没有复核记录时模型列为空。store 测试加一条「写入、清内存、读回」。
3. `contradicts` 仍只降不升（现有 `trust-level` 测试保持）。
4. 无标记句的决定落地：若进列，`page-citations` 的单测覆盖「一句有标记、邻句没有」；若决定不进，`eval` 或库存脚本断言列条目数等于有 citation 的句子数，并在本稿或 changelog 写明。
5. 空页的 `note` 不含 `budgetExceeded`，且含「没有字」的那句（中英各一）。`npx vitest run src/lib/agent-tools/read-tools-contract.test.ts`。
6. 前缀仍 ≤9,000 B。`npx vitest run src/lib/agent-tool-prefix.test.ts`。今天 8,925。任何 digest 变化在同一提交里说明删了哪句。

**表格的决定**

7. 路 2：`eval/README.md` 表格行写明不是承诺；README 里「scanned pages」的句子不宽于门。`rg` 复核。
8. 路 1（仅当决定进门）：同一 harness 上表格 located ≥ 所写门槛，或引擎/crop 的前后差写进 `eval/README.md` 并带日期与 commit。不过门 = 不换、不删资源，记录在案。

**写路径收口**

9. `store_write_cmd` 对已存在且解析失败的文件拒绝覆盖；finding body 走同一条。撕坏的 sidecar 在一次编辑之后字节不变。扩展 `src/lib/store-integrity.test.ts`。
10. OCR 缓存与注释导出补 `sync_all`，或 `SECURITY.md:23` 把这两处划出去。二选一，不允许文档比代码宽。
11. 降级再升级：`index.newer` 在升级路径被读回，或降级进程不把主键写成 v1。`npx vitest run src/lib/index-store.test.ts`。重计费 = 0 用 `getVisionCallCount` 或「读回的页数不变」断言，不靠注释。
12. `copy-ocr-assets.mjs` 在 tesseract.js 缺席时退出非零。一行。用缺依赖的临时 `NODE_PATH` 或把判断抽出来测，不靠读脚本。

**门的诚实（顺手，不单独立项成版本）**

13. `settingsRows` 数到模型行，或把该行改成已计数的原语。改之前 7，改之后与读者看见的行数一致。
14. `vitest.config.ts` 的 include 收进 `src`、`scripts`、`eval`。仓库根的 `*.test.ts` 不被收集。
15. `en.json` / `zh-CN.json` 与 `docs/RELEASE.md:31` 不再出现「AI Provider / AI 提供商」。`README.md:65` 的场景数与 `perf-probe.mjs` 的 4 个函数、21 条 check 一致。

## 5. 明确不做

1. 多文档、跨文档提问、库级搜索、分屏。
2. 金额与账单。用量行保留。
3. 为一家提供商解析缓存命中。
4. 分块重组页文本。
5. 首屏包。启动预算仍远高于实测，v19 的结论照旧；本次未重测启动。
6. 双引擎 OCR 并存。
7. `ocrs` 0.13.1。中文门不可达，spike 已写死。
8. 运行中成本条。
9. ⌘F 的「下一个命中」与结果保持。
10. 「每句必须带标记」写进提示词。75 B 出不起，而且不该由模型承担本地能判的事。
11. 模型 verdict 自动升级任何状态。只降不升。
12. 自动对每一句跑 `claim-review`。手动触发保留；自动是账单。
13. 页边列在面板开着时占宽。20.0 的决策数不变。
14. 换引擎作为 v21 的默认交付。只有 §4 #8 的门过了才换。
15. 删 `docs/reviews/` 里的旧稿。它们描述的界面已不在，但从上往下读会误以为仍成立——在旧稿顶部加一行「界面已变，见 20.0/21.0」即可，不删历史。本稿不把这件事算进验收。

## 6. 风险

- **落盘的复核会被读成「本地核对过」。** 缓解：只通过 `cite.review.*`，芯片与导出同一套词，`contradicts` 只降不升。验收 #2、#3。
- **无标记句进列会把列挤满。** 帽仍是 12。若一页的未核对句经常挤掉已核对句，回到「不进」并写明。这是实现时量的，不是现在能定的。
- **表格进门会吞掉整个版本。** 默认路 2。路 1 只在有人明确要这道门时开，并且先有数。
- **`index.newer` 的修复若做成「升级时静默合并」，会把降级期间的新页盖掉。** 合并规则要写明：主键与 `newer` 冲突时保留页数更多的那份，或保留较新的 stamp。不要「newer 覆盖主键」一句话。
- **前缀。** 新文案不进 system。工具 description 的一个词就是一次全员缓存失效。
- **未验证面**：macOS/Windows 真机、过渡帧位图是否被裁、页码是否被 `overflow: hidden` 裁掉、1,000 条大纲的挂载、200MB RSS、空闲 CPU、每步 `outputTokens` 分布（拆输出盖之前必须先量，所以 §2 不把拆盖列成必做）、表格 crop 的 located 差。

## 7. 成本账（相对 20.0 的变化，不重写全表）

20.0 的逐环节账在 `docs/reviews/2026-10-14-pagewise-v20-next-major-review.md` §7。下面只写**现在还成立的浪费**和**v21 会动的那几笔**。价格用本次从 `developers.openai.com/api/docs/pricing` 读到的 gpt-4o-mini：**$0.15 / $0.075（cached）/ $0.60** 每 1M input/cached/output tokens（上游，2026-10-15）。与 v20 评审当日相同。默认 provider 仍不是这条价；美元是 OpenAI 路径的换算，不是读者的账单。

| 项 | 今天 | v21 若按本稿 |
|---|---|---|
| 固定前缀 | **8,925 B**（实测本次），每步重发，20 步 ≈ 44,640 tokens | 不涨。不把新规则写进 system |
| 每步输出盖 | 8,000，机械与合成共用。30 步满载 ≈ 240k output tokens ≈ $0.144 | **不先切。** 每步 `outputTokens` 分布 **未量**。量完再拆，合成步保持 8,000 |
| `claim-review` | 逐条 1 次，≈900–1,100 input tokens/条（v20 算术，本次未重测调用）。N=8 ≈ 8 次，且不过夜，重开再付 | 1 次调用核 N 条；落盘后重开不再付 |
| `read_figure` 重复 | 同轮第二次已是 0 次调用（20.0） | 保持。额度用尽的文案换成说图的那句，不改额度 |
| OCR sweep | ≤50 页（20.0）。逐页滚动的 vision 与 reindex 的 `visionBudget: null` 不在这顶帽里 | 不扩大帽。旁路是否计入，作为阅读面的收口，不作为本版主线——它省的是误触发，不是默认路径 |
| 表格识别 | 68.7% located，无门，无区域路径 | 路 2：成本不变，承诺收窄。路 1：先量 crop 或 ocr-rs，不过门不付迁移成本 |
| 写放大 | marks 一次 flush 4.32MB（本次实测，10k 条）；findings 索引 2.0MB（5k 条无 body）；body 已旁路 | 不追求把索引再拆小。先堵住「撕坏的 sidecar 被覆盖」和「降级重付」 |
| 安装包里的 OCR | 源文件约 10.5MB 量级（本次 `du` 的五份，不是 `public/ocr`）。打包体积 **未量** | 不删。缺资源的构建改为失败 |

可赎回的、本稿愿意写进验收的，只有两笔钱：**复核从 N 次变 1 次，并且不再因重开重付**；**降级不再重付已索引的页**。其余要么未量（输出分布、crop 收益、200MB RSS），要么不该在没数的时候动（输出盖、换引擎、删 OCR 资源）。

## 8. 验证记录

**本次在这个 orb 里执行的**

- 四份审计片段（`docs/reviews/v21-audit/01`–`04`），合并后删除。`file:line` 由片段作者重读；父线程抽查了会改结论的几处：`page-citations.ts:88`、`WorkspaceHeader.tsx:124`、`copy-ocr-assets.mjs:30-33`、`store_io.rs` 的 `sync_all`、`ocr_cache.rs:86-90`、`en.json:20`、`README.md:65`、`document-scope.ts` 的登记表、`affordableChars` 与 `readPageRange:610-616`。
- **改正**：片段 02 初稿写「空白页仍被说成预算用尽」。对照 `reading.ts:97-102` 与 `:610-616` 后改为「不再误标，缺的是说明」。片段文件已按此改过，再合并。
- `node scripts/complexity-budget.mjs`：8/8 绿，数字与 `complexity.snapshot.json` 一致（faces 15、tabs 7、commands 12、scanKnobs 2、settingsRows 7、copyKeys 482、cssLines 6179、srcLines 41036）。
- `node scripts/check-i18n-keys.mjs`：482 键，两边对齐，退出 0。
- `npx vitest run src/lib/agent-tool-prefix.test.ts`：2 通过。同方法复测前缀 **system=3248 tools=5677 total=8925**，8 个工具。测量文件在 `.audit-tmp/`，已删除。
- `npm outdated --json`：12 个包落后，见 §3。
- crates.io API：tauri 最新稳定 2.12.4（alpha 3.0 不采用）、pdf-inspector 1.25.2、lopdf 0.45.0、keyring 4.2.0、window-state 2.5.0、ocrs 0.13.1、ocr-rs 2.4.1、mnn-rs 0.1.7。
- `curl` OpenAI pricing 页：gpt-4o-mini 0.15 / 0.075 / 0.60，与 v20 评审当日相同。
- 片段 03 的 `node -e` 写放大：10,000 marks 4,316,658 字节；5,000 findings 无 body 2,004,204 字节。父线程未重跑夹具，引用为片段实测。
- `du -sb` OCR 源文件（`node_modules`，不是 `public/ocr`）：见 §1.3。

**读代码（未运行）**：§1 其余模块。过渡帧位图、页码裁切、大纲挂载、BM25 重建、200MB RSS、空闲 CPU、每步 outputTokens、表格 crop、webview 对 `store_write_cmd` 的拒绝、杀进程 torn-write，全部 **未量**，测量路径写在对应节或 §6。

**未验证**：未跑 `npm test` 全套、未跑 `npm run build`、未启 dev server、未跑 Playwright、未跑 `eval` / `ui:shots` / `perf`。所以「改回旧预算值则 build 报红」「50 篇之后 map size」「页宽两态的像素」不是本次的运行态数字。20.0 的 changelog 记录过页宽 911→1,120，本稿不重测，也不把它当成 v21 的决策数。
