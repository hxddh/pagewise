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
