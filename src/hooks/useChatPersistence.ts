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
import { messagesSignature } from "../lib/messages-signature";
import { prepareMessagesForPersist } from "../lib/persist-messages";

interface UseChatPersistenceOptions {
  docPath: string | null;
  docName: string | null;
  docLoadSeq: number;
  messages: UIMessage[];
  setMessages: (messages: UIMessage[]) => void;
  onDocumentSwitch?: (nextPath: string | null) => void;
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
  const opGenRef = useRef(0);
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

  const persistOutgoing = useCallback(
    async (savePath: string, saveName: string, sessionId: string, outgoing: UIMessage[]) => {
      if (outgoing.length === 0) return;
      const prepared = prepareMessagesForPersist(outgoing);
      await saveActiveSession(savePath, saveName, sessionId, prepared);
    },
    [],
  );

  const bumpOpGen = useCallback(() => ++opGenRef.current, []);

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

    const gen = bumpOpGen();
    let cancelled = false;

    async function switchDocument() {
      const prev = prevPathRef.current;
      const pathChanged = docPath !== prev;
      const outgoing = messagesRef.current;
      const unsaved =
        outgoing.length > 0 &&
        messagesSignature(outgoing) !== loadedSnapshotRef.current;

      skipSaveRef.current = true;
      setChatLoading(true);
      if (isStreamingRef.current) onStopStreamRef.current?.();
      onDocumentSwitchRef.current?.(docPath);

      try {
        if (unsaved) {
          const savePath = pathChanged && prev ? prev : docPath!;
          const saveName = savePath.split(/[/\\]/).pop() ?? savePath;
          try {
            await persistOutgoing(savePath, saveName, sessionIdRef.current, outgoing);
            loadedSnapshotRef.current = messagesSignature(outgoing);
          } catch (err) {
            if (import.meta.env.DEV) console.warn("[chat-persistence] save on switch failed:", err);
          }
        }

        if (cancelled || gen !== opGenRef.current) return;

        const pending = pendingSessionRef.current;
        pendingSessionRef.current = undefined;
        const preferredSession =
          pending && pending.path === docPath ? pending.sessionId : undefined;
        const loaded = await loadActiveMessages(docPath!, preferredSession);

        if (cancelled || gen !== opGenRef.current) return;

        setMessagesRef.current(loaded.messages);
        loadedSnapshotRef.current = messagesSignature(loaded.messages);
        setActiveSessionId(loaded.sessionId);
        setThreads(loaded.threads);
        prevPathRef.current = docPath;
        appliedLoadKeyRef.current = loadKey;
        await refreshSessions();
      } catch (err) {
        if (import.meta.env.DEV) console.warn("[chat-persistence] document switch failed:", err);
      } finally {
        if (gen === opGenRef.current) {
          skipSaveRef.current = false;
          setChatLoading(false);
        }
      }
    }

