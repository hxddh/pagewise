# PageWise v3.5.13 代码与文档审查

日期：2026-07-17 · 基线：`main`（`7331c40` / `2adf6fc`，**v3.5.13**）。
方法：相对 v3.5.12 审查清单做回归核实 + 三路深挖本版 diff（IPC·Rust / settings·keychain / session·chat prune）与仍未触及的 Agent 路径；随后做**对抗性再核实**（先尝试用现有守卫反驳，只保留站得住的项，并显式记录误诊/降级）。高危项对照当前源码二次核实。

整体结论：v3.5.13 正确关掉了 **S1（读路径可写）**、旋转页选区、IPC 字符串错误坍塌、keychain 风暴（主体）等实害项。对抗性再核实后：**C6 / N5 双击草稿回填为误诊**；**A4 从「阻塞」降为提示词质量**（预算已不再门控）；**N2 降为低危**。仍站住的高影响项是 **N1（Recent≤10 驱逐聊天）**、**A1/A3（假阴性）**、**U1（Discard 写脏设置）**、**U2（关窗丢尾）**。

---

## 〇、相对 v3.5.12 审查的处置状态

| ID | 主题 | 状态 | 证据摘要 |
|----|------|------|----------|
| S1 | 打开的文件路径可写 | **Fixed** | `lib.rs` 写授权仅 `set.contains(canon_parent)` |
| S2 | 导出目录持久化 | **Open** | `save-markdown` → `allowPathPersisted` 仍在 |
| A1 | vision 失败当空白页 | **Open (Medium)** | 成功形态空 `text` + `source:"vision"`，无 `indexFailed`；prompt 只警告 search≠absent |
| A2 | 元工具空转无综合 | **Open (Medium)** | `stopWhen` 可在步数上限前结束；`prepareStep` 合成只在最后一步 |
| A3 | search 无未索引信号 | **Open (Medium)** | 仍 `{ hits, truncated }` |
| A4 | 英文整篇意图漏检 | **Open (Low)** | 漏检属实，但预算/步数已统一；仅少强覆盖 hint |
| A5 | 6k×30 吃不满 200k | **Open (Low–Med)** | 默认未变；模型可提高 `maxChars` |
| A6 | outline/search 冲预算 | **Partial (Low–Med)** | 有预检/计费，冲过可不打标 |
| A7 | search 无页多样性 | **Open (Low–Med)** | 页序 first-N |
| A8 | PDF-only 文案 | **Open (Low)** | system prompt 未改 |
| W1 | web search 仅第一步 | **Open (Design)** | **有意为之**（3.5.11 一消息一次计费）；非回归 bug |
| W2 | 编辑丢 webSearch | **Open (Medium)** | edit 载荷仍无字段 |
| W3 | isToolModel 硬挡发送 | **Open (Medium)** | Composer 仍要求 `agentToolsSupported` |
| W4 | vision 丢 HTTP status | **Open (Low–Med)** | `vision-api.ts` 未改 |
| P3 | vision 只抽字 | **Open (Medium)** | prompt 未改 |
| C1 | 切文档 save 失败仍继续 | **Open (High)** | toast 后继续 load |
| C2 | parts 未校验 | **Partial (Med)** | 行级规范化有，part schema 无 |
| C3/C4 | Pages read 高估 | **Partial (Med)** | cancelled/budget 已跳过；`input-available` 仍计 |
| C5 | regenerate 选项易失 | **Open (Med)** | 仍 `lastSendOptionsRef` |
| C6 | 双击发送回填草稿 | **Refuted** | 见 §八 |
| U1 | Discard 竞态写脏设置 | **Open (High)** | 对抗性核实后仍成立 |
| U2 | 关窗 flush 失败仍 destroy | **Open (High)** | `finally { destroy }` |
| U3 | 移除 Recent 不撤 allowlist | **Open (Med)** | 仍只改 `recent.json` |
| U5 | `store:default` | **Open (Med)** | capabilities 未收窄 |
| V1 | vision 失败无 Retry | **Open (Med)** | actionable 分支仍盖住 retry 行 |
| V2 | 缩略图 gap | **Open (Med)** | 112 vs gap 8 |
| V3 | follow-agent 误跳 | **Open (Med)** | hydrate / input-available |
| V4 | ctrl+wheel 翻页 | **Open (Low–Med)** | 无 modifier 守卫 |
| L13 | 启动 restore 失败无提示 | **Partial** | 失败 Recent 会 prune；可能误伤临时不可用文件（与 N1 叠加） |

---

## 一、v3.5.13 本版确认修好（抽样核实）

