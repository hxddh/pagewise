# v21 独立复核：先把数据、工具返回值和发布门修实，再谈下一个大版本

*2026-10-15。基线 main `5a5c18e`（`VERSION 20.0.0`，含两份 v21 评估稿）。*

*对象：[v21 方向评估](2026-10-15-pagewise-v21-next-major-review.md)、[v21 六个角度](2026-10-15-pagewise-v21-angles.md)，以及 20.0 的代码与发布记录。口径沿用那两稿：**实测** / **读代码**（`file:line`）/ **上游**（GitHub API 读到的）/ **未量**。*

## 0. 结论

1. **两份 v21 稿的局部审计大体可信，但有一处结论反了，并且漏了三条丢数据的路径、一条安全边界和整个发布流程。** 逐条核对 15 项代码断言：13 项成立，1 项部分成立，1 项错误（空白页，见 §1）。
2. **错的那一条恰好最贵。** 两稿都说空白页「不再被误标为预算用尽，只缺一句说明」（主稿 §1.7，补充稿 §5.1）。实际是：`read_pdf_range` 读到任何一页空文本，就以 `budgetExceeded` 和 `BUDGET_NOTE` 结束整个范围读，并告诉模型「停止阅读、直接作答」。所以扫描件上的全文问答只覆盖第一张空白页之前的页，而且没有任何提示。
3. **发布不受 CI 约束。** 17.0、18.0、19.0、20.0 四个大版本的发布提交在 main 上 CI 都是红的，发布照常完成，修复都在发布之后。`release.yml` 只由 tag 触发，没有任何 CI 依赖。
4. **产品信号几乎为零。** v20.0.0 的 6 个安装包合计下载 **1 次**（上游，GitHub API）；issue 0 个；`eval/baselines/` 不存在，也就是仓库里没有一份真实模型回答的记录。自 7 月 3 日的 0.1.0 起 104 天走到 20.0；自 13.0 起每一版都由上一版的评估稿驱动，没有一版来自用户的反馈。
5. **建议：v21 不当作功能大版本。** 它是一次「数据与诚实」版本：修 §2 的 P0，加上发布门；同时建立第一份真实模型基线，作为之后所有产品主张的分母。两稿的支点 A（复核结果持久化）和支点 B（扫描表格明说不承诺）保留，排在 P0 之后。

## 1. 对 v21 两稿的核对

| # | 断言 | 结论 | 依据 |
|---|---|---|---|
| 1 | 每条引文一次 `generateObject`，结果只存在内存 Map | 成立 | `claim-review.ts:41,111,156-163`；`document-scope.ts:65` |
| 2 | 页边列只收带 citation 的句子 | 成立 | `page-citations.ts:88-91` |
| 3 | `store_write_cmd` 不读旧文件；撕坏的 sidecar「下次编辑被盖掉」 | **部分成立** | 不读旧文件属实（`store_io.rs:127-147`）。但 body 只在新建 id 时写（`finding-bodies.ts:112-113`，`markBodyPending` 只由 `finding-store.ts:438` 调用），撕坏的 body 读回时被跳过（`:86-89`），不会被下一次编辑覆盖。验收 #9 的前提要改 |
| 4 | OCR 缓存与注释导出没有 fsync；`SECURITY.md:23` 写得比代码宽 | 成立 | `ocr_cache.rs:86-90`，`annotate.rs:265-272` |
| 5 | 本树没有代码读回 `index.newer` | 成立，**而且范围更大**，见 §2.2 | `store-migrate.ts:73-97` 是唯一触及该键的代码 |
| 6 | 缺 tesseract.js 时 `copy-ocr-assets` 仍 `exit 0` | 成立 | `copy-ocr-assets.mjs:30-33` |
| 7 | 空白页不再被标为预算用尽 | **错误** | 见下 |
| 8 | 提示词许诺的 `figures` 附件不存在 | 成立 | `agent.ts:162` 对 `result.ts:33-38` |
| 9 | 四个工具的步骤标签落到 default | 成立 | `tool-steps-summary.ts:49-50,100-101` |
| 10 | 红芯片仍调用 `onReveal`；`reviewable` 不收 `unlocated` | 成立 | `CitationChip.tsx:95-97`，`MessageAssistantFooter.tsx:322` |
| 11 | 停止条件写了两遍 | 成立 | `agent.ts:92,244` 对 `:389` |
| 12 | `longchatRequestBytesMax` 不在 `check()` 里；README 写的场景数不对 | 成立 | `perf-probe.mjs:95`；4 个场景、21 条 check，对 `README.md:65` |
| 13 | 文案仍指向已删除的「AI Provider」 | 成立 | `en.json:20,25-27` |
| 14 | `vitest.config.ts` 没有 include | 成立 | — |
| 15 | 单页文档 header 中间为空；Esc 退不出 Zen | 成立 | `WorkspaceHeader.tsx:124`；`useAppCommands.ts:211-216` 对 `commands.ts:71` |

