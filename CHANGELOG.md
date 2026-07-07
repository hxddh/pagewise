# Changelog

All notable changes to PageWise are documented here. Version numbers follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [3.4.2] - 2026-07-07

### Fixed

- Chat: reasoning-only assistant messages (e.g. a stream stopped before the answer) now promote their reasoning as the visible answer instead of rendering an empty collapsed block (`hasAnswerText` no longer counts reasoning parts)
- Settings: a transient store I/O failure during startup key migration no longer poisons the memoized promise for the whole session (reset-on-reject so reads retry) — previously it could wedge the settings UI on the loading skeleton
- Agent: the meta-tool loop guard now stops only on a genuine spin (the same outline/search call repeated), so distinct refined searches after a read are no longer truncated as a "loop"
- Streaming: a user abort mid-stream can no longer surface as an unhandled rejection when closing the progress-injection stream

## [3.4.1] - 2026-07-07

### Fixed

- Vision index: cap encoded page long-edge at `maxEdge` independent of display DPR — retina renders no longer upload ~2x the intended pixels/tokens (`visionRenderScale`)
- Chat history: tool-output compaction is now idempotent — re-pruning an already-compacted output no longer overwrites the original char/hit count with the summary's own length
- Secrets: keychain get/set/delete run off the main thread (`spawn_blocking`) so an OS prompt or Secret Service round-trip can't freeze the window
- Index events: `clearPageIndexState`/`clearDocumentIndexState` no longer re-insert an `idle` entry, so the per-page state map actually shrinks instead of growing across the session
- Session: guard the window-close listener registration against a rapid document switch tearing the effect down before it resolves (no orphaned close handlers)
- PDF bytes cache: refresh recency on cache hit so the LRU evicts least-recently-used, not least-recently-inserted
- Document search: trap focus within the search dialog like the other overlays
- Agent: meta-tool-only loop guard now fires on a recent all-outline/search window even if a read happened earlier in the run, instead of being disabled for the rest of the turn by a single early read
- Theme: OS light/dark changes in "system" mode now re-render `useTheme().resolved`, not only the `<html>` attribute

### Removed

- Dead code: unused `documentTools` export, unused `renderPageToPngBytes`, and the phantom `list_documents` activity label (+ its orphaned i18n key)

## [3.4.0] - 2026-07-06

### Fixed

- Agent: OpenRouter unknown models use tool-capability heuristics instead of hard reject (M8)
- Agent: stop meta-tool-only loops (outline/search without reads) via existing loop guards (M7)
- Settings: clear false "Unsaved" when edits match last saved snapshot (L1)
- Session: wait for stream idle before flush on window close; restore allowed paths on startup
- Markdown: strip react-markdown `node` prop from safe link/image renderers (L4)
- Connection status: fall back to `DEFAULT_SETTINGS.provider` when settings load fails (L6)
- Preview: clamp corrupted zoom values from localStorage (L13)
- Preview: remove dead `need_vision` index failure branch

### Changed

- Export chat: command palette uses session export; unified `{basename}-chat.md` naming (L5)
- Toast: reindex message explains 50-page vision limit

## [3.3.0] - 2026-07-06

### Security

- Asset protocol: remove blanket `$HOME/**` scope; allow only files registered via `register_allowed_path` (runtime `asset_protocol_scope.allow_file`)
- PDF: catch panics from `pdf_extract` in blocking workers; release profile uses `panic = "unwind"` so a malformed PDF no longer aborts the whole app (H6)

### Changed

- Agent: per-send view context flows through `runtimeContext` (transport consumes queue → `prepareCall` reads `messageContext`) instead of a second consume in `prepareCall`

## [3.2.0] - 2026-07-06

### Fixed

- Index queue: generation-aware cancel/restart; vision fetch aborts with queue signal; stale inflight no longer blocks reindex (H4/M4)
- Reindex: only clears page text for pages about to be vision-rescanned (max 50), preserving native text on other pages (H3)
- Images: multimodal chat sends `data:` URLs instead of local `asset://` paths (M2)
- Vision render: cap page JPEG/PNG scale to `maxEdge` (1568px) (M6)
- Session: read latest messages from ref on doc switch; flush chat on window close (M3)
- Theme: shared `ThemeProvider` so command palette and settings stay in sync (M9)

## [3.1.1] - 2026-07-06

### Fixed

- Agent: align prompts, prune list, and UI labels with actual tool names (`document_outline`); whole-document flow no longer calls removed tools
- Agent: `document_outline` outputs are compacted in chat history (token budget restored)
- Settings: "Discard & close" no longer persists abandoned edits on drawer unmount
- Index: cancelled vision scans emit `idle` instead of `failed`
- Chat persist: retry `Store.load` after a failed open instead of caching a rejected promise

### Changed

- Docs: README/CONTRIBUTING/SECURITY updated for v3 architecture (no Tesseract; correct transport and chat filename)

## [3.1.0] - 2026-07-06

### Changed

- Architecture slim (S1–S5): delete unused agent compaction/rerank/citations modules; clean OCR strings and dead CSS; `useWorkbenchOverlays` + `RecentFilesList`; extract `agent-stream-idle`

### Removed

- Dead v2 agent code: `agent-context-compaction`, `search-rerank`, `citations` parser, `model-routing`, `agent-run-plan`, `agent-activity-line`, `messages-signature`

## [3.0.3] - 2026-07-06

### Added

- Image documents restored: PNG, JPG, WebP, TIFF, BMP, GIF open with vision indexing and multimodal chat

### Fixed

- Session: transactional doc switch — defer cache commit until load + chat hydrate succeed; no eviction on failure
- Session: `waitForStreamIdle` before saving chat on switch; same-path re-open is a no-op; block opens while loading
- UI: clear-chat confirm uses overlay lock; settings and library drawer are mutually exclusive
- Recent files: Welcome and drawer share `openableRecentFiles()` filter and opening disabled state
- Index: dedupe per-page vision work; images use `readAuthorizedFileBytes` for scan
- Prefs: rollback follow-agent toggle on persist failure
- Follow-agent: tracks last assistant turn, not only while streaming

