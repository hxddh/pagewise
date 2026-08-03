# PageWise v4 设计：一次解析，一个文档模型

日期：2026-08-03 ｜ 基线：v3.6.1 ｜ 证据：`2026-08-03-pdf-inspector-validation.md`（V1–V13）
前提：不考虑与历史版本兼容；陈旧依赖直接删除。

---

## 0. 形态

一句话：**打开文档时解析一次，得到一个完整的文档模型；此后所有功能都从这个模型上读，不再回头解析 PDF。**

今天 PageWise 的文档信息是零散取的 —— 文本走 Rust 逐页命令、大纲走 pdf.js、页数走另一个命令、位置信息根本没有。v4 把这些收进**一次调用、一个结构**。命令数量不增加（PDF 相关仍是 2 个），能力却从"纯文本"变成"结构化文档"。

---

## 1. 架构

```
                    ┌─────────────────────────────────────────┐
  open_document ───►│ inspect.rs（唯一适配层，~200 行）        │
                    │  extract_pages_markdown  一次整档        │
                    │  + 区域取回被丢弃的页                    │
                    │  + extract_text_with_positions（链接/图） │
                    └──────────────┬──────────────────────────┘
                                   ▼
                          DocumentModel（一个结构）
                                   ▼
        docCache ──► 预览 / ⌘F / agent 工具 / 大纲 / 导出 / vision 队列
```

层数与今天相同（Rust 解析 → docCache → 消费方）。新增的只有一个适配层文件，它的存在理由是把上游三处页号基准不一致和坐标系分歧全部挡在里面（见 §5）。

### DocumentModel

```rust
pub struct DocumentModel {
    pub page_count: u32,
    pub pdf_type: String,            // text_based | scanned | image_based | mixed
    pub confidence: f32,
    pub title: Option<String>,
    pub pages: Vec<Page>,
    pub outline: Vec<Heading>,       // 由 markdown 标题合成
    pub links: Vec<Link>,
    pub figures: Vec<Rect>,          // ItemType::Image 的 bbox
}
pub struct Page { pub page: u32, pub text: String, pub needs_vision: bool,
                  pub has_table: bool, pub has_columns: bool }
pub struct Heading { pub title: String, pub page: u32, pub level: u8 }
pub struct Link { pub page: u32, pub text: String, pub url: String, pub rect: Rect }
```

**页号一律 1-based，坐标一律左上原点** —— 适配层归一后对外只有一种约定。

### PDF 相关命令（2 个，与今天数量相同）

| 命令 | 作用 |
|---|---|
| `open_document(path) -> DocumentModel` | 取代 `extract_pdf_text_cmd` + `pdf_page_count_cmd` |
| `extract_region(path, page, rect) -> { text, table_markdown }` | 框选提问用，新增 |

`cancel_*` / `file_stamp_cmd` / `read_file_bytes` / `write_text_file` / `secrets::*` 不变。

---

## 2. 删除清单

| 删除项 | 位置 | 理由 |
|---|---|---|
| **`pdf-extract` crate** | `Cargo.toml` | 被取代。依赖树 **-72 个包**；实测它唯一的优势是数学符号密集页（见 §7 代价） |
| `pdf_page_count_cmd` | `lib.rs:108` | **零调用方**（已核实） |
| `getPdfPageCount` | `pdf.ts:556` | **零调用方** |
| `extractAllPageTexts` | `pdf.ts:575` | **零调用方** |
| `extractPageText` / `extractPageTextFromRust` 的单页路径 | `pdf.ts` / `agent.ts:158` | 模型已含全部页文本，agent 直接读 docCache |
| `PdfExtractScope`（load/agent 双 scope） | `pdf.rs` | 只剩一次整档解析，不再需要分 scope 的取消代际 |
| `SINGLE_PAGE_FULL_EXTRACT_MAX` 及单页提取分支 | `pdf.rs` | 单页路径消失 |

保留 `pdfjs-dist`：它负责渲染、缩略图、文本层选择，与文本提取无关。

---

## 3. 能力矩阵：每项上游能力对应一个产品功能

| # | pdf-inspector 能力 | PageWise 产品功能 | 状态 | 成本 |
|---|---|---|---|---|
| 1 | 逐页 Markdown（标题/列表/代码/粗斜体/断词修复/去页码） | 文档文本升级为结构化 | V2 实测 +39% 文本 | 换引擎即得 |
| 2 | 表格识别 | 消除 `1,2841,141` 式数字粘连 | V3 实测 | 同上，零成本 |
| 3 | 字体大小推断标题 | **无书签文档的章节导航** | V12：117 页教科书 0 书签，L1 与书本目录逐条命中 | 一个正则 |
| 4 | `ItemType::Link(url)` + bbox | 预览里可点击的链接；agent 回答可引用外链 | 本轮实测：2 个链接含 url 与 bbox | 模型里带出来即可 |
| 5 | `ItemType::Image` + bbox | **图区裁剪送 vision** —— 只发图不发整页 | 本轮实测：bbox 正确 | 复用现有 `renderPageToJpegBytes`，换个裁剪框 |
| 6 | 区域文本 / 区域表格提取 | **框选提问**（`useAskSelection` 升级） | V8 实测可用 | 新增 1 个命令 |
| 7 | `extract_tables_with_structure_cells_mem` | agent 对表格做算术；表格导出 CSV | **未实测**，列为待验证 | 待评估 |
| 8 | `pdf_type` / `confidence` / 1 ms 扫描件判定 | 打开即告知"本文档 N 页需视觉索引，约 X 次调用" | V5 实测 1 ms | 模型字段直出 |
| 9 | `PdfOptions.password` | 加密 PDF 输入密码（今天只试空密码） | 未实测 | 一个输入框 |
| 10 | `MarkdownProfile::Compact` | 长文档省 token 的开关 | V13（源码确认） | 一个设置项 |
| 11 | 逐页 `needs_ocr` + 原因 | vision 队列选页依据；失败页显示原因 | V1/V10 | 模型字段直出 |
| 12 | 整档 Markdown | **一键导出为 Markdown** | 现成 | 纯前端 |

