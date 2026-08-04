# 第八次挖掘 pdf-inspector：三个候选，全部被自己的实测否掉

日期：2026-08-04 ｜ 基线：5.2.0（已发布）
实测编号接续 `2026-08-04-pagewise-v5.2-review.md`（V1–V36）。

---

## 0. 结论

**上游仍是 0.1.7**（第七次检查，与 4.0 集成时同一版本）。

本轮直接读了 crate 源码，不再只看文档，找出**四类我们从未消费的数据**。逐个实测之后：**没有一个值得上线。** 三个的失败原因都是同一个——**信号存在，但精度不够，报给用户或模型会是假话。**

这不是"没找到"，是"找到了并且证伪了"。下面每条都有数字。

---

## 1. 结构化表格 API 其实够得着，但仍然需要外部模型 · V37

4.0 时我写的是"结构化表格需要 TSR 模型"，当时是从文档推断的。本轮读源码，`extract_tables_with_structure_auto_mem` **确实是 crate 根上的公开函数**，够得着——但它的输入 `TsrTableInput` 自带答案：

```rust
/// Raw structure tokens emitted by the TSR model, in document order.
pub structure_tokens: Vec<String>,
/// One bbox per cell … in crop image-pixel space.
pub cell_bboxes: Vec<Vec<f32>>,
```

函数文档标题是 *"Extract structured cells using **externally-supplied** structure recovery"*。它做的是"给定模型输出的单元格结构，把 PDF 文字灌进去"，模型本身不在这个 crate 里。

**原结论成立，但依据从推断升级为源码。**

---

## 2. `extract_pages_markdown` 的返回值里有五个字段我们丢掉了 · V38

我们只取 `.pages`。完整的 `PagesExtractionResult` 还有：

```rust
pub pages_with_tables: Vec<u32>,
pub pages_with_columns: Vec<u32>,
pub pages_needing_ocr: Vec<u32>,
pub ocr_reasons_by_page: Vec<PageOcrReasons>,
pub is_complex: bool,
// 以及每页的 PageMarkdown.ocr_reason
```

零解析成本——这些数据每次开文档就已经在手里了。逐个查了。

### 2.1 `pages_with_columns` —— 实测 2/2 假阳性，不能用

`paper.pdf` 117 页里标了 **24 页（21%）**是多栏。多栏页恰恰是提取顺序最容易串行的地方，把它报给模型看上去很有价值。

抽两页读了：

- **第 26 页**：`# Übungsaufgaben` / `## Aufgabe 1` / `(a)…(b)…(c)…` —— 阅读顺序**完全正常**，所谓"两栏"是 (a)(b)(c) 的题号排布
- **第 111 页**：整页单栏散文，**没有任何分栏**

2 抽 2 假。按 21% 的标记率，把它交给模型等于在五分之一的页面上说"这一页的阅读顺序可能不可靠"——而实测它是可靠的。**降低模型对正文的信任，换不来任何真实的提醒。不做。**

### 2.2 `pages_with_tables` —— 与我们自己算的不是一回事，也不更好

```
上游（按 re 算子画出的边框，rect > 6）  [12, 13, 18, 19, 20, 21, 23, 29 …]
我们（markdown 里出现 |---）           [12, 18, 19, 20, 21, 29, 30, 31 …]
```

两边互有出入。但两者回答的不是同一个问题：上游答"这页画了表格边框"，我们答"这页的文本被渲染成了 Markdown 表格"。而 `has_table` 的用途是**告诉模型别把这段文字重排**——那正是我们这一版的语义。**上游的不是更好的答案，是另一个问题的答案。不换。**

### 2.3 `ocr_reason` —— 唯一有内容的，但 1/2 正确

`paper.pdf` 上有两页带原因，都是 `suspected_garbled_text`：

| 页 | 上游判断 | 我们恢复出来的实际内容 |
|---|---|---|
| 4 | 疑似乱码 | 目录页，点线导页符 —— **完全可读**，闸门误伤（4.0 已记录） |
| 46 | 疑似乱码 | `an= dimZn+ dimBn 1für n 1` —— 数学下标被压平，**确有降级** |

一对一错。把它当作"这一页可能是乱码"提示给用户，会在目录页上撒谎。**证据不足以上线**；如果哪天要做"为什么这页读不出来"的解释，这是唯一的原料，但需要先在更多文档上验精度。

---