### Removed

- Dead v2 code: `ThreadSelector`, `chat-doc-snapshot`

## [3.0.2] - 2026-07-06

### Added

- Recent files drawer: Rail library button opens full recent PDF list (open, remove, switch document)

## [3.0.1] - 2026-07-06

### Fixed

- Session: chat hydrate after `chatId` aligns; abort in-flight loads on doc switch; isolate `saveChat` errors
- Index: use `loadVisionSettings()` for scan pages; reindex via `docCache.invalidateIndexedPageText`
- UI: wire composer prefs, `editUserMessage`, export summary, command palette, follow-agent
- Preview/search: sync `document` from `docCache`; text layer + search update when index completes
- Settings: `onApiReady`, preferences revision for preview quality

## [3.0.0] - 2026-07-06

### Changed (breaking)

- **Greenfield v3 architecture**: single `SessionProvider` replaces `useAppShell` / multi-hook orchestration
- **One PDF at a time**: `MAX_CACHED_DOCS = 1`; transactional `switchDocument` with chat persist per file path
- **Single chat thread** per document (`chat/persist.ts`); removed multi-thread UI, library drawer, command palette
- **Vision-only indexing** via `document/index-queue.ts`; removed OCR/Tesseract (Rust + UI)
- **Keyword search only**; removed semantic embeddings and `semantic-index`
- **Agent tools simplified** to `document_outline`, `read_pdf_page` / `read_pdf_range`, `search_in_document`
- **No structured citations** (second LLM pass removed); legacy citation metadata still displays from v2 chats
- **PDF only** — image documents no longer supported in `load-document.ts`

### Fixed

- Chat: composer draft state wired in `App.tsx` (v3 regression blocked all input)

### Removed

- `vision-index`, `semantic-index`, `embeddings`, `structured-citations`, `chat-sessions`
- `useAppShell`, `useDocumentWorkspace`, `useChatPersistence`, `useLibraryState`, `useAgentWorkspace`
- `LibraryDrawer`, `DocumentLibrary`, Rust `ocr.rs` and Tesseract commands

## [0.2.46] - 2026-07-06

### Fixed

- Reindex: invalidate `docCache` page text + semantic index; `forceReindex` bypasses cache short-circuit
- Index: `clearPageIndexState` emits `idle` to subscribers; background index no longer binds agent abort
- Index: pool 429 falls through to OCR; PreviewPane retries only on timeout (not rate limit)
- Reindex: single entry via `reindexActiveDoc` (removed `indexRevision` double-sweep)
- Chat: doc-switch snapshot taken after `waitForStreamIdle`; load failure triggers rollback
- Agent: send `finally` generation guard; image-fallback rolls back context queue; `clearChat` aborts citations
- Agent: `prepareForAgentSend` guards after `await`; `ChatPanel` uses `agentBusy` for interaction lock
- PDF: render stale checks after each `await`; cancel in-flight paints on `clearPdfCache`; text layer on cache hit
- PDF: thumbnails/text export honour stale callbacks; `readAuthorizedFileBytes` for vision images
- Rust: `read_file_bytes` size cap (256 MiB), chunked read with cancel generation; Tesseract 120s timeout + kill

## [0.2.45] - 2026-07-06

### Fixed

- PDF: single `clearPdfCache` owner on doc switch (removed duplicate from `usePdfViewer`)
- PDF: stale `getPdfDocument` loads retry instead of returning destroyed pdf.js docs
- PDF: `cancel_file_read_cmd` + JS generation guard discards stale IPC byte reads
- Index: `indexSparsePages` runs after workspace sets new abort controller (not during load)
- Index: auth/rate-limit vision errors surface as `vision_failed`, not `insufficient_text`
- Index: `embedMany` honours abort between batches
- Preview: reindex on successful connection test; `indexRevision` clears failed pages
- Preview: retry + settings for `vision_failed`; exponential backoff for rate limits
- Agent: `agentGenRef` guards `onFinish`, `onMessagesRepaired`, citations use live `totalPages`
- Agent: `deleteSession` resets agent; `waitForStreamIdle` timeout forces `resetForDocumentSwitch`
- Agent: regenerate truncates trailing assistant; `historySettling` cleanup on prune skip
- Chat: clear chat clears agent error state
- Rollback: `abortDocumentSwitch` reconciles PDF cache via `clearPdfCache`

## [0.2.44] - 2026-07-06

### Fixed

- PDF: `getPdfDocument` load-generation guard — stale loads no longer destroy the active preview document
- PDF: LRU cap on `pdfBytesCache`; prefetch skips non-active paths
- Agent: block doc/thread switch during pre-stream send (`sendGen`, `isAgentBusy`, `abortPendingSend`)
- Agent: `chatId` change stops in-flight send; image-fallback restores view context on retry
- Agent: regenerate reuses original `includeViewingPage`; rollback by `messageId`
- Chat: `waitForStreamIdle` waits for pre-stream send; 10s settle timeout
- Chat: `clearChat` creates a fresh empty thread instead of loading another thread's history
- Chat: `persistSignature` unified in doc-switch dirty detection
- Transport: sync UI when `validateChatMessagesForSend` repairs history
- Index: `abortDocumentSwitch` resets background index controller for rollback
- Index: OCR/render paths honor `AbortSignal`; `embedMany` passes `abortSignal`
- Index: search indexes sparse pages before keyword pass; background sparse index on doc open
- Index: `mergePageTextsOnReload` keeps vision/OCR text when PDF page count shrinks
- Agent: `assertPageInBounds` rejects reads when `totalPages === 0`
- Preview: no auto-retry on permanent `vision_failed`; indexed badge requires usable text
- Settings: custom provider skips vision without scan model; Ollama unknown models assumed tool-capable
- Settings:「设为活跃」shows model validation error
- UI: sidebar「已连接」requires tool-capable agent; persistence errors i18n (zh-CN)

