import { useCallback, useEffect, useRef, useState } from "react";
import { getToolName, isToolUIPart } from "ai";
import { open } from "@tauri-apps/plugin-dialog";
import { useDocumentLoader } from "./useDocumentLoader";
import { useTauriFileDrop } from "./useTauriFileDrop";
import { useI18n } from "../i18n";
import { clearPdfCache } from "../lib/pdf";
import { docCache } from "../lib/doc-cache";
import { subscribePageIndex } from "../lib/index-events";
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

  useEffect(() => {
    loadPreferences().then((p) => {
      setFollowAgent(p.followAgentDefault);
      setIncludeViewingPage(p.includeViewingPageDefault);
    });
  }, []);

  useEffect(() => {
    return subscribePageIndex((state) => {
      if (state.status !== "done") return;
      setActiveDoc((doc) => {
        if (!doc || doc.path !== state.path) return doc;
        return { ...doc, pages: docCache.getPages(doc.path) };
      });
    });
  }, []);

  const handleDocumentLoaded = useCallback((doc: LoadedDocument) => {
    clearPdfCache();
    setActiveDoc(doc);
    setPreviewPage(1);
    setFileError(null);
    setDocLoadSeq((n) => n + 1);
    lastSyncedToolRef.current = null;
    onLoadedRef.current?.(doc);
  }, []);

  const { openPath, loading, progress } = useDocumentLoader({
    onLoaded: handleDocumentLoaded,
    onRecentChange: onRecentChange ?? (() => {}),
    onError: (message) => setFileError(message || null),
  });

  const clearFileError = useCallback(() => setFileError(null), []);

  const openFileDialog = useCallback(async () => {
    setPickerOpen(true);
    const selected = await open({
      multiple: false,
      filters: [
        {
          name: t("dialog.documentsFilter"),
          extensions: ["pdf", "png", "jpg", "jpeg", "webp", "tif", "tiff", "bmp", "gif"],
        },
      ],
    });
    setPickerOpen(false);
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

      const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
      if (!lastAssistant) return;
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

        if (targetPage !== null && shouldFollowAgentToPage(targetPage, followCtx)) {
          lastSyncedToolRef.current = part.toolCallId;
          setPreviewPage((prev) => (prev === targetPage ? prev : targetPage!));
        }
        break;
      }
    },
    [followAgent],
  );

  const reindexActiveDoc = useCallback((pages?: number[]) => {
    setActiveDoc((doc) => {
      if (!doc) return doc;
      indexSparsePages(doc, pages);
      return doc;
    });
  }, []);

  return {
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
  };
}
