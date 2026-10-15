# v20 OCR spike：换引擎、升级感知、还是维持现状

*2026-10-15。基线 main `d534553`（v20 batch 1–3 已在树上；`VERSION 19.0.0`）。*

*口径：**实测（本次）**＝在这个 orb（2 vCPU Linux）里量出来的（`node`/`rolldown`/`magick`/`cargo`/crates.io/GitHub API/`curl`；scratch 全在 `/tmp`，已清理）；**实测（仓库自带）**＝仓库里的测量产物（`eval/out/*`、`eval/README.md`）；**读代码**＝`file:line`；**上游**＝crates.io/docs.rs/GitHub 的事实；不确信的写**未量**。本稿只读仓库，唯一写入是本文件。*

## 0. 结论

1. **20.0 走 C：维持 tesseract.js + 已落地的 sweep 上限。** 现状引擎是唯一有完整门数的路线（En 99.1% / Zh 87.8% / corpus 84.1% / FP 0.05% / median 2.73s，全过）；两个换引擎候选今天没有任何门数。ocr-rs 的有界样本显示中文表格页大幅变好（27/27 vs 11/27），但两栏英文变差（38/94 vs 67/94）、每页更慢、构建面更大——按"专注与简单"，不够换。
2. **中文门今天只有现状引擎在录**：87.8%（79/90，差 2.8 点）。本次从 recordings 复算逐项一致、7 页有界重跑逐页一致；**任何"换引擎达到中文门"的说法都必须先在同一个 harness 上量出 ≥85%——今天没有任何换引擎路线量过。** 没量过就不声称。
3. **反转本推荐的两个数**：① 重测把现状打到门下（proseZh <85% 或 corpus <80%）→ 引擎问题重开，候选只有 ocr-rs；② 若产品把门扩到扫描表格/图区（今天中文表格 71/114 = 62.3%），ocr-rs 的表格页证据（27/27）把换引擎从"可选"变成"唯一路径"。换的门槛写死在 §4。
4. **mnn-rs 不是路线**：它是 MNN 绑定，不含检测后处理/矫正/CTC 解码/字符集/run 映射；单独选它等于自己重写一遍 ocr-rs。
5. **本轮不需要任何新依赖**：C 路要动的两件（重测进门、取消终态）都已排进评审稿 §4（#14、#18）。

| 路线 | 准确率（有数的地方） | 每页时间（本机） | 产物 | 许可 | 置信度 | CI 风险 |
|---|---|---|---|---|---|---|
| C 维持（tesseract.js 7.0.0） | En 99.1 / Zh 87.8 / corpus 84.1 / FP 0.05%（**全门**） | 2.64s@200、3.58s@300（记录） | 资源 10.7MB | Apache-2.0 | 有（0–100） | 无（现状） |
| A ocr-rs 2.4.1 | 有界 7 页 70.3%（中文 49/49、两栏 38/94）——**非门** | median 5.0s（同 7 页；现状 4.3s） | 模型 10.9MB(fp16)/21.4MB + 二进制 +10.5MB | Apache-2.0 | 有（0–1 + 逐字） | libclang + 网络下载（可变 tag、无校验）；源码回退 |
| A′ mnn-rs 0.1.7 | 无（不是引擎） | — | 预编译 6–7.5MB（macOS/Linux 各 target） | Apache-2.0 OR MIT | 绑定层有 | 无 OCR 能力，需自写全管线 |
| B 感知升级 | 预处理净 +4/228（实测）；其余已做或未量 | ±5% | — | — | — | 无 |

## 1. 现状：今天的数与它的日期

**记录来自哪一次运行（实测（仓库自带）+ 读代码）**

