import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  commitLoadedDocument,
  loadDocument,
} from "../lib/load-document";
import { docCache } from "../lib/doc-cache";
import { flushMarks, getMarks, loadMarks, subscribeMarks } from "../lib/mark-store";
import { flushFindings, loadFindings, subscribeFindings } from "../lib/finding-store";
import { flushIndexStore } from "../lib/index-store";
import { flushOcrService } from "../lib/ocr/ocr-service";
import { checkCitation } from "../lib/citation-check";
import { loadReviews } from "../lib/claim-review";
import { prewarmPlacements } from "../lib/finding-anchors";
import { trustedFindings } from "../lib/agent-record-context";
import { TRUST_DOUBTFUL } from "../lib/finding-trust";
import { briefToMarkdown, BRIEF_LABELS_EN, BRIEF_LABELS_ZH } from "../lib/export-brief";
import {
  addRecentFile,
  getRecentFiles,
  reconcileRecentFiles,
  removeRecentFile,
  updateRecentProgress,
  type RecentFile,
} from "../lib/recent-files";
import { checkRecentPaths, openSampleDocument, pickDocument } from "../lib/allowed-paths";
import { classifyOpenError, openErrorMessage } from "../lib/open-error";
import { invokeCmd } from "../lib/invoke-cmd";
import { clearPdfCache } from "../lib/pdf";
import { reindexDocument } from "../document/index-queue";
import {
  evidenceAnnotations,
  saveAnnotatedPdfWithPath,
  type AnnotationLabels,
} from "../lib/export-annotated";
import { documentToMarkdown, marksToMarkdown } from "../lib/export-document";
import { clearChat as clearChatFile, loadChat, pruneOrphanedChats, saveChat } from "../chat/persist";
import { flushChat } from "./flush-chat";
import { createDocumentScope, type DocumentScope } from "../lib/document-scope";
import { useDocAgent, warmDocAgentInIdle, type DocAgent } from "../hooks/useDocAgent";
import { useConnectionStatus } from "../hooks/useConnectionStatus";
import { useResizeWidth } from "../hooks/useResizeWidth";
import { useTauriFileDrop } from "../hooks/useTauriFileDrop";
import { useOpenPathEvent } from "../hooks/useOpenPathEvent";
import { useI18n } from "../i18n";
import { useToast } from "../hooks/useToast";
import { stampMissingFinishedAt, type PageWiseUIMessage } from "../lib/message-metadata";
import { chatToMarkdown } from "../lib/export-markdown";
import { saveMarkdownFileWithPath } from "../lib/save-markdown";
import { fileStamp } from "../lib/file-stamp";
import type { LoadedDocument } from "../lib/types";
import type { LoadProgress } from "../lib/load-progress";

const EXPORT_CHECK_WAIT_MS = 4000;

export type AppPhase = "empty" | "switching" | "ready";

