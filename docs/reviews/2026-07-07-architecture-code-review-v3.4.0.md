# PageWise v3.4.0 架构与代码审查报告（复审）

日期：2026-07-07 · 基线：`main`（a70f0fc，v3.4.0）。
背景：本报告是对 [2026-07-06 v3.1.0 审查](./2026-07-06-architecture-code-review.md) 的复审。该轮发现的问题在 v3.1.1–v3.4.0 中被逐条修复（CHANGELOG 直接引用了原报告编号 H3/H4/H6/M2/M7/M8/L1…）。本轮目标：**验证这些修复是否正确、有无引入回归,并审查新增/仍存在的缺陷**。
方法：三路并行深度验证（agent/chat 修复、index/session 修复、security/UI/docs 修复），每项逐调用链追踪；关键项作者手工二次核实。基线验证：TypeScript 零错误、168 单元测试全绿（Rust 因审查环境缺 GTK 未编译）。

---

## 〇、本分支处置状态（2026-07-07 更新）

本轮发现随后即在本分支 `claude/architecture-code-review-3jivju` 上修复，逐项状态如下（全套现 188 测试通过、tsc 零错误）：

| 项 | 状态 | 处置 |
|----|------|------|
| **N1** vision 渲染被 DPR 抵消 | ✅ 已修 | 抽出纯函数 `visionRenderScale` 除掉 DPR 乘子；含单测（DPR 独立性/封顶/小页面） |
| **N2** 工具输出压缩不幂等 | ✅ 已修 | 哨兵串检测已压缩输出，跳过重算；含幂等单测 |
| **N3** 关窗监听器泄漏 | ✅ 已修 | 异步注册加 `cancelled` 守卫 |
| **N4** 读取后 meta 循环只由步数兜底 | ✅ 已修 | 移除有害的全历史检查（窗口检查已足够）；含 N4 回归单测 |
| **N5** 单一来源半成品 / 死代码 | ✅ 已修 | 删 `documentTools`、`renderPageToPngBytes`、幽灵 `list_documents` 标签及孤儿 i18n 键；`tool-steps-summary` 全对齐常量 |
| **N6** ThemeProvider `resolved` 滞后 | ✅ 已修 | `resolved` 改为随 matchMedia 更新的状态 |
| **N6** useDebouncedSave provider 切换重基线 | ⏸️ 保留 | 仅一次多余等价保存，dirty 仍清，纯 cosmetic |
| **N6** asset scope 软链接图片边角 | ⏸️ 存疑 | 未确认 Tauri 内部是否 canonicalize；PDF 因 IPC 回退免疫 |
| **L3** index-events map 泄漏 | ✅ 已修 | notify 不再持久化 idle；含 map 收缩单测 |
| **L7** 同步钥匙串阻塞主线程 | ✅ 已修 | 三个命令改 `spawn_blocking`（Rust 未本地编译，复用 lib.rs 既有模式） |
| **L10** pdfBytesCache LRU 退化 | ✅ 已修 | 命中时 touch |
| **L12** 搜索框无焦点陷阱 | ✅ 已修 | 加 `useFocusTrap` |
| guard helpers（`getBlockedMetaTools`/`shouldForceReadTools`） | ⏸️ 待决策 | 有测试的意图代码；删除会抹意图，接入 `activeTools` 是有风险的行为改动，留待产品决策 |
| **M1 残留**（白名单自注册 / `connect-src https:`） | ⏸️ 固有取舍 | 自带端点设计所需；仅 asset scope 已收窄 |

此外为改动最大、原零覆盖的 **index-queue 代数取消/重建** 和 **关窗 flush** 补了回归测试（`index-queue.test.ts` 覆盖 H3/H4/M4/M5 + 陈旧代际写入守卫；`flush-chat.test.ts` 锁定 M3 顺序不变量），关窗 flush 逻辑抽成纯函数 `session/flush-chat.ts` 以便测试。

---

## 一、结论速览

**上一轮的 6 个高危 + 9 个中危问题全部已正确修复,无高危回归。** 文档漂移已修正,安全侧两个核心修复（asset scope 收窄、PDF panic 隔离）扎实且未弄坏预览。团队还落地了原报告的根因建议：新增 `document-tool-names.ts` 作为工具身份单一来源、view context 改走 `runtimeContext`、共享 `ThemeProvider`。

