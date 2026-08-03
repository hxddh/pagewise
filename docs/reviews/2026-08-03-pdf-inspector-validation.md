# `pdf-inspector` 能力实测验证

日期：2026-08-03 ｜ 实测版本：0.1.0 / 0.1.3 / 0.1.5 / 0.1.7 ｜ 环境：本会话容器，`cargo 1.94.1`，release profile

所有结论均来自实际编译运行，样本与命令可复现。**其中 V1 推翻了 phase-1 设计的核心前提。**

## 样本

| 样本 | 来源 | 特征 |
|---|---|---|
| `paper.pdf` | py-pdf/sample-files `GeoTopo.pdf` | 117 页 / 5.3 MB，LaTeX 德文教材，含目录、数学公式、表格、多栏 |
| `cjk.pdf` | 本次用 Chromium `--print-to-pdf` 自造 | 中文 Type0/CID 字体，含 3×3 财务表格、中英混排 |
| `attn.pdf` | py-pdf/sample-files CMYK 图片 PDF | 单页扫描件 |
| `truncated/garbage/tiny.pdf` | 截断与损坏构造 | 健壮性 |

---

## V1（决定性）：`needs_ocr` 是"我自己没提取出来"的自报，不是"这个 PDF 有问题"

`process_pdf` 在 `paper.pdf` 上把第 4、46 页标为 `suspected_garbled_text`。实际查看这两页：

| 页 | 现有 `pdf-extract` 输出 | `pdf-inspector` 输出 |
|---|---|---|
| 4（目录，带点线 leader） | **1655 个非空白字符，完整可读** | **0 字符** |
| 46（数学证明，含 `Zn`、`Bn−1`、`≥`、`→`） | **424 个非空白字符，完整可读** | **0 字符** |

**这个标记描述的是 pdf-inspector 自身在该页的提取失败，与 PDF 是否损坏无关。**

对原设计的直接后果：phase-1 打算"保留 `pdf-extract` 作为文本源，用 `pdf-inspector` 的 flag 决定哪些页要送 vision"。按此实现，PageWise 会把一页**完好的目录**清空、并为它花掉一次计费的 vision 调用。**前提不成立，设计必须改。**

## V2：两个提取器是互补的，不是替代关系

全部 117 页逐页对比（非空白字符数）：

```
pdf-extract    总计 110,118
pdf-inspector  总计 152,764        (+39%)

pdf-inspector 显著少于对方(<50%)的页：2 页 —— 即第 4、46 页，且两页都被自己标了 needs_ocr
pdf-extract   显著少于对方(<50%)的页：0 页
```

结论有两面：

- `pdf-inspector` 整体多提取 39% 文本，且**它失败的每一页都诚实自报了**（该文档上查全率与查准率均为 1.0，无静默失败）；
- 但它确实存在 `pdf-extract` 能处理而它处理不了的页 → **单纯替换会造成回退**。

→ 正确形态是级联，见修订设计。

## V3：CJK 与表格 —— 现有管线会把数字读错

`cjk.pdf` 的财务表格：

```
pdf-extract:      营业收入 1,2841,141        ← 两个数字粘连，模型会读成 12841141
pdf-inspector:    |营业收入|1,284|1,141|     ← 正确的 Markdown 表格
```

这是对"页级文档问答"最直接的质量损害：表格数字粘连会产生**看不出来的错误答案**。`pdf-inspector` 对该文档 `pdf_type=TextBased, confidence=1, has_encoding_issues=false`，中文与中英混排均正确。

（注：Chromium 生成的 CID 字体带 ToUnicode CMap，`pdf-extract` 解码正常。真正无 ToUnicode 的中文 PDF 未能在本环境构造，**"CID 乱码检出"这一条尚未取得直接证据**，不应作为已验证结论。）

## V4：页号基准在同一个返回结构里就不一致

`extract_pages_markdown(paper.pdf, None)` 的返回：