诚实标注：#7、#9 本轮未实测，落地前需先验证；其余均有本轮实测支撑。

---

## 4. 产品上最值得做的三件

**① 章节导航（#3）** —— 影响最大。今天 agent 面对无书签文档只能看"每页字符数 + 前 160 字预览"，定位"第 2.3 节"靠盲扫。合成大纲让 `document_outline` 返回真实章节树，agent 从盲扫变成定位。实测 L1 标题与页码全中。

**② 图区裁剪送 vision（#5）** —— 今天 vision 索引把**整页**渲染成 1568px JPEG 发出去。有了图区 bbox，一页里只有插图需要视觉理解时，可以只发那块。更省、更准、更快。

**③ 框选提问（#6）** —— 用户框住一张表格直接问，区域表格提取会直接返回 Markdown 表格，而不是把整页文本塞进上下文。

---

## 5. 必须挡在适配层内的四个上游坑

全部实测确认，是"只放一个适配层文件"的核心理由：

| 坑 | 实测 |
|---|---|
| `pages[].page` 是 **0-based** | V4 |
| `pages_needing_ocr` 是 **1-based**（与上一条同属一个结构） | V4 |
| 区域 API 的 `page_regions` 页号是 **0-based** | V10 |
| `extract_text_with_positions_*_pages` 的页过滤是 **1-based** | 本轮：传 `{0}` 得 0 个 item，传 `{1}` 得 12 个 |
| **坐标系分歧**：`TextItem.y` 是**左下原点**（标题 y=737.2 / 页高 792），区域 bbox 是**左上原点** | V8 + 本轮 |

对外只暴露：页号 1-based、坐标左上原点。适配层再加一条健全性校验（`pages.len() == page_count`），不一致则整体失败并退回明确错误，不猜。

另两条约束：**无取消 API**（超阈值文档不走新路径）、**`catch_unwind` 保留**（`lopdf` panic 面仍在）。

---

## 6. 版本策略：不固化

```toml
pdf-inspector = "0.1"
```

依据 V9：0.1.0→0.1.7 **API 零破坏**，而本次依赖的乱码自报能力 **0.1.0 根本没有**（0.1.3 出现、0.1.5 完整）—— 固化版本等于主动放弃能力增长。风险在行为漂移不在编译，防线是**行为黄金夹具**（容差断言：markdown 长度 ±15% 的改进不该让 CI 变红；但"表格数字粘连"或"扫描件不再被识别"必须变红）。可重现性交给已入库的 `Cargo.lock`。上游无 Release Notes，夹具是唯一判据。

---

## 7. 代价与未获证实的收益

**代价（实测）**：数学符号密集页经区域路径取回时符号退化（`Zn → Hn` 变 `Zn! Hn`、`Bn−1` 减号丢失），这几页 `pdf-extract` 更准。删掉它就接受这个回退。二进制 +~5 MB，冷编译 +40 s，峰值内存 48→54 MB。

**不成立的收益**：我原本预期"提取更好 → 少花 vision 钱"。实测在 `paper.pdf` 上，按现有 20 字符阈值，两个引擎需要 vision 的页数**都是 0**，省钱一说在本样本上没有证据，不列为收益。真正省钱的是 #5 图区裁剪（发更小的图）。

---

## 8. 前端配套

| 文件 | 改动 |
|---|---|
| `src/lib/page-text-merge.ts` | 引入 `PageText.source`，vision 恒胜 native。**这是现存缺陷**：Markdown 天然更长，现有"取更长者"规则会让原生文本覆盖已付费的 vision 文本 |
| `src/document/search.ts` | ⌘F 前 markdown→plain 归一化 |
| `src/lib/agent.ts` | `document_outline` 用模型里的 `outline`（文档自带书签优先，缺失时用合成 —— 一行规则） |
| `src/lib/load-document.ts` | 一次 `open_document` 取代逐页提取 |
| `src/document/index-queue.ts` | 选页依据换成 `needs_vision` |
| `src/i18n/locales/{en,zh-CN}.json` | 新增文案 |

---

## 9. 落地顺序

1. 黄金夹具（**先建防线**）
2. `inspect.rs` 适配层 + `open_document`，`pdf.rs` 换引擎，删除 §2 清单
3. `pickBetterPageText` 的 `source` 修正 + 搜索归一化（这两条不做，前两步的收益会被吃掉）
4. 章节导航（#3）
5. 图区裁剪送 vision（#5）
6. 导出 Markdown（#12）、扫描件成本预告（#8）
7. 框选提问（#6，新增命令，独立评估）
8. 待验证项：结构化表格（#7）、加密 PDF（#9）

**回退**：适配层失败即返回错误，不做静默降级 —— 不考虑历史兼容意味着不保留双引擎。