## [0.2.43] - 2026-07-05

### Fixed

- Agent: Regenerate reads `messagesRef` — no stale user message after thread switch
- Agent: stop agent immediately when opening a new document (`onBeforeLoad`)
- PDF: scoped cancel generations (`load` vs `agent`) — doc load no longer kills agent tool reads
- Agent: remove duplicate `clearAgentRunAbortSignal` on status ready (transport owns lifecycle)
- Citations: `resetForDocumentSwitch` aborts in-flight `streamObject`
- Index: `abortDocumentSwitch` aborts background vision controller
- Chat: `selectThread` reports errors; `persistSignature` unifies dirty detection
- Chat: tab-hide save failure surfaces toast

## [0.2.42] - 2026-07-05

### Fixed

- PDF (Rust): single-page `read_pdf_page` extracts one page only — no longer parses the entire document on cache miss
- PDF (Rust): cooperative cancellation via `cancel_pdf_extract_cmd` — Stop, doc switch, and superseded opens bail out between pages
- PDF: `getPdfPageCount` uses fast `pdf_page_count_cmd` instead of full text extraction
- Load: opening a document accepts `AbortSignal`; switching files aborts the previous Rust parse

## [0.2.41] - 2026-07-05

### Fixed

- Agent: keep abort signal wired until the UI stream finishes — Stop now cancels in-flight tools (PDF read, search, vision index)
- Chat: delete thread / clear chat / delete session wait for stream idle before mutating messages
- Citations: abort in-flight `streamObject` on new send or thread switch; reuse per-run settings snapshot
- Model: unknown Ollama/OpenRouter ids no longer assumed tool/vision-capable (indexing skips spurious vision attempts)

## [0.2.40] - 2026-07-05

### Fixed

- Chat: `validateChatMessagesForSend` repairs corrupt history (dangling tools, empty assistants) instead of blocking sends
- Agent: PDF page text extract honors AbortSignal — Stop returns immediately even if Rust IPC is still running
- Sessions: `saveActiveSession({ touchActive: false })` for background/doc-switch saves; explicit API prevents stealing active thread

### Added

- Tests: `validate-chat-messages`, `structured-citations`, `chat-persistence-flow`, transport abort lifecycle

## [0.2.39] - 2026-07-05

### Fixed

- Agent: honor Stop during PDF text extract and semantic search (abort checks + embed signal)
- Agent: snapshot settings per run so mid-run provider changes cannot swap models
- Agent: regenerate rebuilds page screenshot via `buildSendPayload` (same as edit/send)
- Agent: citation generation cancelled on new send; `citationsError` shown in footer
- Vision: block scan API when custom provider has no Base URL
- Model: unknown OpenRouter models no longer assumed tool-capable
- Runtime: default doc path only when exactly one document is loaded
- Chat: edit resend failures show inline error; autosave signature matches pruned disk shape
- Sessions: saving a background thread no longer steals `activeSessionId`
- Settings: prefer local API key mirror over keychain on every read
- Preferences: serialize read-modify-write with store lock

## [0.2.38] - 2026-07-05

### Fixed

- Chat: document switch no longer loses unsaved messages when `chatId` recreation clears in-memory state (per-doc snapshot cache)
- Chat: update `threadSessionId` before hydrating messages so thread/doc loads are not wiped
- Chat: wait for stream idle before doc/thread switch saves; quit flush fails closed after 5s timeout
- Chat: autosave works after delete-session / failed load while document stays open
- Agent: prune bulky tool outputs after error responses; clear abort signal in transport `finally`
- Preview: follow-agent ignores previous assistant tools while a new reply is in flight

## [0.2.37] - 2026-07-05

### Fixed

- Agent (OpenRouter): stop attaching page screenshots — AI SDK sends raw base64, which OpenRouter tries to fetch as a URL (`Failed to download image from iVBORw0…`)
- Chat: strip persisted user image parts on load/send for OpenRouter; text page context still injected

## [0.2.36] - 2026-07-05

### Fixed

- Agent: `sendMessage` failures are detected via `onError` (AI SDK does not throw) — image fallback, rollback, and regenerate error handling now work
- Preferences: “Include current page” no longer defaults to on before preferences load

## [0.2.35] - 2026-07-05

### Fixed

- Agent: OpenRouter page screenshots limited to verified routes (`openai/gpt-4o*`); Gemini/Claude no longer attach images (fixes false “scan model” errors and send failures)
- Agent: image-reject retry removes duplicate optimistic user row before resending text-only
- Agent: distinguish assistant vs scan image errors; auto-retry without screenshot when provider rejects images
- Chat: sanitize loaded sessions (drop `parts: []`) so corrupted history cannot block all sends
- Preferences: default “Include current page when asking” off — page context still injected as text

## [0.2.34] - 2026-07-05

### Fixed

- Chat: strip or reject messages with `parts: []` on load, persist, and send (fixes `validateUIMessages` "Message must contain at least one part" after stop/quit mid-stream)
- Chat: aborted assistant placeholders with no parts are removed on finish instead of being saved

## [0.2.33] - 2026-07-05

### Fixed

- Search: capped semantic embed merges vectors across rotations (full-doc coverage over rebuilds)
- Search: partial capped indexes no longer permanently disable semantic search after retry cap
- Search: opening a document no longer aborts its own in-flight embed build
- Chat: quit/hide while streaming stops the agent and flushes before close
- Chat: window stays open when flush fails on quit (no silent data loss)
- Chat: document-switch save failure reverts preview to the previous document
- Chat: `persist_cancelled` no longer surfaces as a user-facing error toast
- Chat: thread switch hydrates messages before updating `chatId`
- Chat: composer draft clears on thread switch
- Agent: structured citation extraction skips `reasoning` (provider compatibility)
- Agent: citation extraction ignores stale callbacks after thread/doc switch
- Agent: `read_pdf_range` rejects inverted ranges and out-of-range start pages