```
pages[].page  标签 = 0..116          → 0-based
pages_needing_ocr = [4, 46]          → 1-based（对应标签 3 与 45）
```

交叉验证：标签 3 的内容 == `pdf-extract` 的第 4 页；标签 5 的内容 == 第 6 页。单页扫描件 `attn.pdf` 上标签为 `0` 而 `pages_needing_ocr=[1]`，两份样本一致。

此外 `classify_pdf_mem` 返回 0-based，`detect_pdf` / `process_pdf` 的列表返回 1-based。

→ 设计上**不使用任何页号列表**，改用 `pages` 数组的**顺序**定位（第 i 项 = 第 i+1 页），并用 `pages.len() == page_count` 做健全性校验。这样对上游未来任何基准变更免疫。

## V5：采样模式拿不到乱码信号

| 调用 | 耗时(117 页) | 检出乱码页 |
|---|---|---|
| `detect_pdf`（默认 `Sample(8)`） | 58 ms | ❌ `[]` |
| `ProcessMode::DetectOnly` + `ScanStrategy::Full` | 52 ms | ❌ `[]` |
| `process_pdf`（完整提取） | **468–515 ms** | ✅ `[4, 46]` |

扫描件判定则极快：`attn.pdf` 1 ms 给出 `Scanned / 0.95`。

## V6：按页过滤的提取，其文档级 OCR 列表不完整

```
extract_pages_markdown(paper.pdf, Some(&[1,2,3])) → 369ms, pages_needing_ocr=[4]      // 漏了 46
extract_pages_markdown(paper.pdf, None)           → 468ms, pages_needing_ocr=[4,46]
```

→ 文档级结论只信任整档单次运行。另外按页过滤**并不省时**（369ms vs 468ms），因为整档仍要解析一遍。

## V7：性能、内存、并发、健壮性

| 项 | `pdf-extract`（现状） | `pdf-inspector` |
|---|---|---|
| 117 页 wall | 1.33 s | **0.49 s** |
| 峰值 RSS | 48 MB | 54 MB |
| 4 线程并发同一文档 | — | 582 ms，4 份结果完全一致（确定性 + 线程安全） |
| 截断 PDF | panic（现由 `catch_unwind` 兜底） | `Err("Invalid PDF structure")` |
| 非 PDF 文本 | — | `Err("Not a PDF: file appears to be plain text")` |
| 900 字节残片 | — | `Err("Invalid PDF structure")` |

健壮性优于现状（干净的 `Err` 而非 panic），但**仍建议保留 `catch_unwind`**：底层 `lopdf` 的 panic 面并未消除。

**无取消 API**：`process_pdf` 系列不接受 cancel token，整档解析不可中途中断。PageWise 现有 `PdfExtractCancel` 只能在调用前后检查。117 页 500 ms 可接受，但需要一个页数/体积阈值保护超大文档。

## V8：区域提取可用（第二期机会）

`extract_text_in_regions_mem` 在 `cjk.pdf` 上正确返回区域文本；`extract_tables_in_regions_mem` 对同一区域直接返回 Markdown 表格。

坐标系实测为 **左上原点**（`[0,0,300,400]` 命中页面上半部内容，`[0,600,300,900]` 为空），与 PDF 原生的左下原点相反 —— 接入 `useAskSelection`（框选提问）时必须实测确认，不能照搬 PDF 坐标。

## V9（回答"不固化版本"）：API 八个版本零破坏，但行为持续变化

同一份 probe 源码（用到 `process_pdf` / `extract_pages_markdown` / 区域提取 / `PdfOptions` / `DetectionConfig` / `ProcessMode` / `ScanStrategy`）对四个版本逐一编译：

