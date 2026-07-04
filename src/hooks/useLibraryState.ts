import { useCallback, useState } from "react";
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
}: UseLibraryStateOptions) {
  const [libraryOpen, setLibraryOpen] = useState(false);

  const {
    sessions,
    deleteSession,
    selectThread,
    queueSessionForLoad,
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
  });

  const openSessionFromLibrary = useCallback(
    async (path: string, sessionId?: string) => {
      if (sessionId) queueSessionForLoad(sessionId);
      if (activeDoc?.path === path) {
        if (sessionId) await selectThread(sessionId);
        return;
      }
      await openPath(path);
    },
    [activeDoc?.path, openPath, selectThread, queueSessionForLoad],
  );

  return {
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
  };
}
