import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { findLastMessage } from "../lib/messages-utils";
import { getToolName, isToolUIPart } from "ai";
import { open } from "@tauri-apps/plugin-dialog";
import { useDocumentLoader } from "./useDocumentLoader";
import { useTauriFileDrop } from "./useTauriFileDrop";
import { useI18n } from "../i18n";
import { clearPdfCache } from "../lib/pdf";
import { docCache } from "../lib/doc-cache";
import { subscribePageIndex, clearDocumentIndexState, clearPageIndexState } from "../lib/index-events";
import { isSupportedDocument } from "../lib/load-document";
import { loadPreferences } from "../lib/preferences";
import { getLastAgentMessageContext } from "../lib/agent-view-context";
import { shouldFollowAgentToPage } from "../lib/page-intent";
import { indexSparsePages, setBackgroundIndexAbortController } from "../lib/vision-index";
import { setSemanticEmbedCapHandler, abortSemanticIndexBuild } from "../lib/semantic-index";
import type { RecentFile } from "../lib/recent-files";
import type { LoadedDocument } from "../lib/types";

export function useDocumentWorkspace(
  onRecentChange?: (files: RecentFile[]) => void,
  showToast?: (msg: string, tone?: "default" | "success" | "error") => void,
  translate?: (key: string, vars?: Record<string, string | number>) => string,
) {
  const { t } = useI18n();
  const [activeDoc, setActiveDoc] = useState<LoadedDocument | null>(null);
  const [previewPage, setPreviewPage] = useState(1);
  const [followAgent, setFollowAgent] = useState(true);
  const [includeViewingPage, setIncludeViewingPage] = useState(true);
  const [fileError, setFileError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [docLoadSeq, setDocLoadSeq] = useState(0);
  const onLoadedRef = useRef<((doc: LoadedDocument) => void) | null>(null);
  const lastSyncedToolRef = useRef<string | null>(null);
  // Mirror of activeDoc so effects/callbacks can read the current doc without a
  // stale closure and without running side effects inside a setState updater.
  const activeDocRef = useRef<LoadedDocument | null>(null);
  activeDocRef.current = activeDoc;
  // Cancels in-flight vision/OCR indexing when the document changes.
  const indexAbortRef = useRef<AbortController | null>(null);
  const prevDocPathRef = useRef<string | null>(null);

  useEffect(() => {
    loadPreferences().then((p) => {
      setFollowAgent(p.followAgentDefault);
      setIncludeViewingPage(p.includeViewingPageDefault);
    });
  }, []);

  useEffect(() => {
    setSemanticEmbedCapHandler((path, info) => {
      const doc = activeDocRef.current;
      if (!doc || doc.path !== path || !showToast || !translate) return;
      showToast(
        translate("toast.embedPageCap", {
          embedded: info.embedded,
          total: info.eligible,
        }),
        "default",
      );
    });
    return () => setSemanticEmbedCapHandler(null);
  }, [showToast, translate]);

  useEffect(() => {
    return subscribePageIndex((state) => {
      if (state.status !== "done" && state.status !== "failed") return;
      setActiveDoc((doc) => {
        if (!doc || doc.path !== state.path) return doc;
        return { ...doc, pages: docCache.getPages(doc.path) };
      });
    });
  }, []);

  useEffect(() => {
    return docCache.subscribe((path) => {
      setActiveDoc((doc) => {
        if (!doc || doc.path !== path) return doc;
        return { ...doc, pages: docCache.getPages(path) };
      });
    });
  }, []);

  const handleDocumentLoaded = useCallback((doc: LoadedDocument) => {
    indexAbortRef.current?.abort();
    abortSemanticIndexBuild();
    const controller = new AbortController();
    indexAbortRef.current = controller;
    setBackgroundIndexAbortController(controller);
    const prevPath = prevDocPathRef.current;
    const pathChanged = prevPath !== doc.path;
    if (pathChanged) {
      if (prevPath) {
        clearDocumentIndexState(prevPath);
        docCache.remove(prevPath);
      }
      clearDocumentIndexState(doc.path);
    }
    prevDocPathRef.current = doc.path;
    clearPdfCache();
    setActiveDoc(doc);
    setPreviewPage(1);
    setFileError(null);
    setDocLoadSeq((n) => n + 1);
    lastSyncedToolRef.current = null;
    onLoadedRef.current?.(doc);
  }, []);

  const handleLoadError = useCallback(
    (message: string) => setFileError(message || null),
    [],
  );

  const { openPath, loading, progress } = useDocumentLoader({
    onLoaded: handleDocumentLoaded,
    onRecentChange: onRecentChange ?? (() => {}),
    onError: handleLoadError,
  });

  const clearFileError = useCallback(() => setFileError(null), []);

  const openFileDialog = useCallback(async () => {
    setPickerOpen(true);
    let selected: string | string[] | null = null;
    try {
      selected = await open({
        multiple: false,
        fileAccessMode: "scoped",
        filters: [
          {
            name: t("dialog.documentsFilter"),
            extensions: ["pdf", "png", "jpg", "jpeg", "webp", "tif", "tiff", "bmp", "gif"],
          },
        ],
      });
    } finally {
      // A rejected/cancelled dialog must never leave the picker stuck open.
      setPickerOpen(false);
    }
    if (!selected || typeof selected !== "string") return;
    await openPath(selected);
  }, [openPath, t]);

  const handleFileDrop = useCallback(
    async (paths: string[]) => {
      const path = paths.find(isSupportedDocument);
      if (!path) {
        const msg = t("errors.unsupportedFile");
        setFileError(msg);
        showToast?.(msg, "error");
        return;
      }
      await openPath(path);
    },
    [openPath, showToast, t],
  );

  const { isDragging } = useTauriFileDrop(handleFileDrop);

  const syncPageFromAgent = useCallback(
    (messages: import("ai").UIMessage[]) => {
      if (!followAgent) return;
      const msgCtx = getLastAgentMessageContext();
      const followCtx = msgCtx
        ? { userText: msgCtx.userText, viewingPage: msgCtx.viewingPage }
        : null;

      const lastAssistant = findLastMessage(messages, (m) => m.role === "assistant");
      if (!lastAssistant?.parts) return;

      let syncPage: number | null = null;
      let syncToolId: string | null = null;

      for (const part of lastAssistant.parts) {
        if (!isToolUIPart(part) || part.state !== "output-available") continue;

        const name = getToolName(part);
        const input = part.input as { page?: number; start?: number } | undefined;
        let targetPage: number | null = null;

        if (name === "read_pdf_page" && input?.page) {
          targetPage = input.page;
        } else if (name === "read_pdf_range" && input?.start) {
          targetPage = input.start;
        }

        if (targetPage === null) continue;

        if (shouldFollowAgentToPage(targetPage, followCtx)) {
          syncPage = targetPage;
          syncToolId = part.toolCallId;
        }
      }

      if (syncPage !== null && syncToolId !== lastSyncedToolRef.current) {
        lastSyncedToolRef.current = syncToolId;
        setPreviewPage((prev) => (prev === syncPage ? prev : syncPage!));
      }
    },
    [followAgent],
  );

  useEffect(() => {
    if (!followAgent) return;
    lastSyncedToolRef.current = null;
  }, [followAgent]);

  const reindexActiveDoc = useCallback((pages?: number[]) => {
    const doc = activeDocRef.current;
    if (!doc) return;
    if (pages?.length) {
      for (const p of pages) clearPageIndexState(doc.path, p);
    } else {
      clearDocumentIndexState(doc.path);
    }
    indexAbortRef.current?.abort();
    const controller = new AbortController();
    indexAbortRef.current = controller;
    setBackgroundIndexAbortController(controller);
    void indexSparsePages(doc, pages, { signal: controller.signal }).then((result) => {
      if (showToast && translate) {
        if (result.capped) {
          showToast(
            translate("toast.indexPageCap", {
              indexed: result.indexed,
              total: result.scheduled + result.skipped,
            }),
            "default",
          );
        } else if (result.scheduled > 0 && result.indexed < result.scheduled) {
          showToast(
            translate("toast.indexPartial", {
              indexed: result.indexed,
              scheduled: result.scheduled,
            }),
            "default",
          );
        }
      }
    });
  }, [showToast, translate]);

  return useMemo(
    () => ({
      activeDoc,
      previewPage,
      setPreviewPage,
      followAgent,
      setFollowAgent,
      includeViewingPage,
      setIncludeViewingPage,
      fileError,
      clearFileError,
      pickerOpen,
      loading,
      progress,
      openPath,
      openFileDialog,
      isDragging,
      onLoadedRef,
      syncPageFromAgent,
      reindexActiveDoc,
      docLoadSeq,
    }),
    [
      activeDoc,
      previewPage,
      followAgent,
      includeViewingPage,
      fileError,
      clearFileError,
      pickerOpen,
      loading,
      progress,
      openPath,
      openFileDialog,
      isDragging,
      syncPageFromAgent,
      reindexActiveDoc,
      docLoadSeq,
    ],
  );
}
