# PageWise v3.5.13 代码与文档审查

日期：2026-07-17 · 基线：`main`（`7331c40` / `2adf6fc`，**v3.5.13**）。
方法：相对 v3.5.12 审查清单做回归核实 + 三路深挖本版 diff（IPC·Rust / settings·keychain / session·chat prune）与仍未触及的 Agent 路径。高危项对照当前源码二次核实。

整体结论：v3.5.13 正确关掉了 **S1（读路径可写）**、旋转页选区、IPC 字符串错误坍塌、keychain 风暴（主体）等实害项；**Agent 假阴性与整篇意图漏检几乎未动**。本版新引入一处高危数据风险：**以 Recent≤10 为 keep-set 驱逐 orphan chats，可能删掉仍有价值的对话历史**。

---

## 〇、相对 v3.5.12 审查的处置状态

| ID | 主题 | 状态 | 证据摘要 |
|----|------|------|----------|
| S1 | 打开的文件路径可写 | **Fixed** | `lib.rs` 写授权仅 `set.contains(canon_parent)` |
| S2 | 导出目录持久化 | **Open** | `save-markdown` → `allowPathPersisted` 仍在 |
| A1 | vision 失败当空白页 | **Partial** | 仍 `after?.text ?? ""`；显式读 generation 路径有改善 |
| A2 | 元工具空转无综合 | **Open** | `shouldForceReadTools` 仍仅测试 |
| A3 | search 无未索引信号 | **Open** | 仍 `{ hits, truncated }` |
| A4 | 英文整篇意图漏检 | **Open** | `summarize this PDF` 仍不命中 |
| A5 | 6k×30 吃不满 200k | **Open** | 默认未变 |
| A6 | outline/search 冲预算 | **Partial** | 有预检/计费，冲过仍可不打标 |
| A7 | search 无页多样性 | **Open** | 页序 first-N |
| A8 | PDF-only 文案 | **Open** | system prompt 未改 |
| W1 | web search 仅第一步 | **Open** | `webSearchForRun` 消费后置 false |
| W2 | 编辑丢 webSearch | **Open** | edit 载荷仍无字段 |
| W3 | isToolModel 硬挡发送 | **Open** | Composer 仍要求 `agentToolsSupported` |
| W4 | vision 丢 HTTP status | **Open** | `vision-api.ts` 未改 |
| P3 | vision 只抽字 | **Open** | prompt 未改 |
| C1 | 切文档 save 失败仍继续 | **Open** | toast 后继续 load |
| C2 | parts 未校验 | **Partial** | 行级规范化有，part schema 无 |
| C3/C4 | Pages read 高估 | **Partial** | cancelled/budget 已跳过；`input-available` 仍计 |
| C5 | regenerate 选项易失 | **Open** | 仍 `lastSendOptionsRef` |
| C6 | 双击发送 | **Partial** | `sendingRef` 挡住二次 agent 发送；busy 拒绝仍会 restore 草稿 |
| U1 | Discard 竞态写脏设置 | **Open** | `discardPending` 仍不清 timer / persist 不看 dirtyRef |
| U2 | 关窗 flush 失败仍 destroy | **Open** | `finally { destroy }` |
| U3 | 移除 Recent 不撤 allowlist | **Open** | 仍只改 `recent.json` |
| U5 | `store:default` | **Open** | capabilities 未收窄 |
| V1 | vision 失败无 Retry | **Open** | actionable 分支仍盖住 retry 行 |
| V2 | 缩略图 gap | **Open** | 112 vs gap 8 |
| V3 | follow-agent 误跳 | **Open** | hydrate / input-available |
| V4 | ctrl+wheel 翻页 | **Open** | 无 modifier 守卫 |
| L13 | 启动 restore 失败无提示 | **Partial→改善** | 失败 Recent 会 prune；toast 仍未必展示 |

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
**类别：** Bug / 数据丢失  
**位置：** `src/lib/recent-files.ts:5`（`MAX_RECENT = 10`），`src/session/SessionProvider.tsx:130-141`，`src/chat/persist.ts:70-79`

`pruneOrphanedChats(kept)` 删除**一切不在 keep 集合里的 chat key**。keep 来自当前 Recent 列表（上限 10，且启动时还会丢掉 restore 失败的路径）。用户打开第 11 个文档 → 最旧 Recent 出局 → **下次启动其整段对话被永久删除**，即使文件仍在磁盘、用户仍记得路径。

临时不可用（外置盘未挂载、云同步延迟）也会进 `failed` → 移出 Recent → 同一次启动即可删 chat。

**修法：** 不要用「当前 Recent」当唯一保留集。可选：单独 `chat-index` 记录活跃文档；仅删 N 天未打开且不在 Recent 的；或 prune 前确认文件不存在且用户确认；至少提高保留窗口并与 Recent 解耦。