- `eval/out/ocr*.json` 的 `engine` 字段 = **7.0.0**，与今天安装的 `tesseract.js` 相同（`package.json:57` `^7.0.0`，lock 7.0.0）；缓存文件 mtime 2026-10-14 04:52–04:59（本 checkout 里的那一次运行）。
- 准确率与 `eval/README.md` 的 14.0.0 表**逐项相同**（99.1 / 87.8 / 78.0 / 68.7 / 84.1），median 不同（`ocr.json` 2734ms vs README "2.2s"）——**准确率是今天的数；时间是 10-14 那次在本机上的数**（README 的 2.2s 是 14.0 的记录）。
- 识别与判据路径自 14.0 未改（`git log`）：`ocr-result.ts`（词→run 映射、置信度、`ocrDpiFor`）自 14.0、`quote-locate.ts` 自 13.0 未动；14.0 后只有 `ocr-service.ts` 改过（16.0 B9、17.0、19.0 render-idle + 可取消）。本次在 7 页上重跑识别，**逐页 located 数与缓存完全一致**（contract-zh p1 11/27、p5 21/22、gpl-3.0 p3 32/33、paper-en p1 32/41、mpl-2.0 p1 35/53、geobase p1 6/8、vicksburg p1 24/28）→ 识别是确定性的，时间随负载波动。
- eval job 在 CI 里每次从头跑（`ci.yml:137-174`，`eval/out` 不入库、第三方文档按 SHA-256 拉取）——门是活的。

**门（实测（仓库自带），本次逐项复算一致）**

| 类别 | 记录 | 门 |
|---|---|---:|
| proseEn | 229/231 = 99.1% | ≥95% ✓ |
| proseZh | 79/90 = 87.8% | ≥85% ✓（差 2.8 点） |
| generated corpus | 557/662 = 84.1% | ≥80% ✓ |
| altered quotes wrongly located | 1/1997 = 0.05% | ≤1% ✓ |
| median | 2734ms | ≤5000ms ✓ |
| two-column（报告） | 124/159 = 78.0% | — |
| table（报告） | 125/182 = 68.7% | — |
| fetched（报告） | 236/360 = 65.6% | — |

**每页时间（实测（本次，从 recordings 复算））**：eng@200dpi 41 页 **median 2.64s / p90 5.00s**（min 0.39 / max 17.3）；chi@300dpi 10 页 **median 3.58s（平均口径；上取 3.84s）/ p90 7.30s**（最近秩 7.28s）。评审稿记 2.64/4.83 与 3.58/7.28——p90 为分位方法差异，本次两种方法都得 5.00s。本次重跑 7 页的耗时与缓存同量级（0.95–11.6s/页，随页密度与负载）。

**资源与包体（实测）**：`public/ocr` **10,678,666B / 7 文件**（2×core wasm+js、worker、eng 2.95MB、chi_sim 1.72MB gz）；Tauri brotli 后 +10.18MiB 进可执行文件（评审稿实测）。`dist` 本次 = 17,850,737B。

**置信度判据的账（实测（本次，从 recordings 复算））**：`OCR_TRUSTED_CONFIDENCE = 70`（`index-queue.ts:103`）今天决定"读得差的页才花 vision"。实测：**8/51 页 conf<70（全部是 geobase 的页），承载 126/1022 引文，located 46/126 = 36.5%**；conf≥70 的页 747/896 = 83.4%。**全部 miss 的 80/229 = 35% 落在这 16% 的页上**——判据选得准；但 vision 文本没有 run，那些页上的引文只能 unconfirmed（这条不变）。

**已落地的上限（读代码）**：v20 batch 1 起 `DEFAULT_AUTO_INDEX_PAGES = 50`（`index-queue.ts:57`），OCR 与 vision 共用这次 sweep 的页数界；300 页 ≈6.6 分钟 → ≤50 页 ≈66s（评审稿算术）。"没有上限"已不存在。

## 2. 路 A：中文原生识别器

### 2.1 ocr-rs 2.4.1（PaddleOCR 模型 + MNN）——唯一像引擎的候选