    void switchDocument();
    return () => {
      cancelled = true;
    };
  }, [docPath, docLoadSeq, loadKey, refreshSessions, persistOutgoing, bumpOpGen]);

  useEffect(() => {
    if (!docPath || !docName || skipSaveRef.current || chatLoading || isStreaming) return;

    const savePath = docPath;
    const saveName = docName;
    const saveSessionId = activeSessionId;
    const id = window.setTimeout(() => {
      if (skipSaveRef.current || chatLoading || isStreamingRef.current) return;
      if (docPathRef.current !== savePath || !docNameRef.current) return;
      if (sessionIdRef.current !== saveSessionId) return;
      const snapshot = messagesRef.current;
      if (snapshot.length === 0) return;
      if (messagesSignature(snapshot) === loadedSnapshotRef.current) return;

      void persistOutgoing(savePath, saveName, saveSessionId, snapshot)
        .then(async () => {
          if (docPathRef.current !== savePath || sessionIdRef.current !== saveSessionId) return;
          loadedSnapshotRef.current = messagesSignature(snapshot);
          const loaded = await loadActiveMessages(savePath, undefined, { readOnly: true });
          setThreads(loaded.threads);
          await refreshSessions();
        })
        .catch((err) => {
          if (import.meta.env.DEV) console.warn("[chat-persistence] autosave failed:", err);
        });
    }, 600);

    return () => window.clearTimeout(id);
  }, [docPath, docName, activeSessionId, messages, refreshSessions, chatLoading, isStreaming, persistOutgoing]);

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
      const gen = bumpOpGen();
      onStopStreamRef.current?.();
      const snapshot = messagesRef.current;
      if (
        snapshot.length > 0 &&
        messagesSignature(snapshot) !== loadedSnapshotRef.current
      ) {
        try {
          await persistOutgoing(docPath, docName ?? "", sessionIdRef.current, snapshot);
          loadedSnapshotRef.current = messagesSignature(snapshot);
        } catch (err) {
          if (import.meta.env.DEV) console.warn("[chat-persistence] save before thread switch failed:", err);
        }
      }
      skipSaveRef.current = true;
      setChatLoading(true);
      try {
        const loaded = await switchThread(docPath, sessionId);
        if (gen !== opGenRef.current) return;
        setActiveSessionId(sessionId);
        setMessagesRef.current(loaded);
        loadedSnapshotRef.current = messagesSignature(loaded);
        const meta = await loadActiveMessages(docPath, undefined, { readOnly: true });
        setThreads(meta.threads);
        await refreshSessions();
      } finally {
        if (gen === opGenRef.current) {
          skipSaveRef.current = false;
          setChatLoading(false);
        }
      }
    },
    [docPath, docName, refreshSessions, persistOutgoing, bumpOpGen],
  );

  const newThread = useCallback(async () => {
    if (!docPath || !docName) return;
    const gen = bumpOpGen();
    onStopStreamRef.current?.();
    const snapshot = messagesRef.current;
    if (
      snapshot.length > 0 &&
      messagesSignature(snapshot) !== loadedSnapshotRef.current
    ) {
      try {
        await persistOutgoing(docPath, docName, sessionIdRef.current, snapshot);
        loadedSnapshotRef.current = messagesSignature(snapshot);
      } catch (err) {
        if (import.meta.env.DEV) console.warn("[chat-persistence] save before new thread failed:", err);
      }
    }
    skipSaveRef.current = true;
    setChatLoading(true);
    try {
      const { sessionId, threads: nextThreads } = await createThread(docPath, docName);
      if (gen !== opGenRef.current) return;
      setActiveSessionId(sessionId);
      setThreads(nextThreads);
      setMessagesRef.current([]);
      loadedSnapshotRef.current = messagesSignature([]);
    } finally {
      if (gen === opGenRef.current) {
        skipSaveRef.current = false;
        setChatLoading(false);
      }
    }
    await refreshSessions();
  }, [docPath, docName, refreshSessions, persistOutgoing, bumpOpGen]);

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
      const gen = bumpOpGen();
      await deleteThread(docPath, sessionId);
      if (sessionIdRef.current === sessionId) {
        skipSaveRef.current = true;
        setChatLoading(true);
        try {
          const loaded = await loadActiveMessages(docPath);
          if (gen !== opGenRef.current) return;
          setMessagesRef.current(loaded.messages);
          loadedSnapshotRef.current = messagesSignature(loaded.messages);
          setActiveSessionId(loaded.sessionId);
          setThreads(loaded.threads);
          appliedLoadKeyRef.current = loadKey;
        } finally {
          if (gen === opGenRef.current) {
            skipSaveRef.current = false;
            setChatLoading(false);
          }
        }
      }
      await refreshSessions();
    },
    [docPath, loadKey, refreshSessions, bumpOpGen],
  );

  const deleteSession = useCallback(
    async (path: string) => {
      if (path === docPath) onStopStreamRef.current?.();
      await clearDocSessions(path);
      if (path === docPath) {
        bumpOpGen();
        skipSaveRef.current = true;
        try {
          setMessagesRef.current([]);
          setThreads([]);
          setActiveSessionId("default");
          appliedLoadKeyRef.current = "";
          loadedSnapshotRef.current = messagesSignature([]);
        } finally {
          skipSaveRef.current = false;
        }
      }
      await refreshSessions();
    },
    [docPath, refreshSessions, bumpOpGen],
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