## [0.2.33] - 2026-07-05

### Fixed

- Agent: force read tools before synthesis/meta-loop guards (search→read flow)
- Agent: detect `budgetExceeded` inside AI SDK JSON tool-result envelopes
- Agent: do not reset read offset when page text shrinks after re-index
- Agent: `read_pdf_range` reports `requestedEnd`, `actualEnd`, and `rangeClamped` when end exceeds document length
- Chat: `messagesDocPathRef` prevents cross-document autosave corruption
- Chat: abort document switch when pre-save fails; clear messages on load failure
- Chat: loading overlay during thread/doc switch; cancel edit mode on switch
- Chat: history prune scoped to `chatId` (no cross-thread truncation)
- Chat: Tauri `onCloseRequested` awaits flush before window destroy (replaces unreliable `beforeunload`)
- Preview: follow-agent skips loaded history when no live agent context
- Search: per-document semantic embed abort (switching docs no longer cancels other builds)
- Search: embed cap uses spread sampling + rotation so tail pages eventually get vectors
- Search: drop partial semantic index after embed retry cap (rebuild on next open)
- Agent: `isAgentMultimodalModel` — only known vision+tools models get page screenshots
- Agent: structured citation extraction records `citationsError` metadata on failure
- LLM: parse OpenRouter `metadata.raw` for actionable provider errors
- LLM: skip fast-model routing for unknown OpenRouter model ids (no invalid fallback)

## [0.2.32] - 2026-07-05

### Fixed

- Chat: `useChat({ id })` binds synchronously — thread switch no longer writes messages to stale chat instance
- Chat: delete session syncs `chatId` with persistence (`onActiveSessionIdChange`)
- Chat: document switch blocks autosave during transition; persist failure no longer leaves cross-doc corruption
- Chat: `chatLoading` gates composer during thread/doc switch (prevents send during load)
- Chat: `switchThread` returns resolved session id when requested thread is missing
- Settings: V1 migration and keychain migration preserve plaintext mirror when keychain write fails
- Settings: keychain preferred over stale disk mirror; reconcile no longer aborts all providers on one failure
- Settings: `useConnectionStatus` handles load failures instead of hanging unconfigured
- Agent: only attach page screenshot when assistant model supports vision (fixes OpenRouter “Provider returned error”)
- Agent: map generic provider errors to actionable guidance

## [0.2.31] - 2026-07-05

### Fixed

- Agent: Stop now cancels in-flight tool-time indexing (abort signal kept until stream ends)
- Indexing: semantic embed build capped with failure backoff; no infinite retry loops
- Indexing: closed documents abort background indexing via doc cache guards
- Chat: persist failure blocks thread/document switch; autosave epoch bumped on delete
- Chat: `visibilitychange` / `beforeunload` flush reduces message loss on crash
- Search: document search always clears loading state on error
- Settings: test connection triggers reindex when scan model changes
- Settings: plaintext API key fallback surfaces a security warning in AI provider settings
- Preview: transient index failures auto-retry after 4s

### Added

- Vercel AI SDK: `useChat({ id })` binds chat to document thread session
- Vercel AI SDK: `rerank()` on semantic search hits (fuse + rerank path)
- Vercel AI SDK: `streamObject` for streaming structured citations in message metadata
- Vercel AI SDK: `output-error` tool steps shown with failed state in chat UI
- Vercel AI SDK: `sendMessage({ messageId })` edit-and-resend for last user message
- Vercel AI SDK: multimodal `files` part when sending with viewing page attached
- Vercel AI SDK: provider metadata and final-step tool names in usage stats popover

## [0.2.30] - 2026-07-05

### Fixed

- Settings: `hasStoredKey` probes Keychain so Agent UI no longer misreports missing API keys
- Settings: keychain migration no longer writes plaintext keys when Keychain is available
- Settings: serialized store writes prevent concurrent settings corruption
- Settings: test connection runs before persisting profile (no save-on-failed-test)
- Settings: About page shows chi_sim Chinese OCR pack status
- Settings: General tab keeps preference defaults in local state (decoupled from active doc)
- Chat: unified `opGenRef` guards document/thread switches against stale loads
- Chat: autosave updates snapshot from outgoing messages; metadata in signature
- Chat: persist errors caught on switch/autosave; `newThread` generation guard
- Chat: thread selector UI (switch / new chat per document)
- Chat: document switch no longer clears messages before persistence loads
- Chat: agent abort signal cleared when stream ends
- Search: semantic index keeps dirty on abort/incomplete builds; live page cache in search
- Search: document search uses request generation + loading state
- Indexing: join inflight runs honor agent Stop abort; doc-close abort via cache check
- Indexing: `insufficient_text` only when both vision and OCR fail
- Indexing: page text upserts merge with `pickBetterPageText` (agent + cache)
- Preview: retry button on failed page index; PDF cache cleared only on path change
- Shell: API ready no longer triggers automatic full reindex
- Shell: AppRail connected when API key is configured (not gated on tool model)

## [0.2.29] - 2026-07-05

### Fixed