1. **IPC 字符串错误** — `invokeCmd` 规范化；load catch 读 string；extract cancel 识别 string。加密 PDF / too large 等真实原因可到达 UI。  
2. **写权限与读 allowlist 分离** — `write_text_file` 只认已注册**父目录**。  
3. **旋转页 text layer** — `data-main-rotation` + CSS。  
4. **Keychain 风暴（主体）** — `keychainBlockedThisSession`；打开 Settings 调 `resetKeychainBlockedFlag`。  
5. **CSP `connect-src` 含 asset** — asset PDF fallback 可恢复。  
6. **陈旧 scope-cancel** — 新 extract 遇假 cancelled 重试一次。  
7. **中途删 key 中止后台索引队列** — `enforceGeneration` 路径 `cancelIndex` 一次。

---

## 二、本版新发现（相对 3.5.13 diff / 新行为）

### N1. 高危 — 启动用 Recent(≤10) 当 keep-set，驱逐「孤儿」聊天可删有效历史
**类别：** Design defect（有意清理）+ 数据丢失风险；临时不可用路径叠加时接近 Bug  
**位置：** `src/lib/recent-files.ts:5`（`MAX_RECENT = 10`），`src/session/SessionProvider.tsx:130-141`，`src/chat/persist.ts:70-79`

`pruneOrphanedChats(kept)` 删除**一切不在 keep 集合里的 chat key**。keep 来自当前 Recent（上限 10）。注释写明是有意的 store 清理，不是无意泄漏。

**站住的危害路径（对抗性核实后）：**
1. 打开第 11+ 个文档 → 旧文档挤出 Recent → **下次启动**删其 chat（即使用户仍能从磁盘打开该文件）。`loadChat` 在 `addRecentFile` **之前**执行，重开无法「抢在 prune 前」救回已删历史。  
2. 启动时路径暂时不可用（外置盘/云盘）→ `restoreAllowedPaths` failed → 移出 Recent → **同一次启动**即可删 chat。

**不构成误诊的原因：** 即使用户「记得路径再打开」，chat 已在 prune 时删掉；不是「只是 UI 里看不见」。

**修法：** 聊天保留集与 Recent 解耦（独立 TTL / 显式确认 / 仅删「文件确认不存在」的条目）。

---

### N2. 低危 — `hasStoredApiKey` 绕过 keychain 阻断备忘录
**类别：** Bug（削弱 3.5.13；影响面小于「风暴」叙事）  
**位置：** `settings.ts:502-504` vs `556-567`；`loadSettingsMeta` 只查 **active** provider

`loadApiKey` / migration 尊重 `keychainBlockedThisSession`；`hasStoredApiKey` 在无 mirror 时仍 `keychainGet`。连接状态刷新可再探一次 keychain，**不是**索引扫页那种数百次风暴。

**修法：** blocked 时直接 `false`，与 `loadApiKey` 同守卫。

---

### N3. 中低危 — 关窗 flush 未 `stampMissingFinishedAt`
**类别：** Bug（展示/时长，非内容丢失）  
**位置：** 切文档已 stamp（`SessionProvider` ~254）；关窗 `flushChatNow` 未 stamp

`onFinish` 会 `setMessages` 打 `finishedAt`，但切文档注释已承认 ref 可能尚未吃到这次更新——关窗走同一 `messagesRef` 快照，竞态同类。后果是重开后 duration 虚高，**不是**丢掉消息正文。

**修法：** flush / autosave 共用 stamp。

---

### N4. 低危 — 部分命令仍直连 `invoke`
**类别：** Consistency  
写文件/注册路径等未统一 `invokeCmd`；调用方若只认 `Error` 可能丢原因。

---

### N5. ~~双击 busy 回填草稿~~ → **误诊，已撤销**
见 §八。原先把「busy 拒绝后 `!sent` 回填」当成实害；`composerDraftRef` 在同轮仍持旧非空草稿，回填条件 `!composerDraftRef.current` 不成立。

---

## 三、仍最影响 AI 质量的未修项（按核实后 ROI）

1. **A1** — 索引/vision 失败以「成功空页」返回 → 幻觉式否定（Medium，实害）  
2. **A3** — search 不报未索引页（Medium）  
3. **A2** — 元工具 `stopWhen` 可在无合成答案时结束（Medium）  
4. **W3** — 工具能力启发式硬挡发送（Medium）  
5. **W2** — 编辑丢 webSearch（Medium）  
6. **P3** — vision 只抽可见文字（Medium）  
7. **A4** — 整篇英文 hint 漏检（**Low**：预算已统一，勿再当成「静默砍预算」）  
8. **W1** — 一步 web search（**Design**：3.5.11 有意成本控制）  

CHANGELOG Known 仅列 Rust `Document` 缓存；上表假阴性未列入 Known。

---

## 四、安全与偏好（仍开）

