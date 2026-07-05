import { useCallback, useEffect, useRef, useState } from "react";
import type { UIMessage } from "ai";
import {
  clearActiveThread,
  clearDocSessions,
  createThread,
  deleteThread,
  listChatSessions,
  loadActiveMessages,
  saveActiveSession,
  switchThread,
  type ChatThread,
  type StoredChatSession,
} from "../lib/chat-sessions";
import { sanitizeDanglingToolParts } from "../lib/prune-chat-history";

/**
 * Cheap identity signature for a message list. Used to tell whether the current
 * messages are still exactly what was loaded from disk (so we can skip a
 * pointless autosave that would only bump `updatedAt`).
 */
function messagesSignature(messages: UIMessage[]): string {
  let sig = `${messages.length}:`;
  for (const m of messages) {
    sig += `${m.id}#${Array.isArray(m.parts) ? m.parts.length : 0};`;
  }
  return sig;
}

interface UseChatPersistenceOptions {
  docPath: string | null;
  docName: string | null;
  docLoadSeq: number;
  messages: UIMessage[];
  setMessages: (messages: UIMessage[]) => void;
  onDocumentSwitch?: (nextPath: string | null) => void;
  /** Stop an in-flight agent stream (thread switch / reload). */
  onStopStream?: () => void;
  isStreaming?: boolean;
}