- **上游**：crates.io `ocr-rs` 2.4.1（2026-08-05；8.4 万下载；**Apache-2.0**；repo `zibo-chen/rust-paddle-ocr`，最后提交 2026-09-11，维护活跃）。`rust-paddle-ocr` 只是 repo 名，crate 不存在（本次复核）。crate 本体 98KB，模型与测试不入包（`exclude`）。
- **模型（实测（本次）：克隆 repo 逐文件量）**：`models/` 里是**真实文件**，不是 README 声明：`PP-OCRv5_mobile_det.mnn` 4.76MB + `PP-OCRv5_mobile_rec.mnn` 16.53MB（**fp16 版 2.44 + 8.37MB**）+ `ppocr_keys_v5.txt` 74KB（18,383 行、**15,565 行含 CJK**）；另有 v4（ch 4.74+10.82MB）、v6 tiny/small/medium（0.9–38.4MB）、11 个语种专用 rec（en 3.97MB 等）。**中文支持是文件+字表+本次识别三重验证**，不是声明。**来源**：PaddleOCR 官方权重经 `script/convert_paddle_to_mnn.py` 转换（上游 README）；许可随 PaddleOCR（Apache-2.0）——**转换产物无单独许可文件、无校验和（未量：应作为入库条件）**。
- **置信度（读代码）**：`OcrResult_ { text, confidence: 0–1, bbox }`；`RecognitionResult.char_scores` 逐字符；`AlignedRecognitionResult` 另给 CTC 对齐的逐字 `CharacterSpan`（行内归一化位置）。**有置信度**，但 0–1 标尺与 tesseract 的 0–100 不同——`MIN_WORD_CONFIDENCE = 30`（`ocr-result.ts:67`）与 70 两处判据要重定标（判据重定是 spike 内容）。
- **构建（实测（本次，2 vCPU Linux））**：`cargo build --release` 需要 **libclang（bindgen）+ C++ 编译器（cc 编桥）+ 网络**；`apt install libclang-dev clang` 后 cold build **178.8s**；产物二进制 **10.5MB**（含静态 MNN；`libMNN.a` 10.1MB）。crates.io 2.4.1 的 `build.rs` 从 `zibo-chen/MNN-Prebuilds` release `dev`（2026-03-19，**可变 tag、无 SHA 校验**——读代码）下载预编译：linux-x86_64 4.6MB / linux-aarch64 4.6MB / **macos-universal 7.5MB** / windows-x86_64 11.8MB（覆盖 PageWise 三平台）；不支持的平台回退 **cmake 源码编译 MNN**。git HEAD（未发布）已迁到 `mnn-runtime` 0.1.0：预编译来自 `mnn-native-prebuilds`（**SHA-256 校验**、`MNN_REQUIRE_PREBUILT=1` 可禁回退）、Windows 预编译要 static CRT——更好的形态，但还没进 crates.io。
- **实测（本次，有界 7 页）**：识别 3812/4713/7000/9271/14527/1460/5017ms（**median 5.0s**）vs tesseract 同页重跑 3364/3163/4321/7411/11597/953/4935ms（**median 4.3s**）——**本机 6/7 页更慢**。located（region 级 run、原顺序）：**149/212 = 70.3% vs tesseract 161/212 = 75.9%**；分面：**中文 49/49 vs 32/49**（表格页 contract-zh p1 27/27 vs 11/27；proseZh p5 22/22 vs 21/22）、**两栏英文 38/94 vs 67/94**、单栏英文 gpl p3 32/33 = 32/33、geobase p1 7/8 vs 6/8、vicksburg p1 23/28 vs 24/28、geobase p10（低置信页）5/14 vs 2/14。region 置信度 0.95–1.0（含 geobase，**明显未校准**）。
- **两栏失败的原因（实测）**：detection 顺序交错两栏（同一行左右栏相邻，如索引 15/17 左、16 右）——`quote-locate` 的阅读顺序链被截断；朴素"按列排序"不修（145/212）。**run 粒度本身也是问题**：14.0 用 tesseract 量过词 run 77.5% vs 行 run 57.9%（`ocr-result.ts:17-21` 注释）；ocr-rs 原生给行/区域 run——要过门必须先把 run 映射做成词/字级（英文按空格、中文按 `CharacterSpan`），这是 spike 的第一项工作。
- **三平台 CI 面**：预编译覆盖 macos-universal（两 slice）/windows-x86_64（MSVC）/linux-x86_64；但每平台构建都要 **libclang**（Windows 要装 LLVM 并设 `LIBCLANG_PATH`——上游自己的 CI 就这么干）+ 网络下载（tag 可变、无校验；CI 要 vendor 或自行校验）；`ubuntu-22.04` 发布机的 glibc 下限**未量**；新增 CI 时间：冷构建 ≈3 分钟/平台（本机实测），加 install 步骤。
- **包体（实测换算）**：fp16 det+rec+keys = **10.9MB**（≈ 现 `public/ocr` 10.7MB，近 wash）；标准模型 21.4MB（+10.7MB）；MNN 静态库进二进制（本机最小示例二进制 10.5MB）。删 `public/ocr` 的 −10.18MiB（brotli）要减去这笔。

### 2.2 mnn-rs 0.1.7——不是路线，是地基