- Preview: stop infinite re-index loop on permanently failed pages (retry only on reindex)
- Chat: persist messages on document/thread switch even during streaming (sanitized + pruned)
- Chat: autosave binds session id at schedule time (no cross-thread corruption)
- Chat: stronger message signature for dirty detection; prune tool outputs on persist
- Agent: keep abort signal alive until stream ends so Stop cancels tool-time indexing
- Search: semantic index rebuilds when dirty after in-flight OCR; guard zombie writes on doc close
- Search: UI document search uses hybrid semantic + keyword (aligned with agent)
- Indexing: OCR render capped at 1568px edge like vision path
- Indexing: joined inflight index runs honor caller abort signals
- Settings: API keys only mirrored to disk when keychain unavailable
- Settings: no silent reset of user-selected chat-only agent models on restart
- Settings: close confirm when AI tab dirty on any settings tab
- Preview: sanitize index error details; i18n render failures
- Chat: regenerate gated on API key and tool support like send
- Merge: prefer substantially longer native extract over stale OCR on reopen
- Rust PDF cache: LRU touch on hit

## [0.2.28] - 2026-07-05

### Fixed

- Chat: stop streaming when switching threads or reloading the same document
- Chat: skip autosave of truncated replies while a stream is in progress
- Chat: update loaded snapshot after autosave to avoid redundant writes
- Indexing: reopen merge prefers cached vision/OCR text over Rust re-extract when both meet threshold
- Indexing: Stop aborts in-flight tool-time page indexing via shared abort signal
- Indexing: unified per-page inflight dedupe (no duplicate pool/single runs)
- Search: semantic index build uses single-flight lock (no concurrent double-build)
- Search: toast when semantic embedding hits the 50-page cap
- Reload: same-path reopen preserves index UI state instead of clearing badges
- Settings: custom provider with empty scan model no longer falls back to agent model (OCR-only)

## [0.2.27] - 2026-07-05

### Fixed

- Agent: PDF extract path now requires ≥20 chars before returning (aligned with vision index threshold)
- Indexing: reopening the same file preserves vision/OCR text instead of wiping the cache
- Search: semantic index rebuilds correctly after background indexing and document reload
- Chat: unsaved messages are persisted before same-path document reload
- Indexing: separate in-flight dedupe for preview vs bulk sweep (429 halt works correctly)
- Preview: re-index when status is `done` but page text is still too short
- Settings: block provider switch / set active when save fails
- Settings: preserve explicit DeepSeek scan model distinct from agent model

### Changed

- Settings: custom provider gets a dedicated scan model field
- Indexing: cap toast reports successful pages; partial-failure toast when some pages fail
- Doc cache: `remove()` also clears per-page index state

## [0.2.26] - 2026-07-05

### Fixed

- Indexing: clear stuck “Indexing…” badge on document switch or abort
- Indexing: dedupe concurrent per-page index runs; cancel background index on doc switch
- Indexing: custom OpenRouter/Ollama scan model IDs are no longer silently replaced at runtime
- Indexing: fall back to local OCR after vision rate-limit (429), not only on other errors
- Indexing: retry when index state is `done` but cached text is still too short
- Agent: `read_pdf_page` waits for sufficient indexed text (≥20 chars), same as background index
- Agent: stream setup errors propagate correctly (no masked `undefined.stream` TypeError)
- Settings: persist unsaved edits before switching AI provider tab
- Settings: custom assistant and scan model IDs allowed; test connection probes scan model for all providers

### Changed

- Settings: optional scan model input when provider has no scan presets (e.g. DeepSeek)
- Indexing: toast when background sweep hits the 50-page cap
- Vision API: restore index token usage tracking; faster JPEG data-URL encoding
- Doc cache: evicting a document also clears its index state

## [0.2.25] - 2026-07-05

### Fixed

- Indexing: send scan images as `data:image/jpeg;base64,...` URLs (fixes OpenRouter “Invalid URL format: /9j/…”)

## [0.2.24] - 2026-07-05

### Fixed

- Indexing: migrate away from unreliable `google/gemma-4-31b-it:free` scan preset; test scan model on “Test connection”
- Indexing: surface API error details in preview badge when vision extraction fails

### Changed

- OpenRouter scan presets: remove Gemma 4 free tier; keep Gemini Flash Lite, Qwen3-VL, Gemma 3

## [0.2.23] - 2026-07-05

### Fixed

- Indexing: retry after failure when scan model changes; reindex active doc on scan model save
- Indexing: show “check API key and scan model” when vision API fails (not misleading Tesseract hint)
- Indexing: use `image` content type for vision API; fall back to default scan model when stored id is not vision-capable

## [0.2.22] - 2026-07-05

### Fixed

- Settings: scan model always shows preset dropdown (custom input only after choosing “Custom model…”)
- Settings: migrate legacy shared agent/scan model id to default scan preset on load

### Changed

- Settings: reorganize AI provider into Connection / Models / Advanced sections
- Settings: rename “Indexing model (vision)” → “Scan model”; add field hints for assistant vs scan
- Settings: show Extended thinking only for DeepSeek-capable assistant models; auto-clear when unsupported
- Settings: simplify provider grid (remove badge clutter; dot marks provider in use)

## [0.2.21] - 2026-07-05

### Changed

- Settings: simplify AI provider presets to flat assistant + scan model lists (OpenRouter 2+4 models)
- OpenRouter scan default → `google/gemini-2.5-flash-lite`; add Gemma/Qwen3-VL free and budget options
- Remove outdated OpenRouter presets (72B VL, Claude, Chat-only DeepSeek routes)

## [0.2.20] - 2026-07-04

### Fixed

- UI: move agent progress inline below the current turn (inside the assistant bubble / pending reply), not fixed at panel top
- Streaming: client-side segment reveal during live answers so text animates even when the provider batches one large delta

## [0.2.19] - 2026-07-04

### Fixed

- Agent: wire targeted factual queries to a real 6-step cap (`stopWhen` + `prepareStep`) instead of display-only
- UI: show step progress from step 1 with elapsed time at 0s; keep progress bar visible during reasoning-only phases
- Streaming: replay agent progress emitted before the UI stream subscribes (search-hit preview no longer dropped)

## [0.2.18] - 2026-07-04

### Changed

