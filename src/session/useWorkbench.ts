/**
 * The workbench: everything one open document session needs, as a hook.
 *
 * This was `SessionProvider` — a context with thirty fields and exactly one
 * consumer (`App`). With one reader the indirection bought nothing, and the
 * body (document switching, chat persistence, the export actions) was harder
 * to find than the code that used it. The return is three groups rather than
 * thirty fields, and per-document module state is closed through
 * `document-scope.ts` instead of a hand-written teardown list.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  commitLoadedDocument,
  isSupportedDocument,
  loadDocument,
} from "../lib/load-document";
import { docCache } from "../lib/doc-cache";
import { getMarks, loadMarks } from "../lib/mark-store";
import { loadFindings, subscribeFindings } from "../lib/finding-store";
import { checkCitation } from "../lib/citation-check";
import { loadReviews } from "../lib/claim-review";
import { prewarmPlacements } from "../lib/finding-anchors";
import { trustedFindings } from "../lib/agent-record-context";
import { TRUST_DOUBTFUL } from "../lib/finding-trust";
import { briefToMarkdown, BRIEF_LABELS_EN, BRIEF_LABELS_ZH } from "../lib/export-brief";
import {
  addRecentFile,
  getRecentFiles,
  removeRecentFile,
  removeRecentFiles,
  updateRecentProgress,
  type RecentFile,
} from "../lib/recent-files";
import { pickDocument, ungrantedPaths } from "../lib/allowed-paths";
import { reindexDocument } from "../document/index-queue";
import { evidenceAnnotations, saveAnnotatedPdf, type AnnotationLabels } from "../lib/export-annotated";
import { documentToMarkdown, marksToMarkdown } from "../lib/export-document";
import { clearChat as clearChatFile, loadChat, pruneOrphanedChats, saveChat } from "../chat/persist";
import { flushChat } from "./flush-chat";
import { createDocumentScope, type DocumentScope } from "../lib/document-scope";
import { useDocAgent, type DocAgent } from "../hooks/useDocAgent";
import { useConnectionStatus } from "../hooks/useConnectionStatus";
import { useResizeWidth } from "../hooks/useResizeWidth";
import { useTauriFileDrop } from "../hooks/useTauriFileDrop";
import { useOpenPathEvent } from "../hooks/useOpenPathEvent";
import { useI18n } from "../i18n";
import { useToast } from "../hooks/useToast";
import { stampMissingFinishedAt, type PageWiseUIMessage } from "../lib/message-metadata";
import { chatToMarkdown } from "../lib/export-markdown";
import { saveMarkdownFile } from "../lib/save-markdown";
import type { LoadedDocument } from "../lib/types";
import type { LoadProgress } from "../lib/load-progress";

/** How long a report export waits for its entries' checks before it files what it has (v23). */
const EXPORT_CHECK_WAIT_MS = 4000;

export type AppPhase = "empty" | "switching" | "ready";

export interface Workbench {
  /** The open document, its load state, and the reading position. */
  document: {
    phase: AppPhase;
    doc: LoadedDocument | null;
    /** The page the reader is on. */
    page: number;
    setPage: (page: number) => void;
    chatLoading: boolean;
    progress: LoadProgress | null;
    reindex: () => void;
    /** The last open failure, and the way to dismiss it. */
    fileError: { message: string | null; clear: () => void };
    dragging: boolean;
  };
  /** Opening files, by any of the routes that reach them. */
  library: {
    recentFiles: RecentFile[];
    openFileDialog: () => void;
    openPath: (path: string) => void;
    removeRecent: (path: string) => Promise<void>;
  };
  /** The assistant column: its run, its visibility, and what it can write out. */
  assistant: {
    open: boolean;
    setOpen: (open: boolean) => void;
    agent: DocAgent;
    connection: ReturnType<typeof useConnectionStatus>;
    clearChat: () => Promise<void>;
    /** One way out for everything the app writes (16.0). */
    exports: {
      chat: () => Promise<void>;
      report: (options?: { includeText?: boolean }) => Promise<void>;
      annotatedPdf: () => Promise<void>;
    };
    /** Window chrome the shell renders around the columns. */
    shell: {
      settingsOpen: boolean;
      setSettingsOpen: (open: boolean) => void;
      resize: ReturnType<typeof useResizeWidth>;
    };
  };
}


