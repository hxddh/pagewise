# 设计方案（第三版·极简）：换引擎，不换架构

日期：2026-08-03 ｜ 基线：PageWise v3.6.1
证据：`docs/reviews/2026-08-03-pdf-inspector-validation.md`（V1–V13，均可复现）

> 版本演进：初版"用 flag 决定送 vision"被 V1 推翻；二版"pdf-inspector + pdf-extract 级联"被 V10 推翻 —— 被丢弃的文本用同一个库、19 ms 就能取回，不需要第二个提取器。**本版是最简形态。**

---

## 1. 架构：概念数量不增加

现状与改动后的对比：

```
现状：   pdf-extract  ──► docCache.pages(纯文本) ──► 空页 ──► vision 队列
改动后： pdf-inspector ─► docCache.pages(Markdown) ─► 空页 ──► vision 队列
```

**层数不变、概念不变、前端数据流不变。** 只是把 Rust 里的提取引擎换掉，顺带在同一个函数里多一次 19 ms 的补取调用。

`src-tauri/src/pdf.rs` 内部（Tauri 命令签名与返回结构**完全不变**）：

```rust
// 原来：逐页 output_doc_page(...) 循环
// 现在：
let r = extract_pages_markdown(path, None)?;              // 整档一次，~0.5s（比原来的 1.33s 更快）
let mut pages: Vec<String> = r.pages.iter().map(|p| p.markdown.clone()).collect();

// 被质量判定丢弃的页，用区域路径原样取回（V10：批量一次调用 19ms）
let flagged: Vec<usize> = r.pages.iter().enumerate()
    .filter(|(_, p)| p.needs_ocr).map(|(i, _)| i).collect();
if !flagged.is_empty() {
    for (i, text) in recover_by_region(bytes, &flagged)? { pages[i] = text; }
}
// 仍为空的页 → 前端现有 vision 队列接手，零改动
```

`pdf-extract` **移除**。依赖树是净减少一个提取器，不是净增加。

代价如实记录（V10）：数学符号密集页经区域路径取回时符号会退化（`Zn → Hn` 变 `Zn! Hn`），这几处 `pdf-extract` 更准。用一个提取器换 +39% 文本量与正确表格，我认为值；若不接受，保留 `pdf-extract` 专做这一步也可以，但那就多一个依赖。

### 两个必须绕开的上游坑（都在适配层内解决，不外溢）

- **页号基准在同一结构里不一致**（V4：`pages[].page` 0-based，`pages_needing_ocr` 1-based）→ 只按 `pages` 数组**顺序**定位，不读任何页号列表；用 `pages.len() == page_count` 做健全性校验，不一致则整体返回 `None`。对上游未来改基准免疫。
- **无取消 API**（V7）→ 超过页数/体积阈值时不走新路径。`catch_unwind` 保留。

**回退开关**：适配层恒返回 `None` → 立刻退回 v3.6.1 行为。

---

## 2. 版本策略：不固化，用行为夹具兜底

依据 V9：0.1.0→0.1.7 **API 零破坏**，但行为持续变化，且本次要用的乱码自报能力 **0.1.0 根本不存在**（0.1.3 出现、0.1.5 完整）。固化版本 = 主动放弃能力增长。

```toml
pdf-inspector = "0.1"    # 允许全部后续 0.1.x
```

四条配套：可重现性交给已入库的 `Cargo.lock`；调用面收敛在一个适配层；**行为黄金夹具**（三个小 fixture，容差断言 —— markdown 长度 ±15% 的改进不该让 CI 变红，但"`1,284` 与 `1,141` 粘连"或"扫描件不再被识别"必须变红）；一个不阻塞主 CI 的 `cargo update` 定时 job。上游**没有 Release Notes**（V9），夹具是唯一可信判据。

---

## 3. 由此解锁的产品质变

以下四项**都只消费上面已经拿到的 markdown**，不新增后端调用、不新增架构层。

### 3.1 无书签文档的章节导航（agent 能力质变）

V12 实证：117 页教科书 `/Outlines` 数量为 **0** —— PageWise 现有 `getPdfOutline()` 返回空，agent 的 `document_outline` 只能给"每页字符数 + 前 160 字预览"，想定位"第 2.3 节"只能盲扫。

从逐页 markdown 里 grep `^#{1,2} ` 得到 158 个标题，只取 L1 与书本自印目录**逐条对照、页码全部命中**。

这把 agent 从"盲扫"变成"按章节定位"，是本次集成对**回答质量**影响最大的一项，而实现只是一个正则。噪音集中在 L2（图注、公式残句），取 L1 或"L2 中匹配编号模式者"即可。

> 落地：`document_outline` 工具在 `bookmarks` 为空时回落到合成目录，字段结构复用现有 `PdfBookmark { title, page, level }` —— 工具契约不变。

### 3.2 表格保真（消除看不见的错误答案）

V3 实证：`营业收入 1,2841,141` → `|营业收入|1,284|1,141|`。数字粘连会让模型读出 `12841141` 且用户无从察觉。这是财报/合同类文档的硬伤。零额外成本，markdown 里已经是对的。

### 3.3 一键导出 Markdown

`pdf2md` 是上游的看家能力，markdown 已在手。PageWise 已有 `export-summary.ts` 的导出通路，加一个"导出文档为 Markdown"是纯前端小功能。

### 3.4 框选提问

V8 实证区域提取可用（**左上原点**，与 PDF 原生坐标系相反，接线时按实测来）。PageWise 已有 `useAskSelection` 入口，目前基于 pdf.js 文本层选择；改成框选一块区域直接取结构化文本（表格区域还能直接返回 Markdown 表格）。

这一项需要一个新的 Tauri 命令，是四项里唯一有增量的，建议排在最后、独立评估。

---

## 4. 收益与代价

| | |
|---|---|
| 打开 117 页文档 | 1.33 s → **~0.5 s** |
| 提取文本量 | **+39%** |
| 表格 | 消除数字粘连 |
| 无书签文档的章节树 | 从"没有"到"L1 全中" |
| 峰值内存 | 48 MB → 54 MB |
| 二进制体积 | +~5 MB |
| 冷编译 | +40 s |
| 数学符号密集页 | 个别符号退化（唯一的功能性回退） |

---

## 5. 前端配套（小、且必要）

| 文件 | 改动 | 原因 |
|---|---|---|
| `src/lib/page-text-merge.ts` | 引入 `PageText.source`，vision 恒胜 native | Markdown 天然更长，现有"取更长者"规则会让原生文本压过已付费的 vision 文本 —— 这是**现存缺陷**，不修则本次收益被吃掉 |
| `src/document/search.ts` | ⌘F 前做 markdown→plain 归一化 | 否则 `**` 与 `\|` 污染匹配与片段 |
| `src/lib/agent.ts` | `document_outline` 无书签时回落到合成目录 | 3.1 |
| `src/i18n/locales/{en,zh-CN}.json` | 新增文案 | — |

---

## 6. 落地顺序

1. 三个黄金夹具测试（**先建防线**）
2. 适配层 + `pdf.rs` 换引擎，命令签名不变 → 前端零改动即可跑通对比
3. `pickBetterPageText` 的 `source` 修正 + 单测
4. 搜索归一化
5. 合成目录接入 `document_outline`
6. 导出 Markdown
7. 框选提问（独立评估）