- Streaming UX: CJK-friendly `Intl.Segmenter` chunking without artificial delay; plain-text tail while live, full markdown when done
- UI: single unified progress bar with step index, elapsed time, and search-hit preview; tool fold collapses when idle
- Agent: targeted factual queries cap at 6 steps; synthesize immediately after read/search tools; brief status sentences in system prompt
- UI: lower substantial-text threshold (8 chars, includes reasoning); reasoning expanded during live stream; settling transition after history prune

## [0.2.17] - 2026-07-04

### Fixed

- Agent: `compactStaleToolResults` now preserves `ToolResultOutput` schema when truncating tool results, fixing `Invalid prompt: The messages do not match the ModelMessage[] schema` on multi-step runs

## [0.2.16] - 2026-07-04

### Fixed

- UI: strip spaced-pipe DSML tool markup (`< | | DSML | | invoke …>`) leaked as plain text by some providers
- Agent: force synthesis when a step’s answer text is DSML-only (tools ran but no user-visible reply)

### Changed

- Assistant footer: remove inline usage summary and per-step breakdown; full stats remain in the usage popover only


### Fixed

- Save/export: saving to a new file name no longer fails (`write_text_file` canonicalized a not-yet-existing target)
- Settings: editing an existing API key value is now persisted (dedup no longer collapses every key to a constant); explicitly-cleared keys are not resurrected when the keychain becomes available
- Storage: `recent-files` and `allowed-paths` serialize read-modify-write, preventing dropped entries under concurrent startup restore and user actions
- Semantic search: gate embeddings on provider capability instead of silently degrading to keyword; invalidate the index when OCR/vision text lands so scanned pages become searchable; bounded-batch embedding with per-batch failure isolation, page cap, 429 backoff, and abort; rebuild on embedding model/dimension drift
- Search ranking: fuse keyword + semantic results (Reciprocal Rank Fusion) instead of ranking purely by lexical term count
- Agent usage: per-step token counts are no longer double-counted (single-step replies showed "2 steps" and ~2× tokens)
- Agent: aggressive context compaction no longer forces synthesis on the same step it prunes; fast-model routing only applies to intermediate steps so the final answer uses the configured model; the final step is reserved for synthesis so a run cannot end without an answer
- PDF preview: thumbnails no longer stay permanently blank after a page turn cancels them; quality toggle keeps the loaded document instead of re-reading the whole file
- Citations: hallucinated pages beyond the document length are dropped; inverted ranges normalized

### Changed

- `read_file_bytes` returns raw bytes over IPC instead of a JSON number array (faster, less memory for large PDFs)
- Rust PDF text cache releases its lock during extraction and is bounded to 12 documents
- Vite build target set to `safari15` to match the WKWebView runtime baseline
- Usage-stats popover is keyboard/Escape dismissable; a single streaming status indicator is shown while awaiting the first reply

## [0.2.14] - 2026-07-04

### Fixed

- Agent: stop meta-tool loops (`list_documents` / `get_document_index` / `search_in_document` without reading pages)
- UI: strip DSML tool-call markup leaked as plain text by some providers (e.g. DeepSeek)

### Changed

- Agent: force `read_pdf_*` after search; block repeat list/index calls; cap steps at 14
- Agent: lower aggressive compaction threshold (20k cumulative step input tokens)


### Fixed

- Agent: fix streaming status disappearing on follow-up questions (`lastAssistant` pointed at the previous turn)
- Agent: continuous progress stream pump; placeholder bubble while awaiting first assistant chunk
- Provider: omit `reasoning` when thinking is off (fixes `reasoning_effort: unknown variant none` on switch)

### Changed

- Agent: AI SDK `prepareStep` compaction — tiered `pruneMessages` by tool type, usage-driven aggressive mode, synthesis step disables tools
- Agent: read tool default max chars 8k → 6k; compact search/index outputs in stale steps
- Usage: inline token summary on assistant footer; per-step breakdown expands when multi-step; live updates on `finish-step`

## [0.2.12] - 2026-07-04

### Fixed

- Agent: keep status visible during tool/reasoning phases; show "generating answer" between tools and final reply
- Streaming: reasoning block auto-expands while live; markdown stream caret during answer generation
- Tool steps stay expanded until the assistant message finishes

### Changed

- Agent: aggressive `prepareStep` pruning and stale read-tool compaction to lower multi-step input tokens
- Read tools default max chars reduced from 12k to 8k per call
- Usage stats label clarifies total input includes all agent steps; splits agent vs index when relevant
- Assistant footer actions use ghost icon buttons aligned with v3 message styling

## [0.2.11] - 2026-07-04

### Added

- Assistant message footer: copy, regenerate, and usage stats popover (input/output tokens, TTFT, speed, index vs chat split)
- Agent: `smoothStream` word chunking, structured citations via `generateObject`, and live tool-progress data parts
- Search: hybrid keyword + semantic retrieval with embedding index and lexical `rerank` pass
- Agent loop: `runtimeContext` default doc path, `prepareStep` fast-model routing, and `pruneMessages` for long contexts
- Export summary: `streamObject` structured Markdown export with streaming generation
- Debug: per-step token usage in stats popover (`onStepEnd` metadata)
- Tests: `ai/test` mocks for transport metadata, rerank, and export summary

### Changed

- Thinking/reasoning: top-level AI SDK `reasoning` parameter replaces custom fetch body injection (OpenRouter headers only)

## [0.2.10] - 2026-07-04

### Fixed