export function useChatPersistence({
  docPath,
  docName,
  docLoadSeq,
  messages,
  setMessages,
  onDocumentSwitch,
  onStopStream,
  isStreaming = false,
}: UseChatPersistenceOptions) {
  const [sessions, setSessions] = useState<StoredChatSession[]>([]);
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("default");
  const [chatLoading, setChatLoading] = useState(false);

  const messagesRef = useRef(messages);
  const sessionIdRef = useRef(activeSessionId);
  const docPathRef = useRef(docPath);
  const docNameRef = useRef(docName);
  const prevPathRef = useRef<string | null>(null);
  const skipSaveRef = useRef(false);
  const switchGenRef = useRef(0);
  const pendingSessionRef = useRef<{ path: string; sessionId: string } | undefined>(
    undefined,
  );
  const onDocumentSwitchRef = useRef(onDocumentSwitch);
  const onStopStreamRef = useRef(onStopStream);
  const isStreamingRef = useRef(isStreaming);
  const setMessagesRef = useRef(setMessages);
  const appliedLoadKeyRef = useRef("");
  const loadedSnapshotRef = useRef("");

  messagesRef.current = messages;
  sessionIdRef.current = activeSessionId;
  docPathRef.current = docPath;
  docNameRef.current = docName;
  onDocumentSwitchRef.current = onDocumentSwitch;
  onStopStreamRef.current = onStopStream;
  isStreamingRef.current = isStreaming;
  setMessagesRef.current = setMessages;

  const loadKey = docPath ? `${docPath}#${docLoadSeq}` : "";

  const refreshSessions = useCallback(async () => {
    setSessions(await listChatSessions());
  }, []);

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  useEffect(() => {
    if (!docPath) {
      appliedLoadKeyRef.current = "";
      prevPathRef.current = null;
      setChatLoading(false);
      return;
    }

    if (loadKey === appliedLoadKeyRef.current) return;

    const gen = ++switchGenRef.current;
    let cancelled = false;

    async function switchDocument() {
      const prev = prevPathRef.current;
      const pathChanged = docPath !== prev;
      const outgoing = messagesRef.current;
      const wasStreaming = isStreamingRef.current;
      const unsaved =
        outgoing.length > 0 &&
        messagesSignature(outgoing) !== loadedSnapshotRef.current;

      skipSaveRef.current = true;
      setChatLoading(true);
      if (wasStreaming) onStopStreamRef.current?.();
      onDocumentSwitchRef.current?.(docPath);

      try {
        if (unsaved && !wasStreaming) {
          const savePath = pathChanged && prev ? prev : docPath!;
          const saveName = savePath.split(/[/\\]/).pop() ?? savePath;
          await saveActiveSession(
            savePath,
            saveName,
            sessionIdRef.current,
            sanitizeDanglingToolParts(outgoing),
          );
        }

        if (cancelled || gen !== switchGenRef.current) return;

        const pending = pendingSessionRef.current;
        pendingSessionRef.current = undefined;
        const preferredSession =
          pending && pending.path === docPath ? pending.sessionId : undefined;
        const loaded = await loadActiveMessages(docPath!, preferredSession);

        if (cancelled || gen !== switchGenRef.current) return;

        setMessagesRef.current(loaded.messages);
        loadedSnapshotRef.current = messagesSignature(loaded.messages);
        setActiveSessionId(loaded.sessionId);
        setThreads(loaded.threads);
        prevPathRef.current = docPath;
        appliedLoadKeyRef.current = loadKey;
        await refreshSessions();
      } finally {
        if (gen === switchGenRef.current) {
          skipSaveRef.current = false;
          setChatLoading(false);
        }
      }
    }

    void switchDocument();
    return () => {
      cancelled = true;
    };
  }, [docPath, docLoadSeq, loadKey, refreshSessions]);

  useEffect(() => {
    if (!docPath || !docName || skipSaveRef.current || chatLoading || isStreaming) return;

    const savePath = docPath;
    const saveName = docName;
    const id = window.setTimeout(() => {
      if (skipSaveRef.current || chatLoading || isStreaming) return;
      if (docPathRef.current !== savePath || !docNameRef.current) return;
      const snapshot = messagesRef.current;
      if (snapshot.length === 0) return;
      if (messagesSignature(snapshot) === loadedSnapshotRef.current) return;

      void saveActiveSession(
        savePath,
        saveName,
        sessionIdRef.current,
        sanitizeDanglingToolParts(snapshot),
      ).then(async () => {
        if (docPathRef.current !== savePath) return;
        loadedSnapshotRef.current = messagesSignature(messagesRef.current);
        const loaded = await loadActiveMessages(savePath);
        setThreads(loaded.threads);
        await refreshSessions();
      });
    }, 600);

    return () => window.clearTimeout(id);
  }, [docPath, docName, activeSessionId, messages, refreshSessions, chatLoading, isStreaming]);

  const queueSessionForLoad = useCallback((path: string, sessionId: string) => {
    pendingSessionRef.current = { path, sessionId };
    appliedLoadKeyRef.current = "";
  }, []);

  const clearQueuedSession = useCallback(() => {
    pendingSessionRef.current = undefined;
  }, []);

  const selectThread = useCallback(
    async (sessionId: string) => {
      if (!docPath) return;
      const wasStreaming = isStreamingRef.current;
      onStopStreamRef.current?.();
      const snapshot = messagesRef.current;
      if (snapshot.length > 0 && !wasStreaming) {
        await saveActiveSession(
          docPath,
          docName ?? "",
          sessionIdRef.current,
          sanitizeDanglingToolParts(snapshot),
        );
      }
      skipSaveRef.current = true;
      setChatLoading(true);
      try {
        const loaded = await switchThread(docPath, sessionId);
        setActiveSessionId(sessionId);
        setMessagesRef.current(loaded);
        loadedSnapshotRef.current = messagesSignature(loaded);
        const meta = await loadActiveMessages(docPath);
        setThreads(meta.threads);
        await refreshSessions();
      } finally {
        skipSaveRef.current = false;
        setChatLoading(false);
      }
    },
    [docPath, docName, refreshSessions],
  );

  const newThread = useCallback(async () => {
    if (!docPath || !docName) return;
    const wasStreaming = isStreamingRef.current;
    onStopStreamRef.current?.();
    const snapshot = messagesRef.current;
    if (snapshot.length > 0 && !wasStreaming) {
      await saveActiveSession(
        docPath,
        docName,
        sessionIdRef.current,
        sanitizeDanglingToolParts(snapshot),
      );
    }
    skipSaveRef.current = true;
    try {
      const { sessionId, threads: nextThreads } = await createThread(docPath, docName);
      setActiveSessionId(sessionId);
      setThreads(nextThreads);
      setMessagesRef.current([]);
      loadedSnapshotRef.current = messagesSignature([]);
    } finally {
      skipSaveRef.current = false;
    }
    await refreshSessions();
  }, [docPath, docName, refreshSessions]);

  const clearCurrentThread = useCallback(async () => {
    if (!docPath) return;
    skipSaveRef.current = true;
    try {
      await clearActiveThread(docPath, sessionIdRef.current);
      setMessagesRef.current([]);
      loadedSnapshotRef.current = messagesSignature([]);
      const loaded = await loadActiveMessages(docPath);
      setActiveSessionId(loaded.sessionId);
      setThreads(loaded.threads);
      appliedLoadKeyRef.current = loadKey;
      await refreshSessions();
    } finally {
      skipSaveRef.current = false;
    }
  }, [docPath, loadKey, refreshSessions]);

  const removeThread = useCallback(
    async (sessionId: string) => {
      if (!docPath) return;
      await deleteThread(docPath, sessionId);
      if (sessionIdRef.current === sessionId) {
        skipSaveRef.current = true;
        setChatLoading(true);
        try {
          const loaded = await loadActiveMessages(docPath);
          setMessagesRef.current(loaded.messages);
          loadedSnapshotRef.current = messagesSignature(loaded.messages);
          setActiveSessionId(loaded.sessionId);
          setThreads(loaded.threads);
          appliedLoadKeyRef.current = loadKey;
        } finally {
          skipSaveRef.current = false;
          setChatLoading(false);
        }
      }
      await refreshSessions();
    },
    [docPath, loadKey, refreshSessions],
  );

  const deleteSession = useCallback(
    async (path: string) => {
      await clearDocSessions(path);
      if (path === docPath) {
        skipSaveRef.current = true;
        try {
          setMessagesRef.current([]);
          setThreads([]);
          setActiveSessionId("default");
          appliedLoadKeyRef.current = "";
        } finally {
          skipSaveRef.current = false;
        }
      }
      await refreshSessions();
    },
    [docPath, refreshSessions],
  );

  return {
    sessions,
    threads,
    activeSessionId,
    chatLoading,
    selectThread,
    newThread,
    removeThread,
    deleteSession,
    clearCurrentThread,
    queueSessionForLoad,
    clearQueuedSession,
    refreshSessions,
  };
}
