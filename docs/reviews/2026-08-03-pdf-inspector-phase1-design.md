# 第一期设计方案（修订版）：三层文本级联

日期：2026-08-03 ｜ 基线：PageWise v3.6.1
证据：`docs/reviews/2026-08-03-pdf-inspector-validation.md`（本设计的每条依据都在其中可复现）

> **本文是修订版。** 初版设计的前提是"保留 `pdf-extract` 作为文本源，用 `pdf-inspector` 的 `needs_ocr` 决定哪些页送 vision"。实测 V1 证明该前提不成立：那个标记描述的是 **pdf-inspector 自己在该页提取失败**，不是 PDF 有问题。按初版实现会把一页完好的目录清空并为它付一次 vision 费用。

---

## 1. 修订后的核心判断

实测 V2 显示两个提取器是**互补**的，不是替代关系：

- `pdf-inspector` 全档多提取 39% 文本，表格/多栏/标题结构正确，**且它失败的每一页都诚实自报了**（该文档上无静默失败）；
- 但它在 2 页上完全失败，而这 2 页 `pdf-extract` 处理得很好（目录点线 leader、数学符号）。

→ 正确形态既不是"只用旧的"，也不是"只换新的"，而是**级联**：让新库当主力吃掉质量收益，让已有的旧库当免费兜底吃掉它的失败页，vision 只在两者都失败时才动用。

## 2. 三层级联

```
打开文档
  ①  pdf-inspector  process_pdf     整档 Markdown + 逐页 needs_ocr        ~0.5s/117页, 54MB
        │
        ├─ 该页有文本 ─────────────────────────────► 采用（结构化 Markdown）
        │
  ②  该页 needs_ocr 或文本为空 → pdf-extract 单页提取   免费、本地、已是现有依赖
        │
        ├─ 拿到文本 ───────────────────────────────► 采用（纯文本）
        │
  ③  仍为空 → vision 索引队列                          计费，现有机制不变
```

关键性质：

- **误报不再有代价。** 被标记的页先走一次免费的本地重提取，只有真正两边都拿不到文本才升级到计费调用。V1 里那两页目录/数学页会在第 ② 层被 `pdf-extract` 无声救回。
- **旧依赖从"待淘汰"变成"安全网"**，`pdf-extract` 继续留在树里是有正当理由的，不是历史包袱。
- **第 ③ 层完全不变** —— 现有的 index-queue、scan budget、index-store、计费提示一行不改。
- 扫描件（`detect_pdf` 1 ms 判定）可跳过 ①②，直接进 ③。

## 3. 必须处理的三个上游陷阱

### 陷阱 A：页号基准在同一个结构里就不一致（V4）

`pages[].page` 是 0-based，`pages_needing_ocr` 是 1-based；`classify_pdf_mem` 又是 0-based。

**处置：不使用任何页号列表。** 只用 `pages` 数组的**顺序**定位 —— 第 i 项即第 i+1 页，逐页的 `needs_ocr` / `ocr_reason` 就在数组元素里。再用 `pages.len() == page_count` 做健全性校验，不一致则整体降级（放弃 ①，退回今天的 `pdf-extract` 路径）。

这样对上游未来任何页号基准变更**免疫** —— 这一点在不固化版本的前提下尤其重要。

### 陷阱 B：完整提取才有 needs_ocr，采样模式没有（V5）

`detect_pdf` 与 `DetectOnly` 都返回空列表。→ 第 ① 层必须是完整 `process_pdf`。代价 0.5 s，但它同时**取代**了现在 1.33 s 的 `pdf-extract` 整档提取，净减少约 0.8 s。

### 陷阱 C：无取消 API（V7）

`process_pdf` 不接受 cancel token，整档解析不可中断。现有 `PdfExtractCancel` 只能在调用前后检查。

**处置**：设页数/体积阈值（如 > 2000 页或 > 100 MB）时跳过第 ① 层直接用现有逐页路径（那条路径每页都检查取消位），保住大文件的可中断性。

## 4. 版本策略：不固化，用行为夹具兜底

依据 V9：0.1.0→0.1.7 **API 零破坏**，但**行为持续变化**，且本次要用的乱码自报能力 0.1.0 根本不存在（0.1.3 出现、0.1.5 完整）。固化版本等于主动放弃能力增长；真正的风险是行为漂移而非编译失败。

```toml
# src-tauri/Cargo.toml
pdf-inspector = "0.1"    # 允许全部后续 0.1.x；0.2 需人工评估（0.x 的 minor 即 breaking 通道）
```

配套四条：