- Agent: prevent overlapping sends during settings load; rollback view context on send failure; restore composer draft on errors
- Settings: vision model restores correctly when switching providers; vision-only edits persist via debounced save
- Settings: explicitly cleared API keys are not re-imported from Keychain on migration retry
- PDF preview: cancelled renders are no longer cached as valid frames
- Indexing: clear stale index state on document reopen/reindex; require MIN_INDEX_CHARS before marking done; honor abort before OCR
- Path restore: prune missing paths from recents (no repeated startup toasts); register `/` parent for root-level files
- Security: `write_text_file` canonicalizes target path and rejects symlink escapes
- Streaming markdown: fence-aware paragraph split; tail renders markdown during live stream
- MessageContent: stronger parts signature and live prop memo; unique tool detail keys
- Follow agent: sync to the latest read tool page; re-scan when re-enabled
- docCache: evict oldest documents when cache exceeds 12 entries

## [0.2.9] - 2026-07-04

### Fixed

- Dock / bundle icon: brand dark background with accent stacked pages (matches in-app LogoMark colors)
- Logo geometry and palette centralized in `logo-mark-assets.json`; `app-icon.svg` generated from it
- Saved file paths that fail to restore on launch are pruned and surfaced via toast
- Streaming assistant replies: completed paragraphs are parsed once; only the tail re-renders during stream
- `verify-bundle-version` uses filesystem lookup instead of shell glob

### Changed

- `beforeBuildCommand` runs `icons:generate` so bundle icons stay in sync with logo assets
- `icons:generate` now regenerates `app-icon.svg` before rasterizing platform icons

## [0.2.8] - 2026-07-04

### Fixed

- About screen version now reads the macOS bundle version at runtime (matches Finder / Get Info)
- Release builds verify `Info.plist` `CFBundleShortVersionString` matches `VERSION`

### Changed

- Dock / app bundle icons regenerated to match in-app LogoMark (stacked pages + green dot, no black background)
- Tauri `version` reads from `package.json`; `beforeBuildCommand` runs `version:sync` before each build
- Added `npm run icons:generate` and `npm run verify:bundle-version` scripts

## [0.2.7] - 2026-07-04

### Fixed

- Agent tool steps: aggregate searches/tools across `reasoning` and `step-start` boundaries while preserving intro text before the tool block
- Agent streaming: yield to WebKit between tool steps; live message re-renders on part updates without full memo bypass
- API key migration: only mark Keychain migration complete when reads succeed; retry on next launch if access was denied
- Provider switch / autosave: stop rewriting Keychain when the API key did not change
- File access after restart: persist allowed paths (and parent directories) across launches; restore on startup with recent files
- Opening a document fails fast when path registration fails instead of a late opaque error
- Chat progress bar no longer overlaps when the assistant is streaming `reasoning` before text

### Changed

- File picker uses scoped access mode on macOS for better document permission handling

## [0.2.6] - 2026-07-04

### Fixed

- Agent chat stuck on「已调用工具」with no output until the end: group tool steps across agent `step-start` boundaries; show live in-progress labels and a persistent progress bar
- Agent send no longer hangs silently when API key is missing; validate key before dispatch
- API key re-entry after reinstall or provider switch: always mirror keys to local settings; read local copy first to avoid repeated macOS Keychain prompts
- Trackpad page turns on tall pages: scroll within the page before flipping at top/bottom edge

### Changed

- Tool progress during streaming: aggregate completed steps and show current action (e.g.「已搜索 2 次 · 正在搜索文档…」)
- Final answer text streams incrementally once generation starts
- `connectionVerified` no longer treated as having a stored API key when the key is actually missing

## [0.2.5] - 2026-07-04

### Fixed

- Agent chat: tool-only replies no longer show only「已调用工具」— defer history prune until stream flush; surface reasoning when no text answer
- Trackpad PDF page turns: flip on threshold instead of waiting for gesture end; faster cooldowns and instant performance rendering during swipe

### Changed

- Agent tool steps aggregated into a collapsible summary (e.g.「已搜索 6 次 · 已调用工具 1 次」) instead of stacking many chips
- Touchpad flips skip page-turn animation; keyboard navigation keeps it
- PDF preview checks page cache before async fit-width scale resolution

## [0.2.4] - 2026-07-04

### Fixed

- PDF open/preview crash in Tauri WebView (`undefined is not a function`): restore Rust text extraction on open; pdf.js used for canvas render only
- pdf.js cMap / standard font assets copied at build time; runtime URLs resolved against webview origin
- `read_file_bytes` returns `Vec<u8>` for reliable IPC byte loading
- Chat messages without `parts` normalized on load; guards against iterator errors in agent sync and rendering
- `Promise.withResolvers` polyfill for pdf.js on older WebKit builds

### Changed

- Agent page reads use Rust `extract_pdf_text_cmd` instead of pdf.js text layer
- Text selection layer disabled in Tauri desktop (preview canvas only)
- Preview error banner shows the underlying message for easier diagnosis

## [0.2.3] - 2026-07-04

### Fixed

- PDF index badge false failures: wait for pdf.js text extraction, sync docCache to UI, recover from stale failed state
- Agent 404 misreported as “model/endpoint not found” when OpenRouter lacks tool-use routes; correct error ordering
- OpenRouter VL models no longer used as agent model; auto-migrate to split agent + vision models
- Startup keychain password prompt: defer API key read until settings/agent need it
- Logo: Dock / app bundle icons regenerated to match in-app document mark (stacked pages + green dot)

### Changed

- Settings: separate **Agent model** and **Indexing model (vision)**; test connection probes tool calling
- Vision indexing uses dedicated vision model settings

## [0.2.2] - 2026-07-04

### Added

- Lazy-loaded preview and chat panels; thumbnail sidebar windowing; pdf.js lazy loader with bundled cMaps
- Byte-budget PDF page cache; quality-aware cache lookup (fixes navBurst crisp miss); render-task cancellation
- Asset-protocol PDF byte loading with IPC fallback; `renderPageToJpegBytes` for vision indexing
- `findLastMessage` helper; unit tests for message search utilities

### Changed

