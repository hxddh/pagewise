# 将 `firecrawl/pdf-inspector` 内置到 PageWise —— 可行性与价值评估

日期：2026-08-03 ｜ 评估对象：PageWise v3.6.1 ｜ 上游：https://github.com/firecrawl/pdf-inspector (MIT, crate `pdf-inspector` v0.1.7)

---

## 0. 结论摘要

**技术上完全可行，且价值高于一次普通的依赖替换。**

`pdf-inspector` 与 PageWise 的契合点不在"提取得更快"，而在于它**补上了 PageWise 当前架构里最薄弱的一环：判断一页文本到底可不可信**。PageWise 现在唯一的判据是 `text.trim().length < 20`（`src/lib/page-text-merge.ts:3`），这条规则只能识别"空白页"，无法识别 **CID 字体乱码、矢量描边文字、编码损坏** —— 这几类页面会提取出一堆看似正常、实则错误的字符，长度远超 20，于是**永远不会触发 vision 索引**，直接被喂给模型，产出无法察觉的错误答案。`pdf-inspector` 的 `pages_needing_ocr` + `ocr_reasons_by_page` + `has_encoding_issues` 恰好就是这条缺失的信号。

次要收益：Markdown 结构化输出（标题/表格/多栏阅读顺序）、文档标题、以及约 2.5 倍的提取速度。

主要成本：上游是 **0.1.x、2026-06 才首发的年轻 crate**，API 尚未稳定；二进制体积约 +5 MB；`docCache` 从纯文本变成 Markdown 会波及 ⌘F 搜索与片段展示。

**建议：分两期落地。第一期只接入"分类/OCR 路由"（低风险、价值最高），第二期再考虑用 Markdown 替换 `pdf-extract`。**

---

## 1. PageWise 当前 PDF 管线现状

```
PreviewPane ─ pdf.js ────────────► 渲染 / 文本层 / 大纲(getOutline) / 缩略图
docCache.pages[] ◄─ Rust: pdf-extract (src-tauri/src/pdf.rs) ── 纯文本，逐页
       │
       ├─► index-queue.ts   sparsePages(): text.length < 20 → 调 vision 模型补齐
       ├─► agent.ts         read_pdf_page / read_pdf_range / search_in_document
       └─► DocumentSearch   ⌘F 在同一份文本上做子串搜索
```

已识别的具体弱点（均在代码中可查）：

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| 1 | **只有"文本够不够长"一个质量判据** | `page-text-merge.ts:3` `MIN_INDEX_CHARS = 20` | CID 乱码/矢量文字页被当成有效文本，vision 兜底不触发，模型静默读到垃圾 |
| 2 | **无扫描件预判** | 全局 | 只能"先提取、发现空、再排队 vision"，无法在打开文档时一次性告诉用户"本文档 40 页需要视觉索引，预计花费 X" |
| 3 | `pdf-extract` 会 panic | `pdf.rs:extract_page_text_lossy` 用 `catch_unwind` 兜底 | 靠捕获 panic 维持稳定性；坏页降级为空串 → 又落回问题 1 的盲区 |
| 4 | **输出是无结构纯文本** | `PlainTextOutput` | 表格塌成一行、双栏论文阅读顺序错乱，直接损害 agent 回答质量 |
| 5 | 大文档单页读取要重新 load 整个文档 | `pdf.rs:extract_single_page`，`SINGLE_PAGE_FULL_EXTRACT_MAX = 200` | 已用缓存缓解，但 >200 页时每次单页读都重新解析 |
| 6 | 文档标题需另取 | — | 只有 pdf.js outline，没有 title |

---

## 2. `pdf-inspector` 提供什么

Rust crate（同时有 Python / npm / WASM 发行版，本评估只考虑 **Rust crate**，因为 PageWise 已有 Rust 后端）。唯一重量级依赖是 `lopdf 0.41` —— 与 `pdf-extract` 同源，**没有 ML 模型、不调用外部服务**，符合 PageWise "本地处理" 的定位。

与 PageWise 直接对口的 API：

```rust
detect_pdf(path)                          // 10-50ms 分类，只采样
process_pdf(path) -> PdfProcessResult     // 全文 Markdown + 全部元数据
extract_pages_markdown(path, Some(&[p]))  // 按页过滤，对应 read_pdf_page
process_pdf_with_options(path, PdfOptions{ password, page_filter, .. })  // 加密 PDF
```

`PdfProcessResult` 里对 PageWise 有价值的字段：

- `pages_needing_ocr: Vec<u32>` + `ocr_reasons_by_page` —— 原因是机器可读常量：
  `OCR_REASON_SCANNED` / `OCR_REASON_NO_TEXT` / `OCR_REASON_VECTOR_TEXT` / `OCR_REASON_SUSPECTED_GARBLED_TEXT`
- `has_encoding_issues: bool`、`confidence: f32`、`pdf_type`
- `layout: LayoutComplexity { pages_with_tables, pages_with_columns }`
- `title: Option<String>`、`page_count`、`processing_time_ms`

---