- **上游**：crates.io `mnn-rs` 0.1.7（2026-08-17；**251 下载**；Apache-2.0 OR MIT；repo `wapznw/mnn-rs`，1 star）；默认 `cpu+static+use-prebuilt`，从 GitHub release 按 target 下载预编译（x86_64-apple-darwin 6.7MB、aarch64-apple-darwin 6.0MB——**不是 universal**、aarch64-linux 7.5MB、windows-msvc 各档；Android 70–130MB）。更早的 `aftershootco/mnn-rs`（24 star，2026-03 停更）是它承认的上游。
- **它只做推理绑定**：没有检测后处理（DB 框）、没有文本行矫正、没有 CTC 解码、没有字符集、没有 run 映射——**选 mnn-rs 等于自己写一遍 ocr-rs**（ocr-rs `src/` 约 232KB + C++ 桥）。要"保中文的识别器"，候选其实是"ocr-rs 或自己实现"，mnn-rs 只是后者的零件。

## 3. 路 B：不换引擎的感知升级，逐项的账

| 项 | 今天的值 / 证据 | 判断 |
|---|---|---|
| 分辨率 | 已两档（`ocrDpiFor`：中文 300 / 英文 200；300 让中文多 9 点、英文无益、两栏略差——`ocr-result.ts:76-80` 注释） | 已做；更细的按页型自适应 **未量** |
| 预处理（deskew/denoise/binarise） | **实测（本次，7 页有界）**：`magick` gray+deskew40%+normalize 净 **+4/228** 引文（−1、0、0、+2、+2、0、+1），时间 ±5%；自适应二值化（`-lat`）**毁灭**：0/27、3/53、1/28（conf 掉到 30–40） | 不做（没有可测的收益；二值化明确为负） |
| 区域/表格识别 | tesseract 无 crop→recognize 路径（`extract_region` 只服务文本层）；ocr-rs 的表页 27/27 说明"区域模型"是这类页的杠杆 | **未量**（tesseract 侧）；路 B 唯一有希望的项 |
| 置信度感知的接受 | **实测**：36.5% vs 83.4%；35% 的 miss 在 16% 的页上；`OCR_TRUSTED_CONFIDENCE=70` 已在路由 | 已做；调阈值只影响"哪页花 vision"，不影响引文可核对（vision 无 run） |
| 语言模型选择 | 已做（`eng` / `chi_sim+eng`，`ocr-engine.ts:16`） | 已做 |
| 缓存 | 已做（`ocr-store.ts` v2；本次验证识别确定性→缓存语义正确） | 已做 |

**路 B 的结论**：没有留下"有数字、还没做"的大杠杆；预处理实测近零（二值化为负），其余已在。**唯一建议进 20.0 的是把现状重测进门**（评审稿 §4 #14）：跑 `npm run eval` 后把 En/Zh/corpus/FP/median+**p90** 写进 `eval/README.md`（现在 README 还是 14.0 的 "Median 2.2 s" 记录）。

## 4. 决策与阈值

**决定：20.0 维持 tesseract.js（C 路），换引擎不进计划。** 支付它的动作已经在树上（sweep ≤50 页）；收尾只有两件：① 重测进门（§3 末）；② OCR 取消的终态（`ReadingLine`，评审稿 §4 #18）。

**阈值（写死，下一批不用再决定）**

1. **重开**：重测结果 proseZh **<85%**（今天 87.8%）或 corpus **<80%**（今天 84.1%）——任一掉门，引擎问题重开，候选只有 ocr-rs。
2. **换**（若走 spike）：ocr-rs 在**同一 harness**（同 662 引文、51 页；词/字级 run 映射）上必须同时满足 **En ≥95%、Zh ≥85%、corpus ≥80%、FP ≤1%、median ≤5s**，且每页 median **不高于现状**（参考机 2.64s@200dpi / 3.58s@300dpi），且三平台构建**不需要源码编译**（或源码编译已被接受并写进预算）。任一项不过 = 不换。
3. **产品面触发**：若门扩到扫描表格/图区（今天中文表格 **62.3%**，71/114），换引擎从可选变唯一路径——ocr-rs 的表格页证据（27/27）是目前唯一正信号。

## 5. spike 计划（下一批可照做）

**S1 现状重测（半天内，先做）**