export function useWorkbench(): Workbench {
  const { t, locale } = useI18n();
  const { showToast } = useToast();

  const [phase, setPhase] = useState<AppPhase>("empty");
  const [document, setDocument] = useState<LoadedDocument | null>(null);
  const [previewPage, setPreviewPage] = useState(1);
  const [fileError, setFileError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [chatLoading, setChatLoading] = useState(false);
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  // Read synchronously while opening: where the reader left off.
  const recentFilesRef = useRef<RecentFile[]>([]);
  recentFilesRef.current = recentFiles;
  const previewPageRef = useRef(1);
  previewPageRef.current = previewPage;
  const [agentOpen, setAgentOpen] = useState(
    () => localStorage.getItem("pagewise.agentOpen") !== "0",
  );
  const [settingsOpen, setSettingsOpen] = useState(false);

  const epochRef = useRef(0);
  const documentRef = useRef<LoadedDocument | null>(null);
  documentRef.current = document;
  const loadingRef = useRef(false);
  loadingRef.current = loading;
  const loadAbortRef = useRef<AbortController | null>(null);
  const chatHydrateRef = useRef<{ path: string; messages: PageWiseUIMessage[] } | null>(null);
  // The open document's module state. Disposed when the document is left.
  const scopeRef = useRef<DocumentScope | null>(null);

  const chatId = document?.path ?? "pagewise-local";
  const agent = useDocAgent(chatId);
  const agentSetMessagesRef = useRef(agent.messages.set);
  agentSetMessagesRef.current = agent.messages.set;
  const messagesRef = useRef(agent.messages.list);
  messagesRef.current = agent.messages.list;
  const connection = useConnectionStatus();
  const resize = useResizeWidth();

  useEffect(() => {
    localStorage.setItem("pagewise.agentOpen", agentOpen ? "1" : "0");
  }, [agentOpen]);

  useEffect(() => {
    void getRecentFiles()
      .then(async (files) => {
        setRecentFiles(files);
        // Recents Rust has not granted (moved, deleted, or only ever named in
        // this webview-written list) are pruned, so a dead entry doesn't linger
        // and later report "path not authorized". Nothing is granted from here
        // since 21.0: Rust restores its own list of documents at startup.
        const failed = await ungrantedPaths(files.map((f) => f.path));
        let kept = files;
        if (failed.length > 0) {
          kept = await removeRecentFiles(failed);
          setRecentFiles(kept);
        }
        // Evict chats for documents no longer in recents so the chat store
        // doesn't grow unbounded across sessions.
        void pruneOrphanedChats(kept.map((f) => f.path));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    return docCache.subscribe((path) => {
      if (documentRef.current?.path !== path) return;
      const fresh = docCache.get(path);
      if (fresh) setDocument(fresh);
    });
  }, []);

  useEffect(() => {
    const pending = chatHydrateRef.current;
    if (!pending || document?.path !== pending.path || chatId !== pending.path) return;
    agentSetMessagesRef.current(pending.messages);
    chatHydrateRef.current = null;
    setChatLoading(false);
  }, [document?.path, chatId]);

  const saveTimerRef = useRef<number | undefined>(undefined);

  const flushChatNow = useCallback(
    () =>
      flushChat({
        waitForStreamIdle: () => agent.run.waitForIdle(),
        stop: () => agent.run.stop(),
        getPath: () => documentRef.current?.path,
        getMessages: () => messagesRef.current,
        clearAutosave: () => {
          if (saveTimerRef.current !== undefined) {
            window.clearTimeout(saveTimerRef.current);
            saveTimerRef.current = undefined;
          }
        },
        saveChat,
      }),
    [agent],
  );
  // `flushChatNow` changes identity on every streamed chunk, so the close
  // handler reads it through a ref: the Tauri onCloseRequested listener
  // registers once instead of re-registering hundreds of times per reply.
  const flushChatNowRef = useRef(flushChatNow);
  flushChatNowRef.current = flushChatNow;

  useEffect(() => {
    if (!document?.path || agent.messages.list.length === 0) return;
    if (saveTimerRef.current !== undefined) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      const path = documentRef.current?.path;
      const msgs = messagesRef.current;
      if (!path || msgs.length === 0) return;
      void saveChat(path, msgs, documentRef.current?.identity).catch((e) => {
        // The reader is told by `saveChat` itself, through store health (24.0);
        // the next message's autosave is the retry.
        if (import.meta.env.DEV) console.warn("[session] autosave failed", e);
      });
    }, 500);
    return () => {
      if (saveTimerRef.current !== undefined) window.clearTimeout(saveTimerRef.current);
    };
  }, [document?.path, agent.messages.list]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    // Registration is async: if the effect tears down before it resolves,
    // `unlisten` is still undefined and the cleanup cannot remove the handler.
    // Track cancellation so the resolved listener is removed instead of leaking.
    let cancelled = false;
    void (async () => {
      const win = getCurrentWindow();
      const fn = await win.onCloseRequested(async (event) => {
        event.preventDefault();
        try {
          await flushChatNowRef.current();
        } catch (e) {
          if (import.meta.env.DEV) console.warn("[session] flush on close failed", e);
        } finally {
          await win.destroy();
        }
      });
      if (cancelled) {
        fn();
        return;
      }
      unlisten = fn;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // Registered once; the handler reads the latest flush via ref.
  }, []);

  // What the library row says about a document, best-effort and written only
  // when it changed: position, entries kept, entries waiting.
  const recordProgress = useCallback(
    async (path: string, page: number, totalPages: number) => {
      try {
        const rated = trustedFindings(path);
        const updated = await updateRecentProgress(path, {
          lastPage: Math.max(1, Math.round(page)),
          ...(totalPages > 0 ? { totalPages } : {}),
          findingCount: rated.length,
          openCount: rated.filter((r) => TRUST_DOUBTFUL.has(r.trust)).length,
        });
        setRecentFiles(updated);
      } catch {
        // The row is a convenience; the document is not.
      }
    },
    [],
  );

  // The page the reader is on, remembered a moment after they stop turning.
  useEffect(() => {
    const doc = documentRef.current;
    if (!doc || phase !== "ready") return;
    const timer = window.setTimeout(() => {
      void recordProgress(doc.path, previewPage, doc.totalPages);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [previewPage, phase, recordProgress]);

  // And the record's counts, whenever the record changes.
  useEffect(() => {
    return subscribeFindings((path) => {
      const doc = documentRef.current;
      if (!doc || doc.path !== path) return;
      void recordProgress(path, previewPageRef.current, doc.totalPages);
    });
  }, [recordProgress]);

  const switchDocument = useCallback(
    async (path: string) => {
      if (loadingRef.current) return;

      const prev = documentRef.current;
      if (prev?.path === path) return;

      const myEpoch = ++epochRef.current;
      const prevPath = prev?.path ?? null;

      setPhase("switching");
      setLoading(true);
      setChatLoading(true);
      setProgress({ stage: "opening", message: "load.opening", percent: 0 });
      setFileError(null);

      await agent.run.waitForIdle();
      // Stamp finishedAt deterministically: an aborted last message's
      // setMessages may not have flushed to messagesRef before this snapshot.
      const messagesToSave = stampMissingFinishedAt([...messagesRef.current], Date.now());
      agent.run.stop();
      agent.run.reset();

      if (prevPath) {
        void recordProgress(prevPath, previewPageRef.current, prev?.totalPages ?? 0);
        try {
          await saveChat(prevPath, messagesToSave, prev?.identity);
        } catch (e) {
          // No toast of its own any more (24.0): `saveChat` reports the failure
          // to store health, which says it once and keeps "Not saved" up — a
          // second toast here doubled it.
          if (import.meta.env.DEV) console.warn("[session] save chat on switch failed", e);
        }
      }

      loadAbortRef.current?.abort();
      const controller = new AbortController();
      loadAbortRef.current = controller;

      try {
        const staged = await loadDocument(
          path,
          (p) => {
            if (epochRef.current === myEpoch) setProgress(p);
          },
          controller.signal,
          { deferCache: true },
        );

        if (epochRef.current !== myEpoch) return;

        // Chat-history corruption is recoverable; failing the whole open over
        // it is not.
        let messages: PageWiseUIMessage[] = [];
        try {
          messages = (await loadChat(path, staged.identity)) as PageWiseUIMessage[];
        } catch (e) {
          if (import.meta.env.DEV) console.warn("[session] chat history load failed", e);
        }

        if (epochRef.current !== myEpoch) return;

        // Every per-document cache for the document being left, closed in one
        // place (see `document-scope.ts`) — this used to be a hand-kept list.
        scopeRef.current?.dispose();
        scopeRef.current = null;

        const doc = commitLoadedDocument(staged);
        scopeRef.current = createDocumentScope(doc.path);
        // Marks and findings are drawn synchronously from memory, so both load
        // with the document rather than on first paint.
        await loadMarks(doc.path, doc.identity);
        const findings = await loadFindings(doc.path, doc.identity);
        // The reader's model reviews of this file, kept since 21.0 — read
        // before the document is ready, so "Review citations" never offers
        // (and bills) a citation whose verdict is still on its way from disk.
        // A local read; a failure is no reviews, never a failed open.
        await loadReviews(doc.path, doc.stamp ?? "");
        // Where each finding's quote sits on the page, resolved once now so
        // the first question's record note can read it — see `trustOf`.
        void prewarmPlacements(doc.path, findings);
        chatHydrateRef.current = { path: doc.path, messages };
        setDocument(docCache.get(doc.path) ?? doc);
        // Back where the reader left off, when the library remembers and the
        // page still exists. Page 1 otherwise.
        const remembered = recentFilesRef.current.find((f) => f.path === doc.path)?.lastPage ?? 1;
        const resumeAt = remembered > 1 && remembered <= doc.totalPages ? remembered : 1;
        setPreviewPage(resumeAt);
        setPhase("ready");

        const recent = await addRecentFile({
          path: doc.path,
          name: doc.name,
          kind: doc.kind,
          totalPages: doc.totalPages,
        });
        if (epochRef.current === myEpoch) setRecentFiles(recent);
        showToast(
          resumeAt > 1
            ? t("toast.resumedAt", { page: resumeAt })
            : t("toast.opened", { name: doc.name }),
          "success",
        );
      } catch (e) {
        if (epochRef.current !== myEpoch) return;
        if (e instanceof Error && e.name === "AbortError") return;
        // Tauri rejects invoke() with a plain string, so a Rust-side load
        // error ("Encrypted PDF requires a password", …) arrives as a string,
        // not an Error — read both so the real cause reaches the user.
        const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
        const msg =
          raw === "errors.unsupportedFile" || raw.startsWith("errors.")
            ? t(raw)
            : raw || t("load.failed");
        // The banner only, not a toast as well: both sat in the same top-right
        // corner and the toast covered the banner's Dismiss (16.0 moved toasts
        // to the bottom left; css-hygiene asserts the corners). A load failure
        // is a state the reader is left in, not an event.
        setFileError(msg);
        setPhase(prev ? "ready" : "empty");
        setChatLoading(false);
        chatHydrateRef.current = null;
        if (!prev) {
          setDocument(null);
        }
      } finally {
        if (epochRef.current === myEpoch) {
          setLoading(false);
          setProgress(null);
          if (loadAbortRef.current === controller) {
            loadAbortRef.current = null;
          }
        }
      }
    },
    [agent, showToast, t],
  );

  const openPath = useCallback(
    (path: string) => {
      if (loadingRef.current) return;
      void switchDocument(path);
    },
    [switchDocument],
  );

  const removeRecent = useCallback(async (path: string) => {
    const updated = await removeRecentFile(path);
    setRecentFiles(updated);
  }, []);

  const openFileDialog = useCallback(() => {
    if (loadingRef.current) return;
    void (async () => {
      // The dialog runs in Rust, which grants the file picked (21.0).
      const selected = await pickDocument().catch(() => null);
      if (selected) void switchDocument(selected);
    })();
  }, [switchDocument]);

  const { isDragging } = useTauriFileDrop((paths) => {
    if (loadingRef.current) return;
    const docPath = paths.find((p) => isSupportedDocument(p));
    if (docPath) void switchDocument(docPath);
  });

  // A document opened from the desktop — double-clicked, or handed over by a
  // second launch that the single-instance plugin turned back. Same treatment
  // as a drop: the reader asked for this file in this window.
  useOpenPathEvent((path) => {
    if (loadingRef.current) return;
    if (isSupportedDocument(path)) void switchDocument(path);
  });

  const reindex = useCallback(() => {
    const path = documentRef.current?.path;
    if (!path) return;
    const pages = reindexDocument(path);
    // The budget governs how many pages a re-index rescans, and it can be zero.
    if (pages === 0) {
      showToast(t("toast.reindexNothingToDo"), "default");
      return;
    }
    showToast(t("toast.reindexStarted", { pages }), "default");
  }, [showToast, t]);

  // Clamp preview jumps: models cite printed or hallucinated page numbers, and
  // an out-of-range page would leave the canvas stuck on the old page.
  const setPage = useCallback((page: number) => {
    if (!Number.isFinite(page)) return;
    const total = documentRef.current?.totalPages ?? 0;
    const target = Math.max(1, Math.round(page));
    setPreviewPage(total > 0 ? Math.min(total, target) : target);
  }, []);

  const clearChat = useCallback(async () => {
    const doc = documentRef.current;
    if (!doc) return;
    // Cancel any pending autosave so a queued write can't re-persist the old
    // messages after we delete them.
    if (saveTimerRef.current !== undefined) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = undefined;
    }
    agent.messages.clear();
    await clearChatFile(doc.path);
  }, [agent]);

  const exportChat = useCallback(async () => {
    const doc = documentRef.current;
    if (!doc || agent.messages.list.length === 0) {
      showToast(t("toast.noMessages"), "error");
      return;
    }
    const md = chatToMarkdown(agent.messages.list, doc.name);
    const name = doc.name.replace(/\.[^.]+$/, "") + "-chat.md";
    try {
      const ok = await saveMarkdownFile(md, name, t("dialog.markdownFilter"));
      if (ok) showToast(t("toast.chatExported"), "success");
    } catch {
      showToast(t("toast.exportFailed"), "error");
    }
  }, [agent.messages.list, showToast, t]);

  const exportReport = useCallback(
    async (options: { includeText?: boolean } = {}) => {
      const doc = documentRef.current;
      if (!doc) return;
      const entries = trustedFindings(doc.path).filter((e) => e.trust !== "retracted");
      // The model's verdicts are filed against the passage each entry's check
      // finds now (22.0), so the checks run first; each is cached, so one an
      // answer's chip already ran costs nothing. Waited for a few seconds at
      // most (v23): a scanned page not read yet is an OCR reading or two, and
      // the export sat there with nothing on screen. An entry whose check is
      // still running files no verdict, as before 21.1.
      await Promise.race([
        Promise.all(
          entries.map(({ finding }) =>
            finding.evidence.trim()
              ? checkCitation(doc.path, doc.totalPages, { pages: finding.pages, quote: finding.evidence.trim() }).catch(
                  () => null,
                )
              : null,
          ),
        ),
        new Promise((resolve) => setTimeout(resolve, EXPORT_CHECK_WAIT_MS)),
      ]);
      const parts: string[] = [];
      if (entries.length > 0) {
        parts.push(briefToMarkdown(doc, entries, locale === "zh-CN" ? BRIEF_LABELS_ZH : BRIEF_LABELS_EN).trimEnd());
      }
      const marks = marksToMarkdown(doc);
      if (marks) parts.push(marks.trimEnd());
      if (parts.length === 0) {
        showToast(t("toast.noFindings"), "error");
        return;
      }
      if (options.includeText) parts.push(documentToMarkdown(doc).trimEnd());
      const md = `${parts.join("\n\n---\n\n")}\n`;
      const name = doc.name.replace(/\.[^.]+$/, "") + "-report.md";
      try {
        const ok = await saveMarkdownFile(md, name, t("dialog.markdownFilter"));
        if (ok) showToast(t("toast.reportExported"), "success");
      } catch {
        showToast(t("toast.exportFailed"), "error");
      }
    },
    [locale, showToast, t],
  );

  const exportAnnotatedPdf = useCallback(async () => {
    const doc = documentRef.current;
    if (!doc || doc.kind !== "pdf") return;
    const labels: AnnotationLabels = {
      assistant: "PageWise",
      reader: t("annotations.reader"),
      finding: t("annotations.finding"),
      mark: t("annotations.mark"),
      foundOnPage: (page) => t("annotations.foundOnPage", { page }),
      confirmed: t("annotations.confirmed"),
    };
    try {
      const entries = trustedFindings(doc.path);
      const annotations = await evidenceAnnotations(doc.path, doc.stamp ?? "", entries, getMarks(doc.path), labels);
      if (annotations.length === 0) {
        showToast(t("toast.annotatedNothing"), "error");
        return;
      }
      const name = doc.name.replace(/\.[^.]+$/, "") + "-annotated.pdf";
      const written = await saveAnnotatedPdf(doc.path, annotations, name, t("dialog.pdfFilter"));
      if (written !== null) showToast(t("toast.annotatedExported", { count: written }), "success");
    } catch (e) {
      if (import.meta.env.DEV) console.warn("[export] annotated PDF failed", e);
      showToast(t("toast.exportFailed"), "error");
    }
  }, [showToast, t]);

  return {
    document: {
      phase,
      doc: document,
      page: previewPage,
      setPage,
      chatLoading,
      progress,
      reindex,
      fileError: { message: fileError, clear: () => setFileError(null) },
      dragging: isDragging,
    },
    library: {
      recentFiles,
      openFileDialog,
      openPath,
      removeRecent,
    },
    assistant: {
      open: agentOpen,
      setOpen: setAgentOpen,
      agent,
      connection,
      clearChat,
      exports: {
        chat: exportChat,
        report: exportReport,
        annotatedPdf: exportAnnotatedPdf,
      },
      shell: {
        settingsOpen,
        setSettingsOpen,
        resize,
      },
    },
  };
}