## 3. 实测（本次评估实际编译运行，非引用上游宣传）

环境：本会话容器，`cargo 1.94.1`，release profile。样本 `GeoTopo.pdf`（117 页 / 5.3 MB / LaTeX 德文教材，含表格与多栏）。

| 指标 | 现状 `pdf-extract 0.12` | `pdf-inspector 0.1.7` |
|------|------------------------|----------------------|
| 全文档提取 | 31 ms load + **1264 ms** 逐页 | **502 ms**（含 Markdown 转换） |
| 输出 | 156 235 字符纯文本 | 160 309 字符 Markdown（`# 标题` / 列表 / 表格） |
| 单页提取（第 1 页） | ~11 ms（文档已 load） | **326 ms**（含整档解析，无 load 复用） |
| 表格识别 | 无 | 55 页命中 `pages_with_tables` |
| 多栏识别 | 无 | 24 页命中 `pages_with_columns` |
| 需 OCR 页 | 无此概念 | `[4, 46]` |
| 编码问题 | 无此概念 | `has_encoding_issues = true` |
| 文档标题 | 无 | `"Geometrie und Topologie"` |

扫描件样本（单页 CMYK 位图 PDF）：`pdf_type=Scanned`, `confidence=0.95`, `pages_needing_ocr=[1]`，耗时 **1 ms**。—— 这正是 PageWise 目前必须"先提取完再发现是空的"才能得到的结论。

依赖与体积（probe 二进制对比，release + 未启用 PageWise 的 `lto`/`strip`）：

| | 依赖包数 | 二进制 |
|---|---|---|
| `pdf-extract` | 72 | 2.5 MB |
| `pdf-inspector` | 128（与前者共享 62 个） | 7.3 MB |

新增独有依赖主要是 `rayon`（并行解析）、`regex`、`ttf-parser`、`unicode-normalization`、`include_dir`（内嵌 CMap 字体表，体积增量的主因），以及 CLI bin 带入的 `env_logger`/`chrono` 等。**冷编译 67 s**（对比 `pdf-extract` 27 s），CI 构建时间会有可感增加。

> 注意实测出的一个关键事实：**单页提取仍需整档解析（326 ms）**，不像 `pdf-extract` 那样 load 一次后逐页几乎免费。因此 `pdf.rs` 现有的 `PdfCache` 不能取消，反而更重要；`SINGLE_PAGE_FULL_EXTRACT_MAX` 这类"大文档只取单页"的优化在新库下收益消失，需要重新设计（见 §5）。

---

## 4. 集成方案

### 方案 A（推荐，第一期）：只接入分类与 OCR 路由，保留 `pdf-extract`

新增一个 Tauri 命令，不动现有提取路径：

```rust
// src-tauri/src/pdf.rs
#[derive(Serialize)]
pub struct PdfClassification {
    pub pdf_type: String,          // TextBased / Scanned / ImageBased / Mixed
    pub confidence: f32,
    pub pages_needing_ocr: Vec<u32>,
    pub ocr_reasons: Vec<(u32, Vec<String>)>,
    pub has_encoding_issues: bool,
    pub title: Option<String>,
    pub pages_with_tables: Vec<u32>,
    pub pages_with_columns: Vec<u32>,
}
```

前端改动集中在一处：`index-queue.ts` 的 `sparsePages()`

```ts
// 现在：只认长度
.filter((p) => p.text.trim().length < MIN_INDEX_CHARS)

// 之后：长度 ∪ 分类器判定（乱码/矢量文字页即使"文本很长"也进队列）
.filter((p) => p.text.trim().length < MIN_INDEX_CHARS || ocrPages.has(p.page))
```

配套可做的小改动：

- 打开文档时用 `detect_pdf`（1–50 ms）先分类，`WelcomeView` / `PreviewPane` 直接告知"本文档 N 页需要视觉索引"，与已有的 scan budget / 花费提示（v3.6.0 引入）天然合流 —— **让预算提示从"边跑边报"变成"事前告知"**。
- `agent.ts` 的页读工具在返回文本时附带 `ocr_reason`，模型就能区分"这页是空的"和"这页是扫描件/乱码"。
- `title` 可用于 Library 最近文件显示。

**影响面**：新增 1 个 Rust 命令 + 1 处前端过滤条件 + 若干 UI 展示。不触碰 `docCache` 文本格式，⌘F、搜索、agent 工具输出格式全部不变。**可回退性极好**（去掉命令即恢复原状）。

### 方案 B（第二期，可选）：用 Markdown 提取替换 `pdf-extract`

把 `extract_pdf_text` 底层换成 `extract_pages_markdown`，`docCache` 存 Markdown。

收益：表格、双栏阅读顺序、标题层级进入 agent 上下文 —— 对"页级问答"这个产品核心是实质提升；且与 `MessageContent`/`Markdown.tsx` 已有的 Markdown 渲染链路一致。

代价（必须先解决）：

