# 第一期设计方案：接入 `pdf-inspector` 的页面质量分类

日期：2026-08-03 ｜ 基线：PageWise v3.6.1 ｜ 依赖：`pdf-inspector = "=0.1.7"` (MIT)
前置评估：`docs/reviews/2026-08-03-pdf-inspector-integration-feasibility.md`

---

## 0. 目标与非目标

**目标**：让 PageWise 能够识别"这一页的文本不可信"，并把这条信号贯通到索引队列、成本提示、agent 工具与预览 UI。

**非目标（留给第二期）**：不替换 `pdf-extract`，不改变 `docCache` 的纯文本格式，不触碰 ⌘F 搜索与 agent 工具的输出格式契约。

---

## 1. 实测确立的三条硬约束

这些是本次跑通 `pdf-inspector 0.1.7` 后测得的事实，直接决定了设计形态。

### 约束 A：乱码检测必须走完整提取，采样检测拿不到

| 调用 | 耗时（117 页） | 检出 |
|------|--------------|------|
| `detect_pdf`（默认 `Sample(8)`） | 58 ms | 扫描页 ✅ ／ 乱码页 ❌ `[]` |
| `ProcessMode::DetectOnly` + `ScanStrategy::Full` | 52 ms | 乱码页 ❌ 仍是 `[]` |
| `process_pdf`（完整提取） | **468–515 ms** | 乱码页 ✅ `[4, 46]`，`has_encoding_issues=true` |

`suspected_garbled_text` 是**实际解码文本后**才能得出的结论，任何"只探测不提取"的模式都拿不到。而乱码检测恰恰是本次集成最大的价值点 → **必须付完整提取的钱**。

同一份文档现有 `pdf-extract` 逐页提取耗时 1264 ms，所以这 500 ms 属于同量级、可承受，但**不能放在打开文档的关键路径上串行叠加**。

### 约束 B：按页过滤的提取，其 OCR 页列表不完整

```
extract_pages_markdown(path, Some(&[1,2,3])) → 369ms, pages_needing_ocr=[4]   // 少了 46
process_pdf(path)                            → 468ms, pages_needing_ocr=[4,46] // 完整
```

请求第 1–3 页却报出第 4 页，同时漏掉第 46 页。**结论：分类结果只信任整档 `process_pdf` 的一次运行，绝不从按页提取里推断。**

### 约束 C：`classify_pdf_mem` 的页号是 0-based，`detect_pdf` / `process_pdf` 是 1-based

单页扫描件样本上：`detect_pdf → [1]`，`classify_pdf_mem → [0]`。这是上游 0.1.x 的不一致。**设计上只使用 `process_pdf` 系列（1-based），并在 Rust 边界做一次显式归一化 + 越界钳制**，不让这个坑漏到前端。

---

## 2. 架构决策

### 决策 1：分类不阻塞加载，但**首次 sweep 等它**

```
loadDocument
  ├─ extract_pdf_text (pdf-extract, 现状不变) ──────────► docCache.pages
  └─ classify_pdf (pdf-inspector, 并发 invoke) ─┐
                                                 ▼
commitLoadedDocument:  await classification(超时 3s) → applyClassification() → scheduleIndex()
```

为什么让首次 sweep 等分类，而不是先扫、后补：

- vision 索引是**网络+计费**操作，本来就要几秒起步，等 ~500 ms 毫无体感；
- 若先 sweep 再补，`scheduleIndex` 会 abort 当前队列重开一轮（generation 机制），已经发出的 vision 调用白花钱；
- 乱码页优先级高于空白页，先拿到全集才能一次排好序。

超时/失败一律 fallback 到今天的行为（只按长度判定），**分类是纯增强，永不成为加载的失败点**。

### 决策 2：被判不可信的页，**清空其原生文本**，而不是新增一路质量判据

备选方案是引入 `isUsablePageText()` 并替换全部 7 处 `text.trim().length >= MIN_INDEX_CHARS` 判断（`index-queue` ×4、`agent.ts` ×2、`doc-text.ts` ×1，外加 `document_outline` 的 `unindexedPages`）。那样改动面大、易漏。

选定方案：在分类结果落地时把不可信页的文本**置空**，于是下游全部逻辑（`MIN_INDEX_CHARS`、`sparsePages`、`pageHasIndexableText`、`readPageText`、`document_outline`）**一行不改就自动正确**。

前提是必须区分"原生提取文本"和"花钱换来的 vision 文本"——只清前者。因此：

```ts
// src/lib/types.ts
export interface PageText {
  page: number;
  text: string;
  /** 文本来源。缺省视为 "native"（免费可重算）。 */
  source?: "native" | "vision";
}
```

