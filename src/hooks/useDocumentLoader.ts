import { useCallback, useState } from "react";
import { loadDocument } from "../lib/load-document";
import { addRecentFile } from "../lib/recent-files";
import type { LoadProgress } from "../lib/load-progress";
import type { LoadedDocument } from "../lib/types";
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
  const { showToast } = useToast();
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<LoadProgress | null>(null);

  const openPath = useCallback(
    async (path: string) => {
      setLoading(true);
      setProgress({ stage: "opening", message: "Opening…", percent: 0 });
      onError("");
      try {
        const doc = await loadDocument(path, setProgress);
        onLoaded(doc);
        const recent = await addRecentFile({
          path: doc.path,
          name: doc.name,
          kind: doc.kind,
        });
        onRecentChange(recent);
        showToast(`Opened ${doc.name}`, "success");
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed to open file";
        onError(msg);
        showToast(msg, "error");
      } finally {
        setLoading(false);
        window.setTimeout(() => setProgress(null), 400);
      }
    },
    [onLoaded, onRecentChange, onError, showToast],
  );

  return { openPath, loading, progress };
}
