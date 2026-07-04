import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { findLastMessage } from "../lib/messages-utils";
import { getToolName, isToolUIPart } from "ai";
import { open } from "@tauri-apps/plugin-dialog";
import { useDocumentLoader } from "./useDocumentLoader";
import { useTauriFileDrop } from "./useTauriFileDrop";
import { useI18n } from "../i18n";
import { clearPdfCache } from "../lib/pdf";
import { docCache } from "../lib/doc-cache";
import { subscribePageIndex, clearDocumentIndexState } from "../lib/index-events";
import { isSupportedDocument } from "../lib/load-document";
import { loadPreferences } from "../lib/preferences";
import { getLastAgentMessageContext } from "../lib/agent-view-context";
import { shouldFollowAgentToPage } from "../lib/page-intent";
import { indexSparsePages } from "../lib/vision-index";
import type { RecentFile } from "../lib/recent-files";
import type { LoadedDocument } from "../lib/types";

export function useDocumentWorkspace(
  onRecentChange?: (files: RecentFile[]) => void,
  showToast?: (msg: string, tone?: "default" | "success" | "error") => void,
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
    // Cancel indexing for the outgoing document and drop its per-page index
    // state so the events map doesn't grow unbounded across a session.
    indexAbortRef.current?.abort();
    indexAbortRef.current = null;
    const prevPath = prevDocPathRef.current;
    if (prevPath && prevPath !== doc.path) {
      clearDocumentIndexState(prevPath);
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
      for (const part of lastAssistant.parts) {
        if (!isToolUIPart(part) || part.state !== "output-available") continue;
        if (part.toolCallId === lastSyncedToolRef.current) continue;

        const name = getToolName(part);
        const input = part.input as { page?: number; start?: number } | undefined;
        let targetPage: number | null = null;

        if (name === "read_pdf_page" && input?.page) {
          targetPage = input.page;
        } else if (name === "read_pdf_range" && input?.start) {
          targetPage = input.start;
        }

        // Non-read tool outputs (search_in_document, get_document_index, …) carry
        // no page to follow. Skip past them instead of breaking, otherwise one
        // sitting here would stall syncing to a later read tool output.
        if (targetPage === null) continue;

        if (shouldFollowAgentToPage(targetPage, followCtx)) {
          lastSyncedToolRef.current = part.toolCallId;
          setPreviewPage((prev) => (prev === targetPage ? prev : targetPage!));
        }
        break;
      }
    },
    [followAgent],
  );

  const reindexActiveDoc = useCallback((pages?: number[]) => {
    // indexSparsePages is a side effect (paid vision/OCR calls). It must run
    // OUTSIDE any setState updater — StrictMode double-invokes updaters, which
    // would double-fire the index work.
    const doc = activeDocRef.current;
    if (!doc) return;
    indexAbortRef.current?.abort();
    const controller = new AbortController();
    indexAbortRef.current = controller;
    void indexSparsePages(doc, pages, { signal: controller.signal });
  }, []);

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