1. **⌘F 搜索会被 Markdown 语法污染** —— `DocumentSearch.tsx:61` 与 `document/search.ts` 都在 `docCache` 文本上做子串匹配，`**粗体**`、表格 `|` 会导致匹配失败与片段难读。需要么给搜索做一层 markdown→plain 归一化，么用 `MarkdownOptions`/`MarkdownProfile` 输出更保守的样式。
2. **`MIN_INDEX_CHARS` 语义漂移** —— Markdown 会引入语法字符，长度阈值需重新校准（若已落地方案 A，这条判据本就该让位给 `pages_needing_ocr`）。
3. **`pickBetterPageText` 的"取更长者"启发式失效** —— Markdown 天然比纯文本长，会稳定压过 vision 文本。这条规则必须重写。
4. **单页读取性能模型改变** —— 见 §3 注记，需保证缓存命中，并重新评估 `SINGLE_PAGE_FULL_EXTRACT_MAX`。
5. `panic` 兜底（`catch_unwind`）建议保留 —— 新库虽用 `thiserror`/`Result`，但 `lopdf` 层仍可能 panic。

### 方案 C（不推荐）：用 WASM 包在前端跑

`@firecrawl/pdf-inspector-wasm` 可在渲染进程运行，但 PageWise 已有成熟的 Rust 后端与文件授权机制（`AllowedPaths`），走 WASM 等于把文件字节搬进 JS 层，既增加内存拷贝又绕开 `ensure_allowed` 的安全边界。**不采用。**

---

## 5. 价值评估

| 价值项 | 量级 | 说明 |
|--------|------|------|
| **消除"乱码页静默通过"缺陷** | **高（正确性）** | 当前架构对 CID 乱码/矢量文字**完全无感**；这是会产生错误答案且用户无从察觉的一类 bug |
| **事前成本告知** | **高（产品）** | v3.6.0/3.6.1 刚做完 scan budget 与花费可见性；分类器让"要花多少钱"能在点开文档的瞬间就说清楚，而不是跑一半才报 |
| **省下不必要的 vision 调用** | 中（省钱） | 文本页被误判需要索引 → 直接是 API 花费；分类精度提升即真金白银 |
| **表格 / 多栏 / 标题结构** | 中高（回答质量） | 方案 B 才兑现；对论文、财报、合同类文档提升明显 |
| **提取速度 2.5×** | 低中 | 1264 ms → 502 ms，大文档打开体感有改善，但非瓶颈 |
| **文档标题** | 低 | Library / 窗口标题的小改善 |

**判断：即使只做方案 A，投入产出比也明显为正 —— 它修的是一个真实的正确性缺口，而不是锦上添花。**

---

## 6. 风险

| 风险 | 等级 | 缓解 |
|------|------|------|
| **上游成熟度**：v0.1.7，首版 2026-06-05，两个月内发了 8 个版本 | **中高** | 精确 pin 版本（`=0.1.7`）；把调用面收敛到 `src-tauri/src/pdf.rs` 单文件，便于随时替换或回退；方案 A 下即使上游消失也只损失一个增强功能 |
| 分类误报：把正常文本页标为 needs-OCR | 中 | 用 `confidence` 设阈值；`ocr_reasons` 逐页可解释；vision 索引本就有 budget 上限兜底，误报只是多花几次调用而非灾难 |
| 二进制 +~5 MB、冷编译 +40 s | 低 | 对桌面应用可接受；如需，可评估关掉 CLI bin 相关的可选依赖 |
| `lopdf` 双重依赖（`pdf-extract` 与 `pdf-inspector` 各自依赖）| 低 | 版本若不一致会同时编进两份；方案 B 完成后自然消除 |
| 加密 PDF 行为差异 | 低 | 现有 `decrypt_if_needed(doc.decrypt(""))` 对应新库 `PdfOptions.password`，语义可对齐 |
| 许可证 | 无 | 双方均为 MIT |

---

## 7. 建议路线图

**第一期（建议立即做，估 0.5–1 天）**
1. `Cargo.toml` 加 `pdf-inspector = "=0.1.7"`
2. `src-tauri/src/pdf.rs` 新增 `classify_pdf` + 对应 Tauri 命令（复用 `AllowedPaths` / `PdfExtractCancel` 现有机制）
3. `index-queue.ts` 的 `sparsePages()` 并入 `pages_needing_ocr`
4. 打开文档时展示"N 页需要视觉索引"，接入既有 scan budget 提示
5. agent 页读结果附带 `ocr_reason`
6. 单测：分类结果 → 队列选页的映射（纯函数，可脱离 PDF 测）

**第二期（视第一期表现再定，估 2–3 天）**
7. 搜索文本归一化（markdown→plain）先行落地
8. 重写 `pickBetterPageText` 的比较规则
9. `extract_pdf_text` 切到 `extract_pages_markdown`，移除 `pdf-extract`
10. 用真实文档（论文/财报/扫描件/中文 CID）做回归对比

**验收信号**：找一份 CID 字体中文 PDF —— 当前 PageWise 会提取出乱码且不触发 vision；接入后应被标为 `SUSPECTED_GARBLED_TEXT` 并进入索引队列。这是整个改动最直接的价值证明。