1. **可重现性交给 `Cargo.lock`**（应用是 binary crate，lock 已入库），而不是交给 manifest 的精确版本。
2. **调用面收敛在 `src-tauri/src/inspect.rs` 一个适配层**，其余代码只见 PageWise 自己的类型。上游任何签名调整只改这一个文件。
3. **行为黄金夹具**（本设计的核心防线）：仓库内放 3 个小体积 fixture，断言用容差而非精确快照：
   - `cjk-table.pdf`（21 KB，本次已造好）→ 断言：`TextBased`；表格行以 `|` 分隔且 `1,284` 与 `1,141` **不粘连**（这正是 V3 里现有管线读错数字的那一条）
   - `text-simple.pdf`（12 KB）→ 断言：字符数在基线 ±15% 内、无 `needs_ocr`
   - `scanned.pdf`（单页位图）→ 断言：`Scanned`、`confidence ≥ 0.9`、该页 `needs_ocr`
   
   容差断言的用意是：上游把 markdown 改进 10%（0.1.3→0.1.5 真实发生过）不该让 CI 变红，但表格塌回粘连、或扫描件不再被识别，必须变红。
4. **一个不阻塞主 CI 的定时 job**：`cargo update -p pdf-inspector && cargo test`，提前发现漂移。升级由人决定，但不需要人去读 changelog —— 上游**没有 Release Notes**（V9），夹具就是唯一可信的判据。

## 5. 改动清单

### Rust

**`src-tauri/Cargo.toml`**：`pdf-inspector = "0.1"`

**新增 `src-tauri/src/inspect.rs`** —— 唯一调用点，对外只暴露 PageWise 自己的类型：

```rust
pub struct InspectedPage { pub page: u32, pub text: String, pub needs_fallback: bool, pub reason: Option<String> }
pub struct InspectedDoc { pub pages: Vec<InspectedPage>, pub pdf_type: String, pub confidence: f32,
                          pub title: Option<String>, pub pages_with_tables: Vec<u32>, pub pages_with_columns: Vec<u32> }

/// 返回 Ok(None) = 分类/提取不可用 → 调用方静默退回现有路径。永不成为加载的失败点。
pub fn inspect_pdf(path: &str, cancel: &PdfExtractCancel, gen: u64) -> Result<Option<InspectedDoc>, String>;
```

要点：顺序定位页号（陷阱 A）、`pages.len() == page_count` 校验、超大文档阈值跳过（陷阱 C）、复用现有 `run_blocking_pdf`（保留 `catch_unwind`）/`spawn_blocking`/`ensure_allowed`/`PdfCache` 同款单条 LRU。

**`src-tauri/src/pdf.rs`**：`extract_pdf_text` 内部改为级联 —— 先 `inspect_pdf`，对 `needs_fallback` 或空文本的页调用现有 `extract_page_text_lossy`。**对前端的命令签名与返回结构完全不变。**

### 前端

级联发生在 Rust 内部，前端改动因此非常小：

| 文件 | 改动 |
|---|---|
| `src/lib/page-text-merge.ts` | 修 `pickBetterPageText`：Markdown 天然更长，"取更长者"规则会让原生文本压过 vision 文本 → 引入 `PageText.source`，vision 恒胜 native |
| `src/lib/index-store.ts` / `index-queue.ts` | 回灌与写入时标 `source: "vision"` |
| `src/document/search.ts` / `DocumentSearch.tsx` | ⌘F 前做一次 markdown→plain 归一化（否则 `**` 与 `\|` 污染匹配与片段） |
| `src/lib/agent.ts` | `document_outline` 增补 `pdfType` / `pagesWithTables` / `pagesWithColumns` |
| `src/i18n/locales/{en,zh-CN}.json` | 新增文案 |

> 注：初版设计里"清空不可信页的原生文本"这一决策**已删除**。级联使它没有必要 —— 第 ② 层保证了那些页仍有文本，无需破坏性操作。

### 测试

1. `page-text-merge.test.ts` 扩充 —— vision 文本永不被更长的 native/markdown 文本覆盖（现存缺陷的回归测试）
2. 搜索归一化 —— markdown 语法不影响 ⌘F 命中与片段
3. Rust 夹具测试 —— §4 的三个黄金夹具
4. Rust 级联测试 —— 构造"① 层返回空页"的情形，断言回落到 `pdf-extract` 且不触发 vision

## 6. 收益与代价

| | |
|---|---|
| 打开 117 页文档 | 1.33 s → **~0.5 s**（① 取代整档 pdf-extract，② 只对个别页补跑） |
| 提取文本量 | **+39%** |
| 表格 | `营业收入 1,2841,141` → `\|营业收入\|1,284\|1,141\|`（消除数字粘连导致的错误答案） |
| 多栏 / 标题 / 阅读顺序 | 由 Markdown 结构承载 |
| 扫描件 | 1 ms 前置判定，跳过无谓的整档提取 |
| 二进制体积 | +~5 MB |
| 冷编译 | +40 s |
| 峰值内存 | 48 MB → 54 MB |

## 7. 落地顺序

1. `inspect.rs` 适配层 + 三个黄金夹具测试（**先建防线，再接线**）
2. `pdf.rs` 级联，命令签名不变 → 此时前端零改动即可跑通并对比
3. `pickBetterPageText` 的 `source` 修正 + 单测
4. 搜索归一化
5. agent 工具字段、i18n
6. 真实文档回归：CJK 表格 / 双栏论文 / 扫描件 / 加密 PDF / 超大文档

**整体回退**：让 `inspect_pdf` 恒返回 `Ok(None)`，全链路即刻退回 v3.6.1 行为。