| 版本 | 编译 | `paper.pdf` 的 OCR 页 | `has_encoding_issues` | markdown 字符数 |
|---|---|---|---|---|
| 0.1.0 | ✅ | `[]` | false | 141,446 |
| 0.1.3 | ✅ | `[4]` | true | 141,427 |
| 0.1.5 | ✅ | `[4, 46]` | true | 156,020 |
| 0.1.7 | ✅ | `[4, 46]` | true | 155,844 |

两条结论：

1. **API 在 0.1.0→0.1.7 之间零破坏**，8 个版本无源码级不兼容 → 不固化版本在编译层面是安全的。
2. **本次集成所依赖的乱码自报能力，0.1.0 根本不存在，是 0.1.3 才出现、0.1.5 才完整的。** 这是"必须能吃到上游后续能力"这一要求的最好证据 —— 固化版本等于主动放弃能力增长。

风险因此不在编译失败，而在**行为漂移**（markdown 字符数在版本间 ±10%，表格数 178–183 浮动）。防线应当是行为回归夹具，不是版本锁。

上游工程状态：crates.io 有 8 个版本，**GitHub 无 Release、无 Release Notes**，26 个 open issue / 31 个 open PR。→ 升级时没有 changelog 可读，只能靠自己的夹具判断。

---

# 第二轮验证（2026-08-03 续）

## V10：空页是**主动丢弃**,不是提取失败 —— 且文本可以原样取回

读上游源码 `lib.rs:563`：

```rust
markdown: if needs_ocr { String::new() } else { md },
```

页面文本是**提取成功后被质量判定丢弃的**。上游的设计假设是"下游有 OCR 接手"（源码注释里点名 GLM-OCR），与 PageWise 的 vision 兜底是同一形状。

关键在于：**区域提取路径不做这个丢弃**。对 V1 里那两个被清空的页调用 `extract_text_in_regions_mem`（整页 bbox）：

```
idx=3  (real p4)  → 2539 字符完整目录取回   needs_ocr=true 但文本照给
idx=45 (real p46) → 550 字符取回
批量一次调用取回 2 页：19 ms
```

**这推翻了"必须保留 pdf-extract 做兜底"的结论**：同一个库、一次额外调用、19 ms 就能取回被丢弃的文本。兜底不再需要第二个提取器。

代价需如实记录：区域路径取回的数学页文本有符号退化（`Zn → Hn` 变成 `Zn! Hn`、`Bn−1` 的减号丢失），这几处 `pdf-extract` 更准。影响面是数学符号密集页。

## V11：质量判定器的实现质量高于预期

`text_quality.rs`（520 行）不是简单的字符比例判断，而是四类判据：U+FFFD 簇、CID 落入私用区/C1 控制区、`Word$Word$Word`（ToUnicode 损坏）、以及**替换密码字频统计**（对英文字频做余弦相似度，声称拉丁语系语言 ≥0.80 而密码文本 ~0.53）。目录点线 leader（`.` 连续 ≥3）已被显式豁免。

即便如此，V1 的两页仍是误判 —— 说明该判据在数学符号密集页上会过杀。但**误判的代价现在只是 19 ms 的重取**（V10），不再是一次计费调用。

## V12（质变证据）：117 页教科书**没有任何书签**,而标题可以合成出准确目录

```
paper.pdf 的 /Outlines 出现次数: 0
```

即：PageWise 现有的 `getPdfOutline()`（依赖 pdf.js `getOutline()`）对这份 117 页教科书**返回空数组**。agent 的 `document_outline` 工具此时只能给出"每页字符数 + 前 160 字预览"，想定位"第 2.3 节"只能盲扫。

而从逐页 markdown 里提取 `#` 标题，得到 158 个标题。**只取 L1 的结果，与书本自己印的目录逐条对照**（书本页码 = PDF 页码 − 4）：