`source: "vision"` 的写入点仅两处：`index-queue.indexPage()` 成功时、`index-store.loadIndexedPages()` 回灌时。

### 决策 3：顺带修掉一个既存缺陷 —— `pickBetterPageText` 会让乱码战胜 vision 文本

`page-text-merge.ts:12` 现规则："两边都 ≥20 字符时，取更长者（需长出 25%）"。乱码页的垃圾字符往往比 vision 转写**更长**，于是：

- `upsertPageText` 里，vision 文本会被垃圾**拒绝写入**；
- `mergePageTextsOnReload` 里，重新打开文档时原生垃圾会**覆盖掉已付费的 vision 文本**。

即使不接 `pdf-inspector`，这两条也是真实 bug；接了之后若不修，整个第一期收益会被这里吃掉。修法是让 `source` 参与决策：**vision 文本恒胜 native 文本**，仅在同源时才比长度。

### 决策 4：只有"乱码/矢量文字"两类原因触发清空

| `ocr_reason` | 原生文本现状 | 处置 |
|---|---|---|
| `scanned` / `no_text` | 本来就是空的 | 清空是 no-op，仅进队列 |
| `suspected_garbled_text` | 长且错 | **清空** + 进队列 |
| `vector_text` | 描边文字，提取结果不可靠 | **清空** + 进队列 |

误报代价可控：清掉的是可免费重算的原生文本，且页面在 UI 上会显示 "文本不可靠，已改用视觉索引" 的角标（决策 6），不是静默行为。反向代价（不清）则是模型静默读到垃圾——不对称，所以选择清。

### 决策 5：扫描件跳过 `pdf-extract`

`detect_pdf` 对扫描件 1 ms 就能给出 `Scanned/0.95`。当分类为 `Scanned` 且 `confidence ≥ 0.9` 时，整档 `pdf-extract` 提取（对扫描件必然全空）可以直接跳过 → 大扫描件打开速度净提升。

实现上这需要分类**先于**提取，与决策 1 的并发结构冲突。折中：只在这一条上用 `detect_pdf`（sample 模式，1–58 ms）做前置探测，完整分类仍并发进行。

```
detect_pdf (≤60ms, 阻塞)
   ├─ Scanned & conf≥0.9 → 跳过 pdf-extract，pages 全空，直接进 vision 队列
   └─ 其他               → 照常 extract_pdf_text  ‖  并发 process_pdf 完整分类
```

### 决策 6：把信号一路暴露到 UI 与 agent

| 消费方 | 改动 |
|---|---|
| `App.tsx` 的 `unscannedPages` | 无需改（源自 `pendingIndexPages` → `sparsePages`，自动含新页） |
| 打开文档时 | 分类落地后，若需索引页 > 0，提示"本文档 N 页需要视觉索引"，与 v3.6.0 的 scan budget / 花费提示合流 |
| `PreviewPane` 页角标 | 不可信页显示原因（区别于"空白页"） |
| `document_outline` 工具 | 新增 `pdfType`、`pagesNeedingOcr`（含原因）、`pagesWithTables`、`pagesWithColumns` |
| `read_pdf_page` 工具 | 页文本为空时附带 `ocrReason`，模型能区分"空页"与"扫描件/乱码页" |
| Library / 最近文件 | 用 `title` 补充文件名（仅当文件名无意义时，低优先级） |

---

## 3. 具体改动清单

### Rust 侧

**`src-tauri/Cargo.toml`**
```toml
pdf-inspector = "=0.1.7"   # 精确 pin：上游 0.1.x，两个月发了 8 版
```

**新增 `src-tauri/src/inspect.rs`**

```rust
#[derive(Serialize, Clone)]
pub struct OcrPage { pub page: u32, pub reasons: Vec<String> }

#[derive(Serialize, Clone)]
pub struct PdfClassification {
    pub pdf_type: String,          // text_based | scanned | image_based | mixed | unknown
    pub confidence: f32,
    pub page_count: u32,
    pub ocr_pages: Vec<OcrPage>,   // 1-based，已去重、已按 page_count 钳制、已截断上限
    pub has_encoding_issues: bool,
    pub title: Option<String>,
    pub pages_with_tables: Vec<u32>,
    pub pages_with_columns: Vec<u32>,
    pub depth: String,             // "sample" | "full"
    pub elapsed_ms: u64,
}

pub fn classify_pdf(path: &str, depth: Depth, cancel: &PdfExtractCancel, gen: u64)
    -> Result<Option<PdfClassification>, String>;
```

