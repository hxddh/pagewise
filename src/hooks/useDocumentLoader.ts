import { useCallback, useEffect, useRef, useState } from "react";
import { loadDocument } from "../lib/load-document";
import { abortSemanticIndexBuild } from "../lib/semantic-index";
import { addRecentFile } from "../lib/recent-files";
import type { LoadProgress } from "../lib/load-progress";
import type { LoadedDocument } from "../lib/types";
import { useI18n } from "../i18n";
import { useToast } from "./useToast";

interface UseDocumentLoaderOptions {
  onLoaded: (doc: LoadedDocument) => void;
  onRecentChange: (files: Awaited<ReturnType<typeof addRecentFile>>) => void;
  onError: (message: string) => void;
}

export function useDocumentLoader({
  onLoaded,
  onRecentChange,
  onError,
}: UseDocumentLoaderOptions) {
  const { t } = useI18n();
  const { showToast } = useToast();
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<LoadProgress | null>(null);

  // Monotonic sequence so a slow earlier load can't clobber a newer one.
  const loadSeqRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  // Handle for the deferred "clear progress" timer so it can be cancelled on a
  // new load / unmount (it must not clear the NEXT load's progress).
  const clearProgressTimerRef = useRef<number | undefined>(undefined);

  const cancelClearProgressTimer = () => {
    if (clearProgressTimerRef.current !== undefined) {
      window.clearTimeout(clearProgressTimerRef.current);
      clearProgressTimerRef.current = undefined;
    }
  };

  useEffect(() => () => {
    cancelClearProgressTimer();
    loadAbortRef.current?.abort();
  }, []);

  const openPath = useCallback(
    async (path: string) => {
      const seq = ++loadSeqRef.current;
      const isLatest = () => loadSeqRef.current === seq;

      loadAbortRef.current?.abort();
      const controller = new AbortController();
      loadAbortRef.current = controller;

      // A brand-new load owns the overlay: drop any pending clear timer.
      cancelClearProgressTimer();
      setLoading(true);
      setProgress({ stage: "opening", message: "load.opening", percent: 0 });
      onError("");
      try {
        const doc = await loadDocument(path, (p) => {
          if (isLatest()) setProgress(p);
        }, controller.signal);
        if (!isLatest()) return;
        onLoaded(doc);
        const recent = await addRecentFile({
          path: doc.path,
          name: doc.name,
          kind: doc.kind,
        });
        if (!isLatest()) return;
        onRecentChange(recent);
        showToast(t("toast.opened", { name: doc.name }), "success");
      } catch (e) {
        if (controller.signal.aborted) {
          abortSemanticIndexBuild(path);
          return;
        }
        if (!isLatest()) return;
        const raw = e instanceof Error ? e.message : "";
        const msg =
          raw === "errors.unsupportedFile" || raw.startsWith("errors.")
            ? t(raw)
            : raw || t("load.failed");
        onError(msg);
        showToast(msg, "error");
      } finally {
        // Only the newest load may flip the overlay off / schedule the clear.
        if (isLatest()) {
          setLoading(false);
          cancelClearProgressTimer();
          clearProgressTimerRef.current = window.setTimeout(() => {
            clearProgressTimerRef.current = undefined;
            if (isLatest()) setProgress(null);
          }, 400);
        }
      }
    },
    [onLoaded, onRecentChange, onError, showToast, t],
  );

  return { openPath, loading, progress };
}