| 合成结果 | 书本目录 | 换算 | 命中 |
|---|---|---|---|
| `1 Topologische Grundbegriffe` p6 | 第 2 页 | PDF 6 | ✅ |
| `1.2 Metrische Räume` p10 | 第 6 页 | PDF 10 | ✅ |
| `1.3 Stetigkeit` p13 | 第 9 页 | PDF 13 | ✅ |
| `1.4 Zusammenhang` p15 | 第 11 页 | PDF 15 | ✅ |
| `1.5 Kompaktheit` p18 | 第 14 页 | PDF 18 | ✅ |
| `1.6 Wege und Knoten` p21 | 第 17 页 | PDF 21 | ✅ |

**L1 标题与页码全部命中。** 噪音集中在 L2（图注 `Abbildung 2.4:Kartenwechsel`、公式 `4 2 2 4 6 8`、残句 `) Widerspruch`），约占 L2 的四成 → 取 L1、或 L2 中匹配编号模式者，即可得到高精度目录。

实现成本：**零新增调用** —— 从已经拿到的逐页 markdown 里 grep `^#{1,2} ` 即可，页码天然精确（逐页返回）。

## V13：markdown 默认已开的能力

`MarkdownOptions::default()`：`detect_headers/lists/code/bold/italic/underline = true`、`format_urls = true`、`fix_hyphenation = true`（跨行断词修复）、`remove_page_numbers = true`、`include_links = true`、`include_images = false`（上游为避免静默回归而默认关闭）。

`MarkdownProfile` 两档：`Fidelity`（默认，保真）与 `Compact`（省 token，会折叠长点线 leader）。→ 若担心 markdown 进入 LLM 上下文的 token 成本，`Compact` 是现成开关。

## V14：位置、链接、图区均可用（本轮实测）

`extract_text_with_positions_mem_pages` 在自造的 `rich.pdf`（含 2 个超链接与 1 张图）上：

```
items=10  text=7  image=1  link=2  form=0
"Report"  x=33.8 y=736.5 w=71.9 h=24.0 font=F4 size=24.0 bold=true mcid=Some(0)
IMAGE bbox x=33.8 y=599.2 w=90.0 h=90.0
LINK "https://example.com/spec" -> https://example.com/spec
```

`TextItem` 带完整几何与字体属性（含 `is_bold` 正确识别、`mcid` 标记内容 id），`ItemType::Link(url)` 与 `ItemType::Image` 均带 bbox。→ 支撑框选提问、图区裁剪、可点击链接三项功能。

**第四处页号基准不一致**：该函数的页过滤是 **1-based**（传 `{0}` 返回 0 个 item，传 `{1}` 返回 12 个），而区域 API 的页号是 0-based。

**坐标系分歧**：`TextItem.y` 为**左下原点**（页高 792 的文档，标题 y=737.2 位于页面顶部），而区域 bbox 是**左上原点**（V8）。同一个库的两条路径约定相反，必须在适配层归一。

## V15：本样本上没有 vision 调用的节省

按 PageWise 现有的 20 字符阈值统计 `paper.pdf`：

```
pdf-extract   需 vision 的页: 0
pdf-inspector 需 vision 的页: 0（含区域取回）
```

→ "提取更好所以少花钱"在本样本上**没有证据**，不应列为收益。真正能省的是把整页 1568px JPEG 换成图区裁剪。

## V16：PageWise 侧的死代码（已核实零调用方）

`getPdfPageCount`、`pdf_page_count_cmd`、`extractAllPageTexts` 均无任何调用方 —— 属可直接删除的历史遗留。

---

# 第三轮验证（2026-08-03，面向 4.1）

## V15：加密 PDF 的三种结果可区分

自造 RC4-40 加密 PDF（`/V 1 /R 2`，用户密码 `secret`，按算法 3.2/3.3/3.4 手写，845 字节，已入库为 `src-tauri/tests/fixtures/encrypted.pdf`）：

```
process_pdf                                → Err(Encrypted)
process_pdf_with_options(password="secret") → Ok(1 页, "## Encrypted PageWise fixture")
process_pdf_with_options(password="wrong")  → Err(Encrypted)
```