本轮**未发现新的高危问题**。发现 1 个中危（M6 的修复在实际发布平台上被抵消)、1 个低-中危（工具输出压缩不幂等）和若干低危/卫生项。另有一批上轮的低危项因所在文件未被触及而**仍然遗留**。

---

## 二、修复验证结果（逐条）

| 原编号 | 修复版本 | 结论 | 说明 |
|--------|----------|------|------|
| H1 提示词工具名漂移 | 3.1.1 | ✅ 正确 | prompts/prune/guards 全部改从 `document-tool-names.ts` 取值;whole-document 流程只用 `document_outline` |
| H2 outline 输出不裁剪 | 3.1.1 | ✅ 正确 | 历史（stream-end + pre-send）和持久化（`prepareMessagesForPersist`）都压缩 |
| H3 重建清空全部页面 | 3.2.0 | ✅ 正确 | 同一个 `pages` 数组同时传给 invalidate 和 rescan,清除集=重扫集,上限 50,无 off-by-one |
| H4/M4 取消卡死/不中止 fetch | 3.2.0 | ✅ 正确 | 代数感知去重;`AbortSignal.any([queue, timeout])` 传入 fetch;await 后复查代数丢弃陈旧结果;所有路径都到达终态 |
| H5 discard 仍保存 | 3.1.1 | ✅ 正确 | `discardPending` 置 `suppressUnmountPersistRef`,卸载 effect 据此跳过 persist |
| H6 畸形 PDF 崩溃 | 3.3.0 | ✅ 正确 | `panic = "unwind"` + `run_blocking_pdf` 的 `catch_unwind` 包住了 `Document::load` 和 `output_doc_page` 两条 panic 路径 |
| M1 asset scope `$HOME/**` | 3.3.0 | ✅ 正确 | scope 现为 `[]`,`register_allowed_path` 运行时 `allow_file(&canon)`;预览未坏（PDF 走 IPC + asset 回退,图片走 convertFileSrc） |
| M2 图片发 asset:// URL | 3.2.0 | ✅ 正确 | 图片分支改用 `bytesToDataUrl` → `data:` URL |
| M3 切换持久化截断快照 | 3.2.0 | ✅ 正确 | `switchDocument` 从 `messagesRef.current` 读;新增 `onCloseRequested` 关窗 flush（await stream idle,有界 10s） |
| M5 取消误报 failed | 3.1.1 | ✅ 正确 | catch 区分 `AbortError` → emit `idle` |
| M6 vision 渲染超尺寸 | 3.2.0 | ⚠️ **部分修复** | 公式改对了,但被 `paintPage` 的 devicePixelRatio 乘子抵消 —— 见 N1 |
| M7 loop guards 死代码 | 3.4.0 | ✅ 正确（有保留） | `isMetaToolOnlyLoop` 已接入构造器和 prepareCall 的 `stopWhen`;但 `getBlockedMetaTools`/`shouldForceReadTools` 仍无生产调用 |
| M8 未知模型硬拒 | 3.4.0 | ✅ 正确 | `looksLikeToolModel` 先排除纯视觉族再白名单工具族;无导致误发的假阳性;对已知 tools=false 条目不会翻真 |
| M9 useTheme 双实例 | 3.2.0 | ✅ 正确 | 单一 `ThemeProvider` 挂在 root,`matchMedia` 监听随 root 存活,`cycleTheme` 读新鲜 state |
| L1/L2/L4/L5/L6/L13 | 3.1.1/3.4.0 | ✅ 正确 | 假 Unsaved、rejected store promise、node prop、导出文件名、连接回退 provider、zoom clamp 全部修复 |
| 文档（README/SECURITY） | 3.1.1 | ✅ 正确 | 无 Tesseract/DirectChatTransport;聊天文件名 `pagewise-v3-chats.json` 正确;i18n en/zh 各 386 键零差异 |

---

## 三、本轮新发现

### N1. 中危 — M6 的渲染尺寸封顶在实际发布平台上被完全抵消
`pdf.ts:892,895`（`renderPageToJpegBytes`）+ `pdf.ts:536-537`（`paintPage`）