要点：
- `depth=sample` → `detect_pdf`；`depth=full` → `process_pdf`（丢弃 markdown，只取元数据）。
- 返回 `Ok(None)` 表示"分类不可用"（上游报错/panic），**不是 Err** —— 前端据此静默降级。
- 复用现有 `run_blocking_pdf`（`catch_unwind`）、`spawn_blocking`、`AllowedPaths::ensure_allowed`、`PdfExtractCancel` 的 `load`/`agent` scope。
- 按 `(path, stamp)` 做单条 LRU 缓存（与 `PdfCache` 同 `MAX_CACHED_DOCS = 1` 语义），避免 UI 与 agent 重复触发整档解析。
- 归一化：页号统一 1-based、`reasons` 去重、列表长度上限（防超大文档产生巨型 IPC payload）。

**`src-tauri/src/lib.rs`**：注册 `classify_pdf_cmd`，`.manage(ClassificationCache::default())`。

### 前端

| 文件 | 改动 |
|---|---|
| **新增** `src/lib/pdf-classify.ts` | invoke 封装 + 类型 + `normalizeClassification()`（越界钳制、去重）+ `untrustedPages()` |
| **新增** `src/lib/page-quality.ts` | `UNTRUSTED_REASONS = {suspected_garbled_text, vector_text}`、`shouldDropNativeText(reasons)` |
| `src/lib/types.ts` | `PageText.source?: "native" \| "vision"`；`LoadedDocument.classification?: PdfClassification` |
| `src/lib/page-text-merge.ts` | `pickBetterPageText` 增加来源参数：vision 恒胜 native；同源才比长度 |
| `src/lib/doc-cache.ts` | `setClassification()` / `getClassification()` / `applyClassification()`（清空不可信页的 native 文本并 notify） |
| `src/lib/load-document.ts` | 前置 `detect_pdf`（决策 5）；并发发起 full 分类；`commitLoadedDocument` 等待（3s 超时）后再 `scheduleIndex` |
| `src/document/index-queue.ts` | `sparsePages()` 取 `长度不足 ∪ ocrPages` 的并集；sweep 顺序把不可信页排前 |
| `src/lib/index-store.ts` | 回灌的页标 `source: "vision"` |
| `src/lib/agent.ts` | `document_outline` 增补分类字段；`readPageText` 返回 `ocrReason` |
| `src/features/preview/PreviewPane.tsx` | 不可信页角标 |
| `src/i18n/locales/{en,zh-CN}.json` | 新增文案键 |

### 测试

全部为纯函数，不需要真实 PDF：

1. `page-quality.test.ts` — 原因 → 是否清空的映射
2. `pdf-classify.test.ts` — 归一化：0-based 混入、越界页号、重复项、超长列表
3. `page-text-merge.test.ts`（扩充）— **vision 文本永不被更长的 native 文本覆盖**（即决策 3 的回归测试）
4. `index-queue.test.ts`（扩充）— 长度足够但被标乱码的页仍进队列；分类缺失时行为与今日完全一致
5. `load-document` — 分类超时/失败时不阻塞、不改变现有加载结果

---

## 4. 风险与回退

| 风险 | 处置 |
|---|---|
| 上游 0.1.x API 变动 | 调用面全部收敛在 `src-tauri/src/inspect.rs` 一个文件；精确 pin 版本 |
| 分类误报导致重复计费 | 已有 scan budget / auto-index cap 兜底；误报页在 UI 可见；`confidence` 参与门槛 |
| 完整分类 +500 ms | 不在关键路径（与提取并发），仅首次 sweep 等待，且有 3s 超时 |
| 双份 `lopdf` 编译进二进制 | 第一期接受（体积 +~5 MB）；第二期换掉 `pdf-extract` 后消除 |
| 清空文本误伤 | 只清可免费重算的 native 文本；vision 文本受 `source` 保护 |
| **整体回退** | 让 `classify_pdf_cmd` 恒返回 `None`，全链路即刻退回 v3.6.1 行为 |

---

## 5. 落地顺序

1. Rust：`inspect.rs` + 命令注册 + 缓存（可独立验证）
2. 前端类型与纯函数：`pdf-classify.ts`、`page-quality.ts`、`page-text-merge` 修正 + 单测
3. 接线：`doc-cache` → `load-document` → `index-queue`
4. 暴露：agent 工具字段、预览角标、打开时成本提示、i18n
5. 回归：真实文档验证（CID 中文 PDF / 双栏论文 / 扫描件 / 加密 PDF）

**验收**：一份 CID 字体中文 PDF —— 当前会提取出乱码且不触发 vision；改动后应被标为 `suspected_garbled_text`、原生文本被清空、进入索引队列，且 vision 文本不再被垃圾覆盖。