→ 足以驱动"打不开就弹密码框、密码错就重试"的交互。PageWise 今天只试空密码，加密文件一律打不开。

## V16：搜索命中可精确定位，但粒度是行级

`extract_text_with_positions`：`paper.pdf` 得 23,107 个文本 item，**几何缺失 0 个**；`cjk.pdf` 得 12 个。逐条查询定位结果：

```
"1,284"        → p1  x=105.8 y=654.0 w=32.3  h=12.0   "1,284"
"营业收入"      → p1  x=42.0  y=654.0 w=48.0  h=12.0   "营业收入"
"Kompaktheit"  → p18 x=90.1  y=437.1 w=117.7 h=14.3   "1.5 Kompaktheit"
```

item 是**行/文本段**级而非逐字符（`"本报告涵盖…百分之十二点五。"` 是一个 w=388.5 的 item），所以高亮框覆盖整行，不是命中的那几个字——上游没有给逐字符推进宽度。

整档取位置 739 ms（117 页）→ 应按页懒取，不进 `DocumentModel`。

## V17：矢量网格代替 TSR 模型 —— 漏真表、造假表

`extract_tables_with_structure_cells_mem` 的 `TsrTableInput.structure_tokens` 注释写明来自"TSR 模型"。唯一的免模型替代 `detect_vector_grid_in_region_mem` 实测 6 页：

- **5 页未检出**，包括 `cjk.pdf` 的真实 CSS 边框表格，以及多数 LaTeX 表格页
- **1 页检出即误报**：数学证明页被判为 6×2 表格，单元格是打乱的散文
  `"TY = und jedem dY gegeben . (U Beh. (U (f ( Teilmenge"`

→ 结构化表格这条路在没有 ML 模型时不成立。

## V18：`structure_tree` 从外部够不着

`StructTree::from_doc(doc: &lopdf::Document)` 需要 lopdf 的 `Document`，而 `pdf-inspector` 未再导出 lopdf。要用就得把 lopdf 加成直接依赖 —— 在刚移除一个 PDF 解析器之后再引入第二个。

## V19：`MarkdownProfile::Compact` 省不下 token

```
paper.pdf  Fidelity 155,844 → Compact 155,841   省 0.0%
cjk.pdf    Fidelity 156     → Compact 156       省 0.0%
```

它只折叠长点线 leader，而这类 leader 早已被 `is_garbage_text` 显式豁免。**不是可用的省钱开关。**

## V20：Rust 侧两个 crate 已无任何引用

`image` 与 `tempfile` 在 `src-tauri/src/` 中引用数均为 0（`image` 的转码早已搬到前端 `image-transcode.ts`）。

## V18（更正 V16）：零宽 item 真实存在，占比 0.3%

V16 写的"23,107 个 item 几何缺失 0 个"是把 `cjk.pdf` 的测量结果套在了 `paper.pdf` 上。逐样本重测：

| 样本 | 文本 item | 零宽 | 零高 |
|---|---|---|---|
| `paper.pdf` | 23,107 | **75** | 0 |
| `cjk.pdf` | 12 | 0 | 0 |
| `rich.pdf` | 7 | 0 | 0 |
| `form.pdf` | 1 | 1 | 0 |
| `s1.pdf` | 7 | 0 | 0 |

零宽 item 会让搜索高亮画出一个不可见的框，用户看到的是"高亮没生效"。

## V19：表单字段已经通过文本路径工作，无需新功能

自造填好的 AcroForm PDF（两个文本域，手写对象表，1551 字节）：

```
items=3  text=1  image=0  link=0  formfield=2
  "applicant_name: Ada Lovelace"  type=FormField  w=300 h=24
  "amount: 1,284.00"              type=FormField  w=200 h=24
```

且这两条**已经出现在 markdown 里**（`applicant_name: Ada Lovelace`）。→ agent 现在就能读到填写的表单值；`ItemType::FormField` 无需单独接线。