修复把 scale 正确算成 `Math.min(OCR_RENDER_SCALE, maxEdge/edge)`（长边在 scale=1 时封顶 1568px），但随后 `paintPage(page, scale, "performance", …)` 里 `renderScale = scale * getOutputScale("performance")`,而 `getOutputScale("performance") = min(2.5, effectiveDevicePixelRatio()*1)`。在任何 HiDPI/retina 屏上 `effectiveDevicePixelRatio()` = 2,于是实际画布是 **2× 封顶**(长边最高 ~3136px)。

**为什么重要:** 应用只打包 macOS(`tauri.conf.json` targets = dmg/app),而 Mac 几乎清一色 retina。所以这个"封顶"在真实发布平台上零收益:每页 vision 索引仍以 ~4 倍像素渲染编码上传,provider 端又会降采样到 ≤1568,白花 ~4 倍 JPEG 字节和输入图像 token(×50 页/次重建)。`renderPageToPngBytes` 共享同一缺陷(且目前是死代码,无调用者)。
**修复:** 字节编码路径把 `scale` 除以 `outputScale`,或给 `paintPage` 传一个禁用 DPR 的标志。

### N2. 低-中危 — 工具输出压缩不幂等,字符数每轮漂移
`prune-chat-history.ts:92-118`

`compactToolOutput` 用 `textLength(output)` 算字符数,但当它作用于**已经压缩过的字符串**时,量的是摘要串自身长度而非原文。调用方只在 `compact === part.output` 时短路(`:30`),重算出的串不同,于是每轮重裁都会改写该 part。

**失败场景:** 第 1 轮读第 3 页 → stream-end 压缩成 `"[Read page 3, 5234 chars — omitted…]"`;第 2 轮 pre-send 再压缩同一条 → `textLength` 现在返回 ~52(摘要自身长度) → `"[Read page 3, 52 chars…]"`;第 3 轮 → `"…, 50 chars…"`…… 展示/持久化的字符数每轮漂移成无意义值,且 `changed=true` 每次触发,破坏了函数自己承诺的引用相等保持,造成多余的 `setMessages`/persist 抖动。四个工具全部受影响。内容正确性不受损(文本本就已省略,tool_use/tool_result 配对仍有效),是标签/身份缺陷。
**修复:** 检测 `— omitted from chat history]` 哨兵串并跳过,使其幂等。

### N3. 低危 — 快速切换文档时 `onCloseRequested` 监听器泄漏
`SessionProvider.tsx:179-197`

该 effect 依赖 `[flushChatNow]`,而 `flushChatNow` 随 `agent` 身份变化(每次切文档 `useDocAgent(chatId)` 重派生)。注册是异步的(`unlisten = await win.onCloseRequested(...)`),清理却同步执行;若切文档在上一个 `await` 落定前重跑 effect,`unlisten` 仍是 `undefined`,旧监听器不被移除而成为孤儿。累积多个关窗处理器后,关窗时每个都 `preventDefault` + 并发 `saveChat` + `win.destroy()`,第二个及之后的 `destroy()` 在已销毁窗口上 reject(未处理,且 `destroy` 在 `finally` 非 `try`)。实践中 `onCloseRequested` IPC 往返远快于文件加载,窗口很小。
**修复:** 注册加 `cancelled` 标志守卫,或 await 后若已取消立即 unlisten。

### N4. 低危 — 读取后的 meta 循环只由 `stepCountIs(12)` 兜底
`agent-loop-guards.ts:59`

`isMetaToolOnlyLoop` 在整个历史上 gate 于 `!hasReadToolInSteps(steps)`,所以一旦发生过任何一次读取,该守卫此后对本次 run 永不再触发。"先读一页 → 然后 outline/search 反复空转"的模式只受 12 步上限约束,M7 守卫管不到。当前非无限循环,低危,但守卫覆盖面比字面预期窄。

### N5. 低危 / 卫生 — 单一事实来源与死代码只做了一半
- **工具身份仍非全量派生**:`agent.ts` 的 `createDocumentTools`/`buildToolsContext` 注册键和 `SYSTEM_INSTRUCTIONS` 仍是硬编码字符串字面量,不从 `document-tool-names.ts` 常量派生——值恰好相同,但无编译期检查强制。漂移风险只堵了一半。
- **残留死代码**:`tool-steps-summary.ts:37` 幽灵 `list_documents` 标签 case;`getBlockedMetaTools`/`shouldForceReadTools`(有单测,生产零调用);`agent.ts:481` `documentTools` 死导出;`renderPageToPngBytes` 无调用者。

