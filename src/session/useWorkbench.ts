import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  commitLoadedDocument,
  loadDocument,
} from "../lib/load-document";
import { docCache } from "../lib/doc-cache";
import { flushMarks, getMarks, loadMarks, subscribeMarks } from "../lib/mark-store";
import { flushFindings, loadFindings, subscribeFindings } from "../lib/finding-store";
import { flushIndexStore, forgetIndexIdentity } from "../lib/index-store";
import { flushOcrService, forgetOcr, restoreOcr } from "../lib/ocr/ocr-service";
import { checkCitation, clearCitationChecks } from "../lib/citation-check";
import { clearReviews, loadReviews } from "../lib/claim-review";
import { clearFindingAnchors, prewarmPlacements } from "../lib/finding-anchors";
import { clearDocumentIndexState } from "../lib/index-events";
import { clearSearchFoldCache } from "../lib/document-search";
import { isTauriRuntime } from "../lib/runtime";
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
import { cancelIndex, reindexDocument, scheduleIndex } from "../document/index-queue";
import {
  evidenceAnnotations,
  saveAnnotatedPdfWithPath,
  type AnnotationLabels,
} from "../lib/export-annotated";
import { documentToMarkdown, marksToMarkdown } from "../lib/export-document";
import { clearChat as clearChatFile, loadChat, pruneOrphanedChats, saveChat } from "../chat/persist";
import { flushChat } from "./flush-chat";
import { createDocumentScope, type DocumentScope } from "../lib/document-scope";
import type { DocAgent } from "../hooks/useDocAgent";
import { useLazyDocAgent } from "./useLazyDocAgent";
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
  agentHost: ReactNode;
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
  const queuedOpenOptionsRef = useRef<{ forceReload?: boolean; silentHotReload?: boolean } | undefined>(
    undefined,
  );
  const notifiedStampRef = useRef<string | null>(null);
  const pendingExternalStampRef = useRef<{ path: string; stamp: string } | null>(null);
  const loadAbortRef = useRef<AbortController | null>(null);
  const chatHydrateRef = useRef<{ path: string; messages: PageWiseUIMessage[] } | null>(null);
  const scopeRef = useRef<DocumentScope | null>(null);

  const chatId = document?.path ?? "pagewise-local";
  const { agent, agentHost } = useLazyDocAgent(chatId, phase !== "empty" || loading);
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

  const hydratedMessagesRef = useRef<unknown>(null);

  useEffect(() => {
    const pending = chatHydrateRef.current;
    if (!pending || document?.path !== pending.path || chatId !== pending.path) return;
    hydratedMessagesRef.current = pending.messages;
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
    if (agent.messages.list === hydratedMessagesRef.current) return;
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
    async (path: string, options?: { forceReload?: boolean; silentHotReload?: boolean }) => {
      if (loadingRef.current) {
        queuedOpenPathRef.current = path;
        queuedOpenOptionsRef.current = options;
        loadAbortRef.current?.abort();
        return;
      }

      const prev = documentRef.current;
      if (!options?.forceReload && prev?.path === path) return;

      const myEpoch = ++epochRef.current;
      const prevPath = prev?.path ?? null;
      const prevPage = previewPageRef.current;
      const prevStamp = notifiedStampRef.current;
      const wasReload = Boolean(options?.forceReload || prevPath === path);
      const isSilentHotReload = Boolean(options?.silentHotReload && prev && prev.path === path);

      loadAbortRef.current?.abort();
      const controller = new AbortController();
      loadAbortRef.current = controller;

      loadingRef.current = true;
      setFileError(null);
      if (!isSilentHotReload) {
        setPhase("switching");
        setLoading(true);
        setChatLoading(true);
        setProgress({ stage: "opening", message: "load.opening", percent: 0 });
      }

      await agent.run.waitForIdle();
      const messagesToSave = stampMissingFinishedAt([...messagesRef.current], Date.now());
      if (!isSilentHotReload) {
        agent.run.stop();
        agent.run.reset();
      }

      let fastShellMounted = false;

      const restorePreviousSession = () => {
        if (fastShellMounted) {
          fastShellMounted = false;
          scopeRef.current?.dispose();
          scopeRef.current = null;
          docCache.remove?.(path);
        }
        if (prev) {
          if (!scopeRef.current) {
            scopeRef.current = createDocumentScope(prev.path);
          }
          if (!docCache.get(prev.path)) {
            docCache.set?.(prev);
          }
          if (wasReload && prev.identity) {
            void restoreOcr(prev.path, prev.identity);
          }
          notifiedStampRef.current = prevStamp;
          setPreviewPage(prevPage);
          setDocument(prev);
          documentRef.current = prev;
          chatHydrateRef.current = { path: prev.path, messages: messagesToSave };
          setChatHydrateNonce((n) => n + 1);
          agentSetMessagesRef.current(messagesToSave);
          messagesRef.current = messagesToSave;
          setPhase("ready");
        } else {
          notifiedStampRef.current = null;
          setPreviewPage(1);
          setDocument(null);
          documentRef.current = null;
          chatHydrateRef.current = null;
          setPhase("empty");
        }
        setChatLoading(false);
      };

      let savePrevPromise: Promise<void> = Promise.resolve();
      if (prevPath) {
        void recordProgress(prevPath, previewPageRef.current, prev?.totalPages ?? 0);
        savePrevPromise = saveChat(prevPath, messagesToSave, prev?.identity).catch((e) => {
          if (import.meta.env.DEV) console.warn("[session] save chat on switch failed", e);
        });
        if (prevPath === path) await savePrevPromise;
      }

      // Start warming the PreviewPane chunk in parallel with preflight/open so
      // first document open pays zero lazy-chunk waterfall after `loadDocument` (29.0).
      void import("../features/preview/PreviewPane").catch(() => {});

      // Evict cached PDF proxy, OCR/indexing state, and runs BEFORE in-place reload so
      // `getPdfOutline`, `restoreOcr`, and `scheduleIndex` never read pre-edit state (28.0 / 30.0).
      if (wasReload) {
        cancelIndex(path);
        forgetOcr(path);
        clearDocumentIndexState(path);
        forgetIndexIdentity(path);
        clearSearchFoldCache();
        clearReviews(path);
        clearPdfCache(path);
        clearFindingAnchors(path);
        clearCitationChecks(path);
      }

      const rememberedPage = options?.forceReload
        ? previewPageRef.current
        : (recentFilesRef.current.find((f) => f.path === path)?.lastPage ?? 1);

      type PreflightStores = {
        messages: PageWiseUIMessage[];
        findings: Awaited<ReturnType<typeof loadFindings>> | null;
      };
      let earlyStoresPromise: Promise<PreflightStores> | null = null;

      try {
        if (controller.signal.aborted) {
          const err = new Error("Document open aborted");
          err.name = "AbortError";
          throw err;
        }
        const staged = await loadDocument(
          path,
          (p) => {
            if (epochRef.current === myEpoch) setProgress(p);
          },
          controller.signal,
          {
            deferCache: true,
            isReload: wasReload,
            initialPage: Math.max(1, rememberedPage),
            deferAnnotations: true,
            deferScheduleIndex: true,
            onPreflight: ({ stamp, identity }) => {
              if (wasReload) return;
              earlyStoresPromise = Promise.all([
                loadChat(path, identity)
                  .then((m) => m as PageWiseUIMessage[])
                  .catch((e) => {
                    if (import.meta.env.DEV) console.warn("[session] chat history load failed", e);
                    return [] as PageWiseUIMessage[];
                  }),
                loadMarks(path, identity).catch(() => []),
                loadFindings(path, identity).catch(() => []),
                loadReviews(path, stamp).catch(() => undefined),
              ]).then(([messages, , findings]) => ({ messages, findings }));
            },
            onFastShell: (fastDoc) => {
              // Only mount an early fast-shell from the empty state (`!prev`):
              // while switching from an open document A to B, preserve A's scope,
              // caches, and document state intact until B finishes staging (29.0).
              if (prev || epochRef.current !== myEpoch || controller.signal.aborted || wasReload) {
                return;
              }
              fastShellMounted = true;
              scopeRef.current?.dispose();
              scopeRef.current = createDocumentScope(fastDoc.path);
              const committedFast = commitLoadedDocument(fastDoc, { deferScheduleIndex: true });
              notifiedStampRef.current = committedFast.stamp ?? null;
              const resumeFast =
                rememberedPage > 1 && rememberedPage <= committedFast.totalPages
                  ? rememberedPage
                  : 1;
              setPreviewPage(resumeFast);
              setDocument(committedFast);
              setPhase("ready");
            },
          },
        );

        if (epochRef.current !== myEpoch) return;

        let messages: PageWiseUIMessage[] = messagesToSave;
        let preloadedFindings: Awaited<ReturnType<typeof loadFindings>> | null = null;
        if (!isSilentHotReload) {
          messages = [];
          if (earlyStoresPromise) {
            const resolved = await (earlyStoresPromise as Promise<PreflightStores>);
            messages = resolved.messages;
            preloadedFindings = resolved.findings;
          } else {
            try {
              messages = (await loadChat(path, staged.identity)) as PageWiseUIMessage[];
            } catch (e) {
              if (import.meta.env.DEV) console.warn("[session] chat history load failed", e);
            }
          }
        }

        if (controller.signal.aborted) {
          const err = new Error("Document open aborted");
          err.name = "AbortError";
          throw err;
        }
        if (epochRef.current !== myEpoch) return;

        if (!fastShellMounted && !isSilentHotReload) {
          scopeRef.current?.dispose();
          scopeRef.current = null;
        }

        const doc = commitLoadedDocument(staged, { deferScheduleIndex: true });
        notifiedStampRef.current = doc.stamp ?? null;
        pendingExternalStampRef.current = null;
        if (!fastShellMounted && !scopeRef.current) {
          scopeRef.current = createDocumentScope(doc.path);
        }
        const findings =
          preloadedFindings ??
          (
            await Promise.all([
              loadMarks(doc.path, doc.identity),
              loadFindings(doc.path, doc.identity),
              loadReviews(doc.path, doc.stamp ?? ""),
            ])
          )[1];
        void prewarmPlacements(doc.path, findings);
        if (!isSilentHotReload) {
          chatHydrateRef.current = { path: doc.path, messages };
          setChatHydrateNonce((n) => n + 1);
        }
        setDocument(docCache.get(doc.path) ?? doc);
        const resumeAt =
          rememberedPage > 1 && rememberedPage <= doc.totalPages ? rememberedPage : 1;
        if (!isSilentHotReload || resumeAt !== previewPageRef.current) {
          setPreviewPage(resumeAt);
        }
        setPhase("ready");

        // Start background OCR/vision sweep after first paint settles so Page 1
        // canvas + text layer never compete with background worker startup (29.0).
        const startSweep = () => {
          if (epochRef.current !== myEpoch) return;
          const liveDoc = docCache.get(doc.path) ?? doc;
          scheduleIndex(liveDoc, { startPage: resumeAt });
        };
        if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
          window.requestAnimationFrame(() => {
            window.setTimeout(startSweep, 48);
          });
        } else {
          startSweep();
        }

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
        if (isSilentHotReload) {
          showToast(t("toast.fileChangedOnDisk"), "default");
        } else {
          showToast(
            resumeAt > 1 && !options?.forceReload
              ? t("toast.resumedAt", { page: resumeAt })
              : t("toast.opened", { name: doc.name }),
            "success",
          );
        }
      } catch (e) {
        if (epochRef.current !== myEpoch) return;
        if (e instanceof Error && e.name === "AbortError") {
          restorePreviousSession();
          return;
        }
        if (classifyOpenError(e)?.kind === "encrypted") {
          setPasswordTarget({ path, wrongPassword: false, submitting: false });
          restorePreviousSession();
          if (!prev) setDocument(null);
          return;
        }
        const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
        const msg =
          openErrorMessage(e, t) ?? (raw.startsWith("errors.") ? t(raw) : raw || t("load.failed"));
        setFileError(msg);
        restorePreviousSession();
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
          const queuedOpts = queuedOpenOptionsRef.current;
          queuedOpenPathRef.current = null;
          queuedOpenOptionsRef.current = undefined;
          if (
            queued &&
            (queuedOpts?.forceReload ||
              queued !== documentRef.current?.path ||
              (wasReload && queued === path))
          ) {
            void switchDocument(queued, {
              ...queuedOpts,
              ...(wasReload && queued === path ? { forceReload: true } : {}),
            });
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

  // Option A (30.0): Silent zero-flash live hot-reload when the open document
  // changes on disk while the assistant is idle; if an AI stream is running,
  // hold the current snapshot steady (`expectedStamp` lock) and hot-reload as
  // soon as the stream finishes.
  const handleExternalModification = useCallback(
    (targetPath: string, freshStamp: string) => {
      const cur = documentRef.current;
      if (!cur || cur.path !== targetPath || phase !== "ready" || loadingRef.current || !cur.stamp) {
        return;
      }
      if (!freshStamp || freshStamp === cur.stamp) return;
      if (agent.run.isBusy()) {
        pendingExternalStampRef.current = { path: cur.path, stamp: freshStamp };
        if (notifiedStampRef.current !== freshStamp) {
          notifiedStampRef.current = freshStamp;
          showToast(t("toast.fileChangedOnDisk"), "default", {
            label: t("toast.reloadAction"),
            onClick: () => {
              pendingExternalStampRef.current = null;
              void switchDocument(cur.path, { forceReload: true, silentHotReload: true });
            },
          });
        }
        return;
      }
      if (notifiedStampRef.current === freshStamp) return;
      notifiedStampRef.current = freshStamp;
      pendingExternalStampRef.current = null;
      void switchDocument(cur.path, { forceReload: true, silentHotReload: true });
    },
    [agent.run, phase, showToast, switchDocument, t],
  );

  useEffect(() => {
    const pending = pendingExternalStampRef.current;
    const cur = documentRef.current;
    if (!pending || !cur || cur.path !== pending.path || phase !== "ready" || loadingRef.current) {
      return;
    }
    if (agent.run.isBusy()) return;
    pendingExternalStampRef.current = null;
    if (pending.stamp !== cur.stamp) {
      void switchDocument(cur.path, { forceReload: true, silentHotReload: true });
    }
  }, [agent.run, agent.run.status, phase, switchDocument]);

  useEffect(() => {
    const onFocus = () => {
      const cur = documentRef.current;
      if (!cur || phase !== "ready" || loadingRef.current || !cur.stamp) return;
      void fileStamp(cur.path)
        .then((freshStamp) => {
          if (freshStamp) handleExternalModification(cur.path, freshStamp);
        })
        .catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    let disposed = false;
    let unlistenWatch: (() => void) | null = null;
    if (isTauriRuntime()) {
      void listen<{ path?: string; stamp?: string }>("pagewise://document-modified", (ev) => {
        if (disposed) return;
        const modPath = typeof ev.payload?.path === "string" ? ev.payload.path : "";
        const modStamp = typeof ev.payload?.stamp === "string" ? ev.payload.stamp : "";
        if (modPath && modStamp) handleExternalModification(modPath, modStamp);
      }).then(
        (fn) => {
          if (disposed) fn();
          else unlistenWatch = fn;
        },
        () => {},
      );
    }
    return () => {
      disposed = true;
      window.removeEventListener("focus", onFocus);
      unlistenWatch?.();
    };
  }, [handleExternalModification, phase]);

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
    const snapshotStamp = doc.stamp ?? "";
    try {
      const entries = trustedFindings(doc.path);
      const annotations = await evidenceAnnotations(doc.path, snapshotStamp, entries, getMarks(doc.path), labels);
      if (annotations.length === 0) {
        showToast(t("toast.annotatedNothing"), "error");
        return;
      }
      const name = doc.name.replace(/\.[^.]+$/, "") + "-annotated.pdf";
      const written = await saveAnnotatedPdfWithPath(
        doc.path,
        annotations,
        name,
        t("dialog.pdfFilter"),
        snapshotStamp,
      );
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
    agentHost,
  };
}