export interface Workbench {
  document: {
    phase: AppPhase;
    doc: LoadedDocument | null;
    page: number;
    setPage: (page: number) => void;
    chatLoading: boolean;
    progress: LoadProgress | null;
    reindex: () => void;
    reload: () => void;
    fileError: { message: string | null; clear: () => void };
    passwordPrompt: {
      path: string | null;
      wrongPassword: boolean;
      submitting: boolean;
      unlock: (password: string) => Promise<void>;
      cancel: () => void;
    };
    dragging: boolean;
  };
  library: {
    recentFiles: RecentFile[];
    openFileDialog: () => void;
    openSample: () => void;
    openPath: (path: string) => void;
    removeRecent: (path: string) => Promise<void>;
  };
  assistant: {
    open: boolean;
    setOpen: (open: boolean) => void;
    agent: DocAgent;
    connection: ReturnType<typeof useConnectionStatus>;
    clearChat: () => Promise<void>;
    exports: {
      chat: () => Promise<void>;
      report: (options?: { includeText?: boolean }) => Promise<void>;
      annotatedPdf: () => Promise<void>;
    };
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
  const [passwordTarget, setPasswordTarget] = useState<{
    path: string;
    wrongPassword: boolean;
    submitting: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatHydrateNonce, setChatHydrateNonce] = useState(0);
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
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
  const queuedOpenPathRef = useRef<string | null>(null);
  const notifiedStampRef = useRef<string | null>(null);
  const loadAbortRef = useRef<AbortController | null>(null);
  const chatHydrateRef = useRef<{ path: string; messages: PageWiseUIMessage[] } | null>(null);
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
        const statuses = await checkRecentPaths(files.map((f) => f.path));
        const statusMap = new Map(
          files.map((f, i) => [f.path, statuses[i] ?? ("denied" as const)]),
        );
        const kept = await reconcileRecentFiles(statusMap);
        setRecentFiles(kept);
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
  }, [document?.path, chatId, chatHydrateNonce]);

  const saveTimerRef = useRef<number | undefined>(undefined);

  const flushChatNow = useCallback(
    () =>
      flushChat({
        waitForStreamIdle: () => agent.run.waitForIdle(),
        stop: () => agent.run.stop(),
        getPath: () => documentRef.current?.path,
        getIdentity: () => documentRef.current?.identity,
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
        if (import.meta.env.DEV) console.warn("[session] autosave failed", e);
      });
    }, 500);
    return () => {
      if (saveTimerRef.current !== undefined) window.clearTimeout(saveTimerRef.current);
    };
  }, [document?.path, agent.messages.list]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      const win = getCurrentWindow();
      const fn = await win.onCloseRequested(async (event) => {
        event.preventDefault();
        try {
          agent.run.stop();
          await Promise.race([
            Promise.allSettled([
              flushChatNowRef.current(),
              flushFindings(),
              flushMarks(),
              flushIndexStore(),
              flushOcrService(),
            ]),
            new Promise((resolve) => setTimeout(resolve, 750)),
          ]);
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
  }, []);

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
        // Best-effort library metadata.
      }
    },
    [],
  );

  useEffect(() => {
    const doc = documentRef.current;
    if (!doc || phase !== "ready") return;
    const timer = window.setTimeout(() => {
      void recordProgress(doc.path, previewPage, doc.totalPages);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [previewPage, phase, recordProgress]);

  useEffect(() => {
    const bump = (path: string) => {
      const doc = documentRef.current;
      if (!doc || doc.path !== path) return;
      void recordProgress(path, previewPageRef.current, doc.totalPages);
    };
    const unsubFindings = subscribeFindings(bump);
    const unsubMarks = subscribeMarks(() => {
      const doc = documentRef.current;
      if (doc) void recordProgress(doc.path, previewPageRef.current, doc.totalPages);
    });
    return () => {
      unsubFindings();
      unsubMarks();
    };
  }, [recordProgress]);

  const switchDocument = useCallback(
    async (path: string, options?: { forceReload?: boolean }) => {
      if (loadingRef.current) {
        queuedOpenPathRef.current = path;
        return;
      }

      const prev = documentRef.current;
      if (!options?.forceReload && prev?.path === path) return;

      const myEpoch = ++epochRef.current;
      const prevPath = prev?.path ?? null;

      setPhase("switching");
      setLoading(true);
      setChatLoading(true);
      setProgress({ stage: "opening", message: "load.opening", percent: 0 });
      setFileError(null);

      await agent.run.waitForIdle();
      const messagesToSave = stampMissingFinishedAt([...messagesRef.current], Date.now());
      agent.run.stop();
      agent.run.reset();

      if (prevPath) {
        void recordProgress(prevPath, previewPageRef.current, prev?.totalPages ?? 0);
        try {
          await saveChat(prevPath, messagesToSave, prev?.identity);
        } catch (e) {
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

        let messages: PageWiseUIMessage[] = [];
        try {
          messages = (await loadChat(path, staged.identity)) as PageWiseUIMessage[];
        } catch (e) {
          if (import.meta.env.DEV) console.warn("[session] chat history load failed", e);
        }

        if (epochRef.current !== myEpoch) return;

        scopeRef.current?.dispose();
        scopeRef.current = null;

        const doc = commitLoadedDocument(staged);
        notifiedStampRef.current = doc.stamp ?? null;
        scopeRef.current = createDocumentScope(doc.path);
        const [, findings] = await Promise.all([
          loadMarks(doc.path, doc.identity),
          loadFindings(doc.path, doc.identity),
          loadReviews(doc.path, doc.stamp ?? ""),
        ]);
        void prewarmPlacements(doc.path, findings);
        chatHydrateRef.current = { path: doc.path, messages };
        setChatHydrateNonce((n) => n + 1);
        setDocument(docCache.get(doc.path) ?? doc);
        const remembered = options?.forceReload
          ? previewPageRef.current
          : (recentFilesRef.current.find((f) => f.path === doc.path)?.lastPage ?? 1);
        const resumeAt = remembered > 1 && remembered <= doc.totalPages ? remembered : 1;
        setPreviewPage(resumeAt);
        setPhase("ready");
        warmDocAgentInIdle();

        try {
          const recent = await addRecentFile({
            path: doc.path,
            name: doc.name,
            kind: doc.kind,
            totalPages: doc.totalPages,
          });
          if (epochRef.current === myEpoch) setRecentFiles(recent);
        } catch {
          // Recents failure never aborts an already-opened document.
        }
        showToast(
          resumeAt > 1 && !options?.forceReload
            ? t("toast.resumedAt", { page: resumeAt })
            : t("toast.opened", { name: doc.name }),
          "success",
        );
      } catch (e) {
        if (epochRef.current !== myEpoch) return;
        if (e instanceof Error && e.name === "AbortError") return;
        if (classifyOpenError(e)?.kind === "encrypted") {
          setPasswordTarget({ path, wrongPassword: false, submitting: false });
          setPhase(prev ? "ready" : "empty");
          setChatLoading(false);
          chatHydrateRef.current = null;
          if (!prev) setDocument(null);
          return;
        }
        const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
        const msg =
          openErrorMessage(e, t) ?? (raw.startsWith("errors.") ? t(raw) : raw || t("load.failed"));
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
          loadingRef.current = false;
          setProgress(null);
          if (loadAbortRef.current === controller) {
            loadAbortRef.current = null;
          }
          const queued = queuedOpenPathRef.current;
          queuedOpenPathRef.current = null;
          if (queued && queued !== documentRef.current?.path) {
            void switchDocument(queued);
          }
        }
      }
    },
    [agent, recordProgress, showToast, t],
  );

  const reload = useCallback(() => {
    const cur = documentRef.current;
    if (!cur || loadingRef.current) return;
    void switchDocument(cur.path, { forceReload: true });
  }, [switchDocument]);

  const unlockEncryptedPdf = useCallback(
    async (password: string) => {
      if (!passwordTarget || passwordTarget.submitting) return;
      const targetPath = passwordTarget.path;
      setPasswordTarget({ path: targetPath, wrongPassword: false, submitting: true });
      try {
        clearPdfCache(targetPath);
        await invokeCmd<void>("unlock_pdf_cmd", { path: targetPath, password });
        setPasswordTarget(null);
        await switchDocument(targetPath, { forceReload: true });
      } catch {
        setPasswordTarget({ path: targetPath, wrongPassword: true, submitting: false });
      }
    },
    [passwordTarget, switchDocument],
  );

  const cancelPasswordPrompt = useCallback(() => {
    setPasswordTarget(null);
  }, []);

  // Detect external modifications on window focus and offer a 1-click reload.
  useEffect(() => {
    const onFocus = () => {
      const cur = documentRef.current;
      if (!cur || phase !== "ready" || loadingRef.current || !cur.stamp) return;
      void fileStamp(cur.path)
        .then((freshStamp) => {
          if (!freshStamp || documentRef.current?.path !== cur.path) return;
          if (freshStamp !== cur.stamp && notifiedStampRef.current !== freshStamp) {
            notifiedStampRef.current = freshStamp;
            showToast(t("toast.fileChangedOnDisk"), "default", {
              label: t("toast.reloadAction"),
              onClick: () => void switchDocument(cur.path, { forceReload: true }),
            });
          }
        })
        .catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [phase, showToast, switchDocument, t]);

  const openPath = useCallback(
    (path: string) => {
      void switchDocument(path);
    },
    [switchDocument],
  );

  const openSample = useCallback(() => {
    if (loadingRef.current) return;
    void openSampleDocument()
      .then((samplePath) => switchDocument(samplePath))
      .catch((e: unknown) => {
        const msg = openErrorMessage(e, t) ?? t("load.failed");
        setFileError(msg);
      });
  }, [switchDocument, t]);

  const removeRecent = useCallback(async (path: string) => {
    const updated = await removeRecentFile(path);
    setRecentFiles(updated);
  }, []);

  const openFileDialog = useCallback(() => {
    if (loadingRef.current) return;
    void (async () => {
      const selected = await pickDocument().catch((e: unknown) => {
        const msg = openErrorMessage(e, t);
        if (msg) showToast(msg, "error");
        return null;
      });
      if (selected) void switchDocument(selected);
    })();
  }, [switchDocument, showToast, t]);

  const { isDragging } = useTauriFileDrop(
    (paths) => {
      const docPath = paths[0];
      if (docPath) void switchDocument(docPath);
    },
    (names) => {
      showToast(t("errors.unsupportedDropped", { name: names.join(", ") }), "error");
    },
  );

  useOpenPathEvent(
    (path) => {
      void switchDocument(path);
    },
    (reason) => {
      const msg = openErrorMessage(reason, t) ?? reason;
      if (msg) setFileError(msg);
    },
  );

  const reindex = useCallback(() => {
    const path = documentRef.current?.path;
    if (!path) return;
    const pages = reindexDocument(path);
    if (pages === 0) {
      showToast(t("toast.reindexNothingToDo"), "default");
      return;
    }
    showToast(t("toast.reindexStarted", { pages }), "default");
  }, [showToast, t]);

  const setPage = useCallback((page: number) => {
    if (!Number.isFinite(page)) return;
    const total = documentRef.current?.totalPages ?? 0;
    const target = Math.max(1, Math.round(page));
    setPreviewPage(total > 0 ? Math.min(total, target) : target);
  }, []);

  const clearChat = useCallback(async () => {
    const doc = documentRef.current;
    if (!doc) return;
    if (saveTimerRef.current !== undefined) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = undefined;
    }
    agent.messages.clear();
    await clearChatFile(doc.path);
  }, [agent]);

  const revealAction = useCallback(
    (savedPath: string) => ({
      label: t("toast.revealFile"),
      onClick: () => void revealItemInDir(savedPath).catch(() => {}),
    }),
    [t],
  );

  const exportChat = useCallback(async () => {
    const doc = documentRef.current;
    if (!doc || agent.messages.list.length === 0) {
      showToast(t("toast.noMessages"), "error");
      return;
    }
    const md = chatToMarkdown(agent.messages.list, doc.name);
    const name = doc.name.replace(/\.[^.]+$/, "") + "-chat.md";
    try {
      const savedPath = await saveMarkdownFileWithPath(md, name, t("dialog.markdownFilter"));
      if (savedPath) showToast(t("toast.chatExported"), "success", revealAction(savedPath));
    } catch {
      showToast(t("toast.exportFailed"), "error");
    }
  }, [agent.messages.list, revealAction, showToast, t]);

  const exportReport = useCallback(
    async (options: { includeText?: boolean } = {}) => {
      const doc = documentRef.current;
      if (!doc) return;
      const entries = trustedFindings(doc.path).filter((e) => e.trust !== "retracted");
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
      const marks = marksToMarkdown(doc, locale);
      if (marks) parts.push(marks.trimEnd());
      if (parts.length === 0) {
        showToast(t("toast.noFindings"), "error");
        return;
      }
      if (options.includeText) {
        parts.push(documentToMarkdown(doc, { includeMarks: false, locale }).trimEnd());
      }
      const md = `${parts.join("\n\n---\n\n")}\n`;
      const name = doc.name.replace(/\.[^.]+$/, "") + "-report.md";
      try {
        const savedPath = await saveMarkdownFileWithPath(md, name, t("dialog.markdownFilter"));
        if (savedPath) showToast(t("toast.reportExported"), "success", revealAction(savedPath));
      } catch {
        showToast(t("toast.exportFailed"), "error");
      }
    },
    [locale, revealAction, showToast, t],
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
      const written = await saveAnnotatedPdfWithPath(doc.path, annotations, name, t("dialog.pdfFilter"));
      if (written !== null) {
        showToast(
          t("toast.annotatedExported", { count: written.count }),
          "success",
          revealAction(written.path),
        );
      }
    } catch (e) {
      if (import.meta.env.DEV) console.warn("[export] annotated PDF failed", e);
      showToast(t("toast.exportFailed"), "error");
    }
  }, [revealAction, showToast, t]);

  return {
    document: {
      phase,
      doc: document,
      page: previewPage,
      setPage,
      chatLoading,
      progress,
      reindex,
      reload,
      fileError: { message: fileError, clear: () => setFileError(null) },
      passwordPrompt: {
        path: passwordTarget?.path ?? null,
        wrongPassword: passwordTarget?.wrongPassword ?? false,
        submitting: passwordTarget?.submitting ?? false,
        unlock: unlockEncryptedPdf,
        cancel: cancelPasswordPrompt,
      },
      dragging: isDragging,
    },
    library: {
      recentFiles,
      openFileDialog,
      openSample,
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