---

### N2. 中危 — Keychain 阻断备忘录被 `hasStoredApiKey` 绕过
**类别：** Bug（削弱 3.5.13 修复）  
**位置：** `src/lib/settings.ts:502-504` vs `556-567`，`loadSettingsMeta` → `useConnectionStatus`

`loadApiKey` 尊重 `keychainBlockedThisSession`；`hasStoredApiKey` 在无 mirror 时仍无条件 `keychainGet`。连接状态刷新可继续打被拒的 keychain，部分抵消「不再风暴」的目标（尤其多 provider 轮询）。

**修法：** `hasStoredApiKey` 在 blocked 时直接 `return false`（或只信 mirror / cleared 标志）；与 `loadApiKey` 同一守卫。

---

### N3. 中危 — 关窗 flush 路径未 `stampMissingFinishedAt`
**类别：** Bug  
**位置：** `SessionProvider` 切文档已 stamp（254+）；关窗 `flushChatNow` 仍传原始 `messagesRef`（164-178）

中止流后立刻关窗，最后一条可能无 `finishedAt`，重开后 duration 虚高——正是 3.5.13 为切文档修的问题，关窗漏了。

**修法：** flush / autosave 共用 stamp 包装。

---

### N4. 低危 — `write_text_file` / `register_allowed_path` 等仍直连 `invoke`
**类别：** Consistency  
**位置：** `save-markdown.ts`、`allowed-paths.ts`、`api-key-store.ts`

`invokeCmd` 只铺到 PDF extract / read_file_bytes。写文件失败若调用方 `instanceof Error`，仍可能丢真实原因。

**修法：** 文件与密钥命令统一走 `invokeCmd`。

---

### N5. 低危 — C6 草稿回填残留
**类别：** Bug（Partial）  
**位置：** `ChatPanel.tsx:198-200`，`useDocAgent.ts:411-414`

二次点击被 `sendingRef` 拒绝后，`!sent` 仍把草稿填回——用户会以为没发出去，同时第一次发送在飞。

**修法：** busy 拒绝与 validation 失败分错误码；仅后者 restore。

---

## 三、仍最阻塞 AI 的未修项（按 ROI）

1. **A1** — 索引/vision 失败 → 空白 → 幻觉式「文档没有」  
2. **A3** — search 不报未索引页（outline 已有，search 没有）  
3. **A4** — `summarize this PDF` / `Summarize the paper` / `review every section` 仍漏检（`summarize all pages` 可命中）  
4. **A2** — 元工具空转停跑无答案  
5. **W3** — 工具能力启发式硬挡发送  
6. **W1/W2** — web search 一步失效 / 编辑丢选项  
7. **A5/A6** — 步数与预算会计  
8. **P3** — vision 只抽可见文字  

CHANGELOG「Known / deferred」仅列 Rust `Document` 缓存；**上表 Agent 假阴性未列入 Known**，产品上仍是主痛点。

---

## 四、安全与偏好（仍开）

| 项 | 说明 |
|----|------|
| S2 | 导出父目录仍持久化并 restore → 长期写权限 |
| U1 | Discard 竞态可写脏 AI 设置/密钥草稿 |
| U2 | 关窗 flush 失败仍关窗 |
| U3 | 移出 Recent 不撤 allowlist |
| U5 | `store:default` 过宽 |
| docs | SECURITY 仍偏「临时」明文 key；web search egress / RELEASE 版本示例可能仍滞后 |

---

## 五、预览 / Chat UX（仍开）

V1 Retry 不可达、V2 缩略图 pitch、V3 follow-agent、V4 ctrl+wheel；C1 切文档丢 chat；C5 regenerate 选项；Pages read 对 `input-available` 仍乐观。

---

## 六、建议修复批次（相对 v3.5.13）

**P0 — 数据**  
N1（orphan chat prune 与 Recent 解耦）  

**P0 — Agent 假阴性**  
A1, A3, A2, A4  

**P1 — 本版回归修补**  
N2（hasStoredApiKey）、N3（close stamp）、U1、U2  

**P1 — 安全契约**  
S2 ephemeral 导出授权、U3 revoke、U5 收窄 store  

**P2 — Web / 能力门 / 预览**  
W1–W4, W3, V1–V4, C1, C5, N5  

**P3 — 预算与管线**  
A5–A8, P3；以及 CHANGELOG 已 deferred 的 Rust 解析缓存  

---

## 七、本轮未跑项

- 未安装 `node_modules`，未跑 Vitest / `tauri build`。  
- Rust 未在审查环境编译。结论为源码静态核实。