| 项 | 说明 |
|----|------|
| S2 | 导出父目录仍持久化并 restore → 长期写权限 |
| U1 | Discard 竞态可写脏 AI 设置/密钥草稿（核实仍成立） |
| U2 | 关窗 flush 失败仍关窗 |
| U3 | 移出 Recent 不撤 allowlist |
| U5 | `store:default` 过宽 |
| docs | SECURITY「临时」明文 key / web egress / RELEASE 版本示例可能滞后 |

---

## 五、预览 / Chat UX（仍开）

V1 Retry 不可达、V2 缩略图 pitch、V3 follow-agent、V4 ctrl+wheel；C1 切文档丢 chat；C5 regenerate 选项；Pages read 对 `input-available` 仍乐观。

---

## 六、建议修复批次（对抗性核实后）

**P0 — 数据**  
N1（与 Recent 解耦）、C1、U2  

**P0 — Agent 假阴性**  
A1, A3, A2  

**P1 — 设置正确性**  
U1（Discard）、W2、W3  

**P1 — 安全契约**  
S2 ephemeral 导出、U3 revoke、U5  

**P2 — 预览 / 次要**  
V1–V3, N3, P3, A5–A7  

**P3 — 提示词/文档**  
A4, A8, W1（若要改产品策略再动）、docs drift  

---

## 七、本轮未跑项

- 未安装 `node_modules`，未跑 Vitest / `tauri build`。  
- Rust 未在审查环境编译。结论为源码静态核实。

---

## 八、对抗性再核实（避免误诊）

方法：对每个候选写「尝试反驳」；反驳成功则撤销或降级；失败才保留。

### 8.1 误诊 / 撤销

| 项 | 原主张 | 反驳证据 | 结论 |
|----|--------|----------|------|
| **C6 / N5** | 双击发送会把已发送草稿填回 | `composerDraftRef.current = composerDraft` 仅在 render 更新；同轮二次提交时 ref 仍为旧非空文本，`if (!composerDraftRef.current)` 不回填；`sendingRef` 同步挡住二次 agent 发送；`interactionBusy` 在 re-render 后挡住后续点击 | **撤销** |
| **pdf cancel 重试「掩盖真取消」** | 假 cancelled 重试可能忽略用户 Stop | 重试条件含 `!signal.aborted`；用户 abort 时 signal 已置位 | **不成立** |

### 8.2 降级（主张过强）

| 项 | 原严重度 | 反驳 | 调整后 |
|----|----------|------|--------|
| **A4** | 当作主要 AI 阻塞 | 3.5.9 后预算/步数**不再**被 intent 门控；漏的只是 `buildWholeDocumentInstructions` 强覆盖脚本；system prompt 已有 outline 指引 | **Low**（提示词质量） |
| **W1** | 写成缺陷 | 3.5.11 明确改为「每条消息一次 web」以防 30 次计费 | **Design / 已知权衡** |
| **N2** | Medium「风暴回潮」 | `loadSettingsMeta` 只查 active provider；刷新次数远少于索引扫页 | **Low** |
| **N3** | Medium 数据问题 | 只影响 `finishedAt`/duration 展示 | **Low–Med（展示）** |
| **A5** | 硬说「到不了 200k」 | 模型可提高 `maxChars`（上限 50k）；默认偏保守不等于硬封顶 | **Low–Med** |
| **A1** | 若曾报 High | tool 仍返回成功空页（实害在），但更准确是假阴性而非崩溃级 | **Medium** |

### 8.3 核实后仍站住（摘要）

| 项 | 尝试反驳 | 为何反驳失败 |
|----|----------|--------------|
| **N1** | 「有意清理 / 重开能恢复」 | 有意 ≠ 无害；`loadChat` 在 `addRecentFile` 前，且 prune 已删 key；临时路径失败会误删 |
| **U1** | 「discardPending 清了 dirtyRef」 | `persist()` **不读** dirtyRef；`setDirty(false)` 在 await 之后，400ms timer 可在窗口内触发并写下脏 `settingsRef` |
| **U2** | 「flush 几乎总成功」 | `finally` 无条件 destroy；失败路径明确存在且无重试 UI |
| **A1** | 「source:vision + prompt 已警告」 | 无 `indexFailed`/错误字段；prompt 警告的是 search 空，不是「成功空读」 |
| **A2** | 「最后一步有 toolChoice:none」 | meta `stopWhen` 可在远早于 `runMaxSteps-1` 时结束，届时无合成强制 |
| **A3** | 「outline 已有 unindexed」 | Agent 常先 search；search 结果无该信号 |
| **V1** | 「点 Settings 也算修复入口」 | Retry 行在 `indexHintActionable` 为真时不可达；生产几乎总有 `onOpenAiSettings` |

### 8.4 本轮未发现的「新」High/Medium

在 invoke 缺口、streaming reveal、extract cancel 重试、index key abort 等路径上，对抗性搜查**未**再确认独立于上表的新高中危项。
