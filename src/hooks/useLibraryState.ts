import { useCallback, useMemo, useState } from "react";
import { useChatPersistence } from "./useChatPersistence";
import type { RecentFile } from "../lib/recent-files";
import type { LoadedDocument } from "../lib/types";

interface UseLibraryStateOptions {
  activeDoc: LoadedDocument | null;
  docLoadSeq: number;
  messages: import("ai").UIMessage[];
  setMessages: (messages: import("ai").UIMessage[]) => void;
  openPath: (path: string) => Promise<void>;
  recentFiles: RecentFile[];
  setRecentFiles: (files: RecentFile[]) => void;
  onDocumentSwitch?: (nextPath: string | null) => void;
  isStreaming?: boolean;
}

export function useLibraryState({
  activeDoc,
  docLoadSeq,
  messages,
  setMessages,
  openPath,
  recentFiles,
  setRecentFiles,
  onDocumentSwitch,
  isStreaming = false,
}: UseLibraryStateOptions) {
  const [libraryOpen, setLibraryOpen] = useState(false);

  const {
    sessions,
    deleteSession,
    selectThread,
    queueSessionForLoad,
    clearQueuedSession,
    clearCurrentThread,
    activeSessionId,
    chatLoading,
  } = useChatPersistence({
    docPath: activeDoc?.path ?? null,
    docName: activeDoc?.name ?? null,
    docLoadSeq,
    messages,
    setMessages,
    onDocumentSwitch,
    isStreaming,
  });

  const openSessionFromLibrary = useCallback(
    async (path: string, sessionId?: string) => {
      // Same document already open: switch thread directly. Do NOT queue the
      // session — the same-doc path never consumes a queued id, so a leftover
      // would later be applied to a different doc.
      if (activeDoc?.path === path) {
        if (sessionId) await selectThread(sessionId);
        return;
      }
      // Different doc: queue the session (bound to this path) for the upcoming
      // load, but clear it if the open fails.
      if (sessionId) queueSessionForLoad(path, sessionId);
      try {
        await openPath(path);
      } catch {
        clearQueuedSession();
      }
    },
    [activeDoc?.path, openPath, selectThread, queueSessionForLoad, clearQueuedSession],
  );

  return useMemo(
    () => ({
      libraryOpen,
      setLibraryOpen,
      recentFiles,
      setRecentFiles,
      sessions,
      deleteSession,
      openSessionFromLibrary,
      clearCurrentThread,
      activeSessionId,
      chatLoading,
    }),
    [
      libraryOpen,
      recentFiles,
      setRecentFiles,
      sessions,
      deleteSession,
      openSessionFromLibrary,
      clearCurrentThread,
      activeSessionId,
      chatLoading,
    ],
  );
}