### N6. 低危（次要 / 存疑）
- `useDebouncedSave`:provider 切换后 `lastSavedRef` 未按新 provider 重基线(deps `[loaded, buildToSave]` 稳定),导致在新 provider 上把编辑改回原值时触发一次多余的等价保存而非静默 `onUnchanged`。dirty 仍会清,仅 saving→saved 闪一下。
- `ThemeProvider`:`matchMedia` 的 `onChange` 直接 `applyTheme` 而不 `setPreferences`,故 system 模式下 OS 主题切换后 `useTheme().resolved` 会短暂滞后到下次渲染。DOM 正确,仅返回值滞后。
- asset scope（存疑,未确认 Tauri 内部是否 canonicalize）:scope 按 canonical 路径注册,图片却用原始 `doc.path` 请求;经软链接目录打开的图片若 Tauri 不自行 canonicalize 可能预览失败（PDF 因 IPC 回退免疫）。窄场景,低置信。

---

## 四、上一轮遗留、本轮仍开放的低危项

以下项所在文件在 3.1.1–3.4.0 未被触及（diff 确认 `secrets.rs`、`index-events.ts`、`DocumentSearch.tsx` 均不在改动集),仍然开放:

- **L3** `index-events.ts:41-49`:`clearDocumentIndexState` 删完立即被 `emitPageIndex(idle)` 重新 set,map 仍单调增长,与注释承诺相反。
- **L7** `secrets.rs:24-47`:钥匙串命令仍是同步 `#[tauri::command]`,跑主线程,授权弹窗/DBus 往返冻结窗口。
- **L10** `pdf.ts`:`pdfBytesCache` 命中不更新 recency,LRU 实为 FIFO（影响近零）。
- **L12** `DocumentSearch.tsx`:标注 `aria-modal` 但无焦点陷阱。
- **M1 残留**:`register_allowed_path` 仍可被渲染器以任意存在路径填充,`connect-src https:` 仍无主机限制——属自带端点设计的固有取舍,仅 asset scope 部分做了收窄。注:经核实 `ensure_allowed` 是**精确集合成员匹配**、asset `allow_file` 是精确路径,故 `allowPathPersisted`/`restoreAllowedPaths` 对**父目录**的注册对放大读取权限**无效**(既不能读子文件,也不构成路径穿越提权),仅是意图不明的冗余。

---

## 五、测试覆盖缺口（重要提醒）

本轮修复中风险最高、改动最大的两块——`index-queue.ts` 的代数感知取消/重建、`SessionProvider` 的关窗 flush——**没有任何直接单元测试**(仅 `page-text-merge.test.ts`/`index-events.test.ts` 触及相邻代码)。H3/H4/M3/M4 的正确性目前只由人工追踪保证,回归风险高。建议为以下补测:重建时的清除集=重扫集、in-flight 期间重建不跳过页面、取消后页面到达终态而非卡 indexing、关窗 flush 在 hydrate 中的空消息守卫。

---

## 六、修复优先级建议

1. **快速高收益**:N1(除以 outputScale,让 M6 在 retina 上真正生效——直接省 ~4× vision 成本)、N2(压缩加哨兵幂等)、N5 死代码清理。
2. **中期**:为 index-queue 代数逻辑和关窗 flush 补单测(第五节);N3 关窗监听器守卫;N4 收窄 meta-loop 守卫或接入 activeTools。
3. **架构收尾**:把 `agent.ts` 工具注册键和系统提示也从 `document-tool-names.ts` 派生,让单一事实来源全量化;清理遗留 L3/L7/L10/L12。

---

## 七、总体评价

这是一次高质量的修复迭代:上一轮全部高/中危问题都得到正确处理,且团队采纳了根因层面的三条结构性建议(工具名单一来源、runtimeContext、共享主题),而非仅打补丁。安全侧两个最关键修复(panic 隔离、asset scope 收窄)实现扎实且未弄坏预览。本轮新问题以卫生和边际成本为主,无高危回归。唯一实质性遗憾是 N1:M6 的封顶修复在实际发布的 retina Mac 上被 DPR 乘子抵消,等于没生效——这也是本轮最值得优先修的一项。最大的过程性风险是改动最大的取消/会话逻辑缺乏测试覆盖。