**#7 的机制（读代码 + 一次临时单测实测）。** `affordableChars("")` 在 `estimateTokens("") === 0` 时返回 `text.length`，也就是 0（`reading.ts:97-102`）。于是 `budgetRoom = 0 − separator − header.length < 0`，并且 `limitedByBudget = budgetRoom <= maxRoom` 为真。`room <= 0` 分支（`reading.ts:586-592`）在推入正文（`:609`）之前就 `break`，带着 `budgetExceeded: true`。临时单测：3 页文档、第 2 页为空，读 1–3 页，结果停在第 1 页，`nextStart: 2`，附 “Read budget for this turn is reached”。`nextStart` 又指回那张空白页，模型按提示重试，结果相同。单页工具不受影响（`read-page.ts:117-130`）。

主稿 §8 写的「改正：片段 02 初稿写空白页仍被说成预算用尽，对照后改为不再误标」，改正的方向是错的：片段 02 的初稿是对的。

## 2. 两稿漏掉的问题（按严重度）

### P0 · 丢数据

**2.1 空白页截断范围读，并对模型说谎**（§1 #7）。触发条件：扫描件里的空白分隔页、OCR 什么也没读出来的页、索引失败的页。后果：整篇问答静默地只覆盖前几页。修法：空文本不进预算分支，返回「这页没有字」并继续循环。不要像补充稿 §5.1 那样只在 `markDelivered` 上打补丁，因为那一行根本到达不了。

**2.2 降级会删掉其它文档的回答正文；再升级，记录也回不来。**
- 写入方读到较新版本的 findings 时，`readDocs` 返回 `[]`（`json-store.ts:218-222`）。下一次 flush 只写内存里打开的文档（`:307-331`）。随后 `prune(kept)` 删除所有未被引用的 body 文件（`finding-bodies.ts:135-141`），包括被 `.newer` 保存的那些文档的 body。`.newer` 里留下的是指向已删文件的索引。
- 回到新版本时，主键已被旧版本按旧格式重写，正常迁移；`.newer` 没有任何读者（`rg preserveNewer` 只有两个写入调用点）。降级期间以前的、只存在于新版本格式里的记录，从界面上消失。
- 影响 findings、marks 和 index 三个 store，不只是主稿 §1.10 写的 index。
- 修法：`status === "newer"` 时该 store **只读**：不 flush、不 prune，并提示读者「此记录由较新版本写入」。这比「升级时合并 `.newer`」简单，也避开了主稿 §6 已经点出的合并规则风险。

**2.3 到达总量上限时，整篇文档的记录被静默丢弃。** `addFinding` 只检查每文档上限（`finding-store.ts:417`）。总量上限在 flush 时执行，方式是**整篇跳过**超出的文档（`json-store.ts:322-326`），随后它们的 body 被 prune 掉。界面上显示已保存，磁盘上没有。修法：在写入时拒绝并给出 toast，绝不在 flush 里丢弃已存在的文档。

### P0 · 安全边界

**2.4 路径白名单挡不住 webview 本身。** `register_allowed_path` 是普通 IPC 命令，接受任意路径，还会扩大 asset 协议的范围（`lib.rs:61-81`）。webview 里任何脚本都可以先登记 `~/.ssh/id_rsa` 再 `read_file_bytes`，或者先登记 `$HOME` 再用非原子的 `write_text_file`（`lib.rs:371`，`fs::write`）覆盖点文件。另外，「另存为」的目录会被持久化（`allowed-paths.ts:4-16`），每次启动重新登记，这与 `lib.rs:55-60` 注释里的「重启即重置」矛盾。