- PDF text extraction unified on pdf.js (no blocking Rust extract on open; agent tools use frontend extract)
- Streaming throttle 50→100 ms; skip debounced chat save while streaming; memoized hot-path components
- Rust commands async via `spawn_blocking`; OCR stdin pipeline with PNG fallback; release profile LTO/strip
- Vite manual chunks, chrome110 target, drop console in production; `image` crate slimmed features

### Fixed

- Text layer always mounted with visibility toggle; resize observer debounced/quantized
- Preview render effect deps narrowed; stale render guard; thumbnails routed through render queue

## [0.2.1] - 2026-07-04

### Security

- Backend path allowlist: file commands (read / extract / OCR / write) reject any path not authorized via `register_allowed_path`; the frontend registers document and save paths
- Agent tools validate paths against loaded documents, blocking prompt-injection reads of arbitrary local files; document filename sanitized before entering the system prompt
- Enabled a real Content-Security-Policy (`script-src 'self'`) and narrowed the asset protocol scope from `**` to `$HOME/**`
- LLM-emitted Markdown links open via the opener plugin with a scheme allowlist instead of navigating the webview; remote images constrained
- Rewrote the secret scan (git-tracked files, match-first, hyphenated key formats); keychain provider names validated

### Fixed

- API keys: keychain JSON fallback is read back and preserved across saves (fixes silent key loss without a working keychain); custom provider with an empty base URL no longer sends the key to `api.openai.com`
- PDF viewer: render queue settles on cache clear (no hung viewer), pdf.js documents are destroyed, LRU page cache, corrected `devicePixelRatio` scaling
- Document load race, drag-drop listener leak, and StrictMode double-indexing fixed; vision indexing runs in a bounded pool with abort-on-switch, timeout, 429 backoff, and no re-billing of indexed pages
- Agent: `read_pdf_range` continues over-long pages via an offset; step and character budget added; dangling tool parts stripped on save/send to preserve tool pairing
- Chat-session store mutations serialized with corrupt-store guards; `page-intent` parses Chinese / full-width numerals and ranges; Unicode-safe search and slicing
- Accessibility: IME composition guard on Enter; keyboard-operable menus, tabs, command palette, and resize handle; focus-trap visibility fix; stacked-overlay Escape handling
- Light-theme contrast, consolidated tokens, z-index scale; confirmation before deleting library sessions; composer draft restored on send failure
- i18n plural / singular keys aligned between English and 简体中文

### Changed

- `package-lock.json` / `Cargo.lock` version kept in sync and covered by the CI drift check; release workflow fails on missing artifacts or tag/version mismatch; CI now compiles the Rust backend
- Documentation corrections (README / RELEASE / SECURITY); added `license` fields

## [0.2.0] - 2026-07-04

### Added

- Redesigned v3 UI: app rail, library drawer, welcome view, settings tabs
- macOS Keychain storage for API keys (`keyring` + Tauri commands)
- Per-provider LLM profiles (LlmStoreV2) with preview / set-active flow
- Chat session persistence per document with stable document switching
- Vision indexing for sparse PDF pages and images
- i18n: English and 简体中文
- Model capability hints (vision, tool calling) in settings
- OpenRouter tool-use validation and model migration
- Vitest unit tests for settings and chat sessions
- Pre-release secret scan (`npm run check:secrets`)
- Version sync script (`VERSION` → package.json / Tauri / Cargo)
- macOS DMG bundle configuration and GitHub release workflow

### Changed

- OpenRouter default model → `openai/gpt-4o-mini` (tool-capable)
- Settings auto-save with debounced persistence
- Improved agent error messages (Chinese + English)

### Security

- API keys no longer intended for plaintext storage in `settings.json`
- Redacted settings snapshots in debounced save comparisons
- Agent errors not logged to console in production builds

## [0.1.0] - 2026-07-03

Initial public release with PDF preview, OCR, streaming document agent, and multi-provider LLM support.

[Unreleased]: https://github.com/hxddh/pagewise/compare/v0.2.25...HEAD
[0.2.25]: https://github.com/hxddh/pagewise/compare/v0.2.24...v0.2.25
[0.2.24]: https://github.com/hxddh/pagewise/compare/v0.2.23...v0.2.24
[0.2.23]: https://github.com/hxddh/pagewise/compare/v0.2.22...v0.2.23
[0.2.22]: https://github.com/hxddh/pagewise/compare/v0.2.21...v0.2.22
[0.2.21]: https://github.com/hxddh/pagewise/compare/v0.2.20...v0.2.21
[0.2.20]: https://github.com/hxddh/pagewise/compare/v0.2.19...v0.2.20
[0.2.19]: https://github.com/hxddh/pagewise/compare/v0.2.18...v0.2.19
[0.2.18]: https://github.com/hxddh/pagewise/compare/v0.2.17...v0.2.18
[0.2.17]: https://github.com/hxddh/pagewise/compare/v0.2.16...v0.2.17
[0.2.16]: https://github.com/hxddh/pagewise/compare/v0.2.15...v0.2.16
[0.2.15]: https://github.com/hxddh/pagewise/compare/v0.2.14...v0.2.15
[0.2.14]: https://github.com/hxddh/pagewise/compare/v0.2.13...v0.2.14
[0.2.13]: https://github.com/hxddh/pagewise/compare/v0.2.12...v0.2.13
[0.2.12]: https://github.com/hxddh/pagewise/compare/v0.2.11...v0.2.12
[0.2.11]: https://github.com/hxddh/pagewise/compare/v0.2.10...v0.2.11
[0.2.10]: https://github.com/hxddh/pagewise/compare/v0.2.9...v0.2.10
[0.2.9]: https://github.com/hxddh/pagewise/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/hxddh/pagewise/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/hxddh/pagewise/compare/v0.2.6...v0.2.7
[0.2.1]: https://github.com/hxddh/pagewise/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/hxddh/pagewise/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/hxddh/pagewise/releases/tag/v0.1.0