## 3. `TextItem` 上有六个字段我们从未读过 · V39

```rust
is_bold, is_italic, is_underline, is_strikeout, font, font_size, mcid
```

其中 **`is_strikeout` 看上去最有价值**：Markdown 输出里**从来不发射删除线**（全仓检索 crate 源码，`~~` 只出现在表格解析和测试里，没有任何发射逻辑；`is_underline` 则会被发射成 `<u>`）。也就是说——**被划掉的文字，在提取结果里和正常文字一模一样**。合同、修订稿里，这是把已删除条款当作现行条款读。

听起来是个严重问题。实测 `paper.pdf` 的 7 处：

```
p29  "P"
p29  "P"
p82  "0"
p83  "0"
p86  "0"
p87  "0"
p82  "0"
```

**7/7 全是假阳性。** 全部是单字符：`ℙ`（黑板粗体 P，本身带一竖）和 `∅`（空集，本身就是一个被斜杠划穿的 0）。删除线是**几何检测**的——找压在字形中线上的细矩形——数学符号自带的那一笔正好落在窗口里。

我手上没有真正含删除线的文档，所以**真阳性率无从测起**；而在唯一一份有分量的真实文档上它 100% 假阳。上线的话，读者会被告知 `∅` 和 `ℙ` 是被删掉的内容。**不做。**

（`font_size` 或许能改进大纲合成，但提取器已经按字号把行提升成了 `#`，我们用的就是它的结论，再自己算一遍是重复劳动。）

---

## 4. `ItemType::FormField` 我们在 `collect_positions` 里丢掉了

`_ => {}` 那一支吃掉了它。但 4.0 已经验证过表单字段会走 markdown 正文路径出现，所以位置信息换不来新能力。维持原状。

---

## 5. 唯一剩下的线索：按页提取（不是能力，是性能）

`extract_pages_markdown(path, Some(pages))` 支持只提取部分页；`PdfInspector` 构建器还有 `.pages()` / `.mode()`。我们一直传 `None`，开文档即全量提取。

实测代价：`paper.pdf` 117 页 **816 ms**（release）。线性外推，1000 页文档约 7 秒的阻塞。

这不是新能力，是一个**将来文档变大时才成立的性能选项**。现在做属于为不存在的问题优化。记录在案。

---

## 6. 本轮实测

### V37：结构化表格 API 可达，但输入来自外部模型

```
extract_tables_with_structure_auto_mem  是 crate 根上的 pub fn
TsrTableInput.structure_tokens          "Raw structure tokens emitted by the TSR model"
函数文档                                 "using externally-supplied structure recovery"
```

### V38：`PagesExtractionResult` 的五个未消费字段

```
paper.pdf
  pages_with_columns   24/117 页（21%）→ 抽查第 26、111 页，2/2 假阳性
  pages_with_tables    上游 [12,13,18,19,20,21,23,29…] vs 我们 [12,18,19,20,21,29,30,31…]
  pages_needing_ocr    [4, 46]
  ocr_reason           两页均为 suspected_garbled_text
                       → p4 目录页完全可读（误伤）、p46 数学下标压平（确有降级）＝ 1/2
  is_complex           true
```

### V39：`is_strikeout` 存在，但 markdown 从不发射，且实测全假阳

```
crate 源码中 "~~" 的发射逻辑：无（仅出现在 tables 解析与测试）
"<u>" 的发射逻辑：有（markdown/mod.rs:869）

paper.pdf  strikeout 7 / 23,146 项
  p29 "P" ×2   p82 "0" ×2   p83 "0"   p86 "0"   p87 "0"
  → 7/7 为 ℙ 与 ∅ 的自带笔画，假阳性
```

### V40：上游未发新版（第七次）

```
cargo search pdf-inspector → 0.1.7，与 4.0 集成时相同
Cargo.lock 锁定 0.1.7
```

---

## 7. 判断

第八轮了。这一轮和前几轮的区别是：**以前是"文档里没有更多能用的"，这次是"源码里还有东西，但拿实测一量就不能用"。**

三个候选各自的否定理由不同，但形状一样——**信号存在、精度不够**。把它们上线不会让产品更好，只会让它更爱撒谎。

`pdf-inspector` 这条线我认为可以正式收尾了。它已经完整地做了它该做的事：把 PDF 变成可读的文本、位置、链接、图。剩下的都在"需要一个模型"或"需要一份我没有的验证数据"的另一边。