- 命令：`npm run eval`（首次跑 51 页识别，本机 ≈2 分钟、2 slots——eng 合计 139s / chi 合计 40s 的算术；缓存命中则秒级）；p90 从 `eval/out/ocr*/` 的 `ms` 复算（方法照 §1）。
- 交付：`eval/README.md` 更新为当前版本记录（En/Zh/corpus/FP/median+**p90**）；`eval/out/ocr.json` 重新生成。
- 门：同 §1 表；不通过则触发 §4.1。

**S2 ocr-rs 门数 spike（只在 S1 掉门或产品触发时做）**

- 依赖：scratch crate（`ocr-rs = "2.4.1"`，三平台各构建一次；Linux/macOS 需要 `libclang-dev`/Xcode CLT，Windows 要装 LLVM 并设 `LIBCLANG_PATH`）；模型用 **fp16 det+rec + keys_v5**（10.9MB），标准模型作对照（精度差 **未量**）。
- 集成工作（spike 的一半）：区域→**词/字级 run** 映射（英文按空格切、中文按 `CharacterSpan`；先跑一版行 run 作对照）；两栏阅读顺序（按列聚类排序或按 det 框重建分栏）；置信度重定标（0–1 → 今天 30/70 两处判据的等价阈值）。
- 语料与门：同 `eval/ocr.eval.ts` 的 662 引文 / 51 页（7 文档），外加 geobase 的低置信面（19 页）；门数 = §4.2 五条 + **p90** + 每页峰值 RSS（未量）+ 包体增量（`du -sb` 前后）+ 三平台构建记录。
- 时间预算：构建 ≈3 分钟/平台（冷）；识别 51 页 × 1.5–14.5s ÷ 2 ≈ 3–6 分钟/次；映射与评分半天内。
- 不通过 = 记录在案，`public/ocr` 与 vision 预算不动（评审稿 §4 #17）。

**S3（只在 S2 通过后）**：删 `public/ocr`、撤 vision 20 页预算、`copy-ocr-assets.mjs` 的"缺资源也 exit 0"改非零（评审稿 §4 #17、§7.10 #8）。

## 6. 验证记录

**本次跑过（全部只读）**

- 从 `eval/out/ocr*/` 复算 tally/overall/median/p90/置信度分桶（Node，经 `rolldown` 打包复用仓库的 `quote-locate`/`ocr-result`/`quotes`；结果与 `eval/out/ocr.json` 逐项一致——这是本稿的校准点）。
- 7 页有界重跑（tesseract.js 7.0.0，同 `langPath`/同参数）：与缓存逐页一致（确定性）；预处理 A/B 变体（`magick`）。
- ocr-rs 2.4.1 真实构建（`apt install libclang-dev clang`；cold 178.8s；二进制 10.5MB）与 8 页识别、run 映射评分（含 geobase p10）。
- crates.io/GitHub API：ocr-rs / mnn-rs / mnn-runtime / mnn-runtime-sys 的版本、许可、日期、features；`zibo-chen/MNN-Prebuilds` 与 `mnn-native-prebuilds` 的 release 资产清单（含体积）；上游 README（模型表、安装、预编译声明）。

**读代码**：ocr-rs `src/{engine,rec,det,lib}.rs` 与已发布包的 `build.rs`/`Cargo.toml`；`mnn-rs` build.rs/README；`mnn-runtime-sys` README/build.rs；本仓 `ocr-result.ts`/`quote-locate.ts`/`index-queue.ts`/`ocr-service.ts`。

**未量**：① ocr-rs 的完整门数（En/corpus/FP/median）与词/字级 run 映射；② 每页峰值 RSS（两个引擎）；③ macOS/Windows 真机构建（预编译清单只在纸面）；④ `ubuntu-22.04` 上链接的 glibc 下限；⑤ ocr-rs 标准 vs fp16 的精度差；⑥ tesseract 的区域/表格 crop 路径；⑦ 模型转换产物的校验和/许可文件（入库条件）。

**写稿时 `git status` 非干净**：preview/引文/i18n 相关文件有未提交改动（写稿期间由另一进程产生，数量从 8 个增到 15 个）与一个未跟踪 `.tmp-measure.mjs`——均非本稿写入、不在 OCR 路径上（`src/lib/ocr/*`、`quote-locate.ts` 未动）；本稿唯一写入是本文件。