目前没有找到注入入口：Markdown 链接经过 `isSafeLink`，也没有 `dangerouslySetInnerHTML`。所以这是纵深防御上的洞，不是已知可利用的漏洞。但这个应用会渲染模型的输出，而 CSP 又放开了 `connect-src https:`。20.0 刚因为同一类问题删掉了 `store:default`，同一个结论应该一致地落到这条命令上。

修法：授权只来自 Rust 侧的来源（对话框结果、拖放事件、启动参数），webview 不能直接授予任意路径；`write_text_file` 改走 `store_io` 已有的「临时文件 + fsync + rename」写法。

### P1 · 花钱与准确性

**2.5 范围读会对失败页重复计费。** 范围循环先调用 `readPageText`，后者可能发起一次计费的 vision 调用（`reading.ts:553`），之后才检查 `alreadyDelivered`（`:574`）。单页工具的顺序是对的（`read-page.ts:70-73`）。另外 `consumeIndexFailure`（`reading.ts:363`）把失败原因消费掉了，补充稿 §5.3 已经写过这一点。

**2.6 复核结果的键不含页码和段落**（`claim-review.ts:59`，键是 `path+claim+quote`）。支点 A 要把复核结果落盘。如果沿用这个键，重新索引或重新 OCR 之后，旧的判定仍然挂在已经变了的段落上。落盘之前，键里要加上页码和段落文本的指纹。

**2.7 OCR 缓存读失败时，另一种语言的分区被抹掉**（`ocr-store.ts:146-148`）。代价是 CPU，不是数据，排 P2。

### P0 · 流程

**2.8 发布不看 CI。**（上游，GitHub Actions）

| 发布 | main 上 CI 失败的 job | 根因 | 修复 |
|---|---|---|---|
| 17.0.0 | test | 流事件顺序的断言并非在所有运行时都成立 | 发布后的下一个提交 |
| 18.0.0 | rust | Cargo feature 与 `tauri.conf.json` 不一致 | 发布后 |
| 19.0.0 | eval + windows-checks | 过时的 import；Windows 路径分隔符 | 发布后 |
| 20.0.0 | perf（batch 3 起连续 4 次） | Tauri mock 不认识 20.0 新增的 store 命令 | 发布后（`0c43505`） |
| 当前 HEAD `5a5c18e` | eval | 见 2.9 | 未修 |

最近 30 次 CI 运行中失败 8 次。`release.yml` 只在 `push: tags` 和 `workflow_dispatch` 时触发，`needs` 只有它自己的 `prepare`。仓库里的 perf、eval、ui-inventory 这些门，在发布那一刻都没有约束力。

修法：在 `release.yml` 的 `prepare` 里检查该提交在 main 上的 CI 结论（或者把 CI 改成可复用的 `workflow_call`，由 release 直接 `needs`）。CI 不绿就不出包。

**2.9 eval 存在竞争：多个文件同时写同一份缓存。** 6 个 eval 文件在并行 worker 里对同一个 `eval/out/<id>.dump.json` 调用 `loadDoc`。写入是原地 `writeFileSync`（`eval/lib/corpus.ts:60-64`），没有「临时文件 + rename」。CI 每次 checkout 都会刷新 `inspect.rs` 的 mtime，缓存因此总是冷的，竞争窗口每次都在。当前 HEAD 的失败就是 `SyntaxError: Unexpected end of JSON input` 出在 `corpus.ts:64`，而这个提交只改了文档。本地三次冷缓存重跑没有复现这个错误（**未复现**，机制来自读代码），但三次都因另一个原因失败：没有 `eval:fetch` 时，`numbers.eval.ts` 的样本数是 121，低于它要求的 150。这说明「`eval:fetch` 是可选的」这句文档与门不一致。

修法：缓存改为原子写，或者用 `globalSetup` 先单线程抽取一次；`numbers` 的门槛按是否有 fetched 文档分别设定，或者在 README 里把 fetch 写成必需。

## 3. 下一个大版本该是什么

### 3.1 版本号先说实话

CHANGELOG 声称遵循 SemVer，但 17.0→20.0 只用了约 25 小时（上游，release 时间戳），大版本号代表的是「一轮评估稿」，不是不兼容的变化。真正的不兼容（store 格式、`index-cache` 版本）反而没有被版本号标出来。§2.2 说明降级正是这个产品最危险的操作，版本号应该让读者知道哪一次升级是不可回退的。建议 v21 之后：store 格式变化才升大版本，其余用小版本号。

### 3.2 v21 的范围（按顺序，前一组不完成不开后一组）

**组 1 · 数据与诚实（必做）**
1. 空白页不截断范围读（§2.1）。测试：3 页、第 2 页为空，range 1–3 返回 3 页，`budgetExceeded` 为 false。
2. store 遇到 `newer` 时只读：不 flush、不 prune（§2.2）。测试：用较新版本的 findings 加 body 夹具，flush 一次后字节不变、body 文件数不变。
3. 总量上限在写入时拒绝（§2.3）。测试：到达上限后再写一篇文档，已有文档的条目数不变。
4. 路径授权只来自 Rust 侧来源；`write_text_file` 原子写（§2.4）。测试：`capability-scope.test.mjs` 断言 `register_allowed_path` 不在 webview 可调用的命令里，或者只接受一次性令牌。
5. 范围读先检查 `alreadyDelivered`、不消费失败原因（§2.5）。
6. 主稿验收 #10、#11（改为「只读」方案）、#12，补充稿 #17（改写为针对 §2.1）、#18。

**组 2 · 发布门（必做，可与组 1 并行）**
7. release 依赖 CI 结论（§2.8）。
8. eval 缓存原子写；`numbers` 门槛与 fetch 一致（§2.9）。
9. 主稿验收 #13–#15，补充稿 #20：门与文档之间的小漂移。

**组 3 · 第一份真实基线（必做，零代码）**
10. 用 `eval:live` 至少录一份真实模型的回答，提交到 `eval/baselines/`，带模型、日期和 commit。§5 的问题集是现成的。20 个版本以来，「被引用的引文有多少比例真在页上」从没有一个真实模型的数字，而这正是产品的核心承诺。之后支点 A、B 的取舍，都应该拿这份基线当分母。

**组 4 · 两稿的支点（组 1–3 完成后）**
11. 支点 A：一次调用复核 N 条引文，结果落盘，键加入页码和段落指纹（§2.6）；红芯片的下一步就是这次复核（补充稿 #16）。
12. 支点 B：路 2，扫描表格明说不承诺。同意两稿的判断。
13. 补充稿 #19（步骤标签）、提示词里 `figures` 那半句（#18）。

**不做**：沿用主稿 §5 和补充稿「不增补」两张清单，一条不改。再加一条：**在组 3 有数之前，不再写新的「v22 方向评估」。** 之前每一版都由上一版的评估稿驱动，而评估稿的输入是代码，不是读者。

### 3.3 发行面（不进 v21 的验收，但决定 v21 有没有人用）

1 次下载、0 个 issue，最直接的解释是安装门槛：macOS 要跑 `xattr` 命令，Windows 有 SmartScreen 警告。同时，AppImage 有 95 MB，是 `.deb`（17 MB）的 5.5 倍，值得看一眼打包内容（**未量**原因）。公证需要开发者账号，这件事不由代码决定，但它比本文其余任何一条都更能决定 v21 会不会有第一个外部读者。建议作为 v21 期间并行的一件事立项，归属发布链。

## 4. 验证记录

**本次实测**
- `npm ci`；`npx vitest run`：**157 个文件 / 1,224 条测试全部通过**，耗时 37 s。
- `npm run build`（含 prebuild 的全部 check 和 postbuild 的 bundle 检查）：通过。最大的 chunk 是 `ai` 634 kB、`pdf` 521 kB、`index` 447 kB。
- 空白页：在 scratchpad 里用临时单测复现了 §1 #7（未提交）。
- eval：冷缓存连跑三次，都因 `numbers.eval.ts` 的 121 < 150 失败（没有 fetched 文档）；没有复现 JSON 竞争。
- GitHub API：最近 30 次 CI 运行中失败 8 次，失败 job 的日志逐一读过（§2.8）；v20.0.0 资产下载数（1）；issue 数（0）。

**读代码**：§2 各条的 `file:line`。

**未量 / 未跑**：perf 探针、`ui:shots`、Playwright 各项审计、OCR eval、真机（macOS / Windows），以及 §2.4 的实际利用（没有找到注入入口）。
