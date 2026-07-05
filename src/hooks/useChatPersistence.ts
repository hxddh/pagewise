import { useCallback, useEffect, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
import { sanitizeMessagesForChat } from "../lib/messages-utils";
import { isTauriRuntime } from "../lib/runtime";

const PERSIST_CANCELLED = "persist_cancelled";
const STREAM_SETTLE_MS = 5000;
const STREAM_POLL_MS = 50;

function isPersistCancelled(err: unknown): boolean {
  return err instanceof Error && err.message === PERSIST_CANCELLED;
}

interface UseChatPersistenceOptions {
  docPath: string | null;
  docName: string | null;
  docLoadSeq: number;
  messages: UIMessage[];
  setMessages: (messages: UIMessage[]) => void;
  onDocumentSwitch?: (nextPath: string | null) => void;
  onDocumentSwitchCommitted?: () => void;
  onDocumentSwitchFailed?: () => void;
  onThreadSwitch?: () => void;
  onStopStream?: () => void;
  isStreaming?: boolean;
  onPersistError?: (message: string) => void;
  onActiveSessionIdChange?: (sessionId: string) => void;
}

export function useChatPersistence({
  docPath,
  docName,
  docLoadSeq,
  messages,
  setMessages,
  onDocumentSwitch,
  onDocumentSwitchCommitted,
  onDocumentSwitchFailed,
  onThreadSwitch,
  onStopStream,
  isStreaming = false,
  onPersistError,
  onActiveSessionIdChange,
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
  const saveEpochRef = useRef(0);
  const pendingSessionRef = useRef<{ path: string; sessionId: string } | undefined>(
    undefined,
  );
  const onDocumentSwitchRef = useRef(onDocumentSwitch);
  const onDocumentSwitchCommittedRef = useRef(onDocumentSwitchCommitted);
  const onDocumentSwitchFailedRef = useRef(onDocumentSwitchFailed);
  const onThreadSwitchRef = useRef(onThreadSwitch);
  const onStopStreamRef = useRef(onStopStream);
  const onPersistErrorRef = useRef(onPersistError);
  const onActiveSessionIdChangeRef = useRef(onActiveSessionIdChange);
  const isStreamingRef = useRef(isStreaming);
  const setMessagesRef = useRef(setMessages);
  const appliedLoadKeyRef = useRef("");
  const loadedSnapshotRef = useRef("");
  const messagesDocPathRef = useRef<string | null>(null);

  messagesRef.current = messages;
  sessionIdRef.current = activeSessionId;
  docPathRef.current = docPath;
  docNameRef.current = docName;
  onDocumentSwitchRef.current = onDocumentSwitch;
  onDocumentSwitchCommittedRef.current = onDocumentSwitchCommitted;
  onDocumentSwitchFailedRef.current = onDocumentSwitchFailed;
  onThreadSwitchRef.current = onThreadSwitch;
  onStopStreamRef.current = onStopStream;
  onPersistErrorRef.current = onPersistError;
  onActiveSessionIdChangeRef.current = onActiveSessionIdChange;
  isStreamingRef.current = isStreaming;
  setMessagesRef.current = setMessages;

  const loadKey = docPath ? `${docPath}#${docLoadSeq}` : "";

  const refreshSessions = useCallback(async () => {
    setSessions(await listChatSessions());
  }, []);

  const bumpSaveEpoch = useCallback(() => ++saveEpochRef.current, []);

  const persistOutgoing = useCallback(
    async (savePath: string, saveName: string, sessionId: string, outgoing: UIMessage[]) => {
      if (outgoing.length === 0) return;
      const epoch = saveEpochRef.current;
      const prepared = prepareMessagesForPersist(outgoing);
      await saveActiveSession(savePath, saveName, sessionId, prepared);
      if (epoch !== saveEpochRef.current) {
        throw new Error(PERSIST_CANCELLED);
      }
    },
    [],
  );

  const bumpOpGen = useCallback(() => ++opGenRef.current, []);

  const reportPersistError = useCallback((err: unknown, fallback: string) => {
    if (isPersistCancelled(err)) return;
    onPersistErrorRef.current?.(err instanceof Error ? err.message : fallback);
  }, []);

  const waitForStreamIdle = useCallback(async () => {
    if (!isStreamingRef.current) return;
    onStopStreamRef.current?.();
    const deadline = Date.now() + STREAM_SETTLE_MS;
    while (isStreamingRef.current && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, STREAM_POLL_MS));
    }
  }, []);

  const flushPendingSave = useCallback(async (): Promise<boolean> => {
    if (!docPathRef.current || !docNameRef.current || skipSaveRef.current) return true;
    if (messagesDocPathRef.current !== docPathRef.current) return true;
    const snapshot = messagesRef.current;
    if (snapshot.length === 0) return true;
    if (messagesSignature(snapshot) === loadedSnapshotRef.current) return true;

    await waitForStreamIdle();

    try {
      await persistOutgoing(
        docPathRef.current,
        docNameRef.current,
        sessionIdRef.current,
        messagesRef.current,
      );
      loadedSnapshotRef.current = messagesSignature(messagesRef.current);
      return true;
    } catch (err) {
      reportPersistError(err, "Failed to save conversation");
      return false;
    }
  }, [persistOutgoing, waitForStreamIdle, reportPersistError]);

  const hasUnsavedMessages = useCallback(() => {
    if (!docPathRef.current || !docNameRef.current || skipSaveRef.current) return false;
    if (messagesDocPathRef.current !== docPathRef.current) return false;
    const snapshot = messagesRef.current;
    if (snapshot.length === 0) return false;
    return messagesSignature(snapshot) !== loadedSnapshotRef.current;
  }, []);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") void flushPendingSave();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [flushPendingSave]);

  useEffect(() => {
    if (!isTauriRuntime()) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        const win = getCurrentWindow();
        if (disposed) return;
        unlisten = await win.onCloseRequested(async (event) => {
          const needsSave =
            hasUnsavedMessages() || isStreamingRef.current;
          if (!needsSave) return;
          event.preventDefault();
          const saved = await flushPendingSave();
          if (!saved && hasUnsavedMessages()) return;
          await win.destroy();
        });
      } catch (err) {
        if (import.meta.env.DEV) console.warn("[chat-persistence] close hook failed:", err);
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [flushPendingSave, hasUnsavedMessages]);

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
      bumpSaveEpoch();
      setChatLoading(true);

      if (isStreamingRef.current) onStopStreamRef.current?.();

      try {
        if (unsaved) {
          const savePath = pathChanged && prev ? prev : docPath!;
          const saveName = savePath.split(/[/\\]/).pop() ?? savePath;
          await persistOutgoing(savePath, saveName, sessionIdRef.current, outgoing);
          loadedSnapshotRef.current = messagesSignature(outgoing);
        }
      } catch (err) {
        reportPersistError(err, "Failed to save conversation");
        onDocumentSwitchFailedRef.current?.();
        if (gen === opGenRef.current) {
          skipSaveRef.current = false;
          setChatLoading(false);
        }
        return;
      }

      if (cancelled || gen !== opGenRef.current) return;

      messagesDocPathRef.current = null;
      onDocumentSwitchRef.current?.(docPath);

      try {
        const pending = pendingSessionRef.current;
        pendingSessionRef.current = undefined;
        const preferredSession =
          pending && pending.path === docPath ? pending.sessionId : undefined;
        const loaded = await loadActiveMessages(docPath!, preferredSession);

        if (cancelled || gen !== opGenRef.current) return;

        setMessagesRef.current(sanitizeMessagesForChat(loaded.messages));
        loadedSnapshotRef.current = messagesSignature(loaded.messages);
        messagesDocPathRef.current = docPath!;
        setActiveSessionId(loaded.sessionId);
        setThreads(loaded.threads);
        onActiveSessionIdChangeRef.current?.(loaded.sessionId);
        prevPathRef.current = docPath;
        appliedLoadKeyRef.current = loadKey;
        onDocumentSwitchCommittedRef.current?.();
        await refreshSessions();
      } catch (err) {
        reportPersistError(err, "Failed to load conversation");
        setMessagesRef.current([]);
        loadedSnapshotRef.current = messagesSignature([]);
        messagesDocPathRef.current = null;
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
  }, [docPath, docLoadSeq, loadKey, refreshSessions, persistOutgoing, bumpOpGen, bumpSaveEpoch, reportPersistError]);

  useEffect(() => {
    if (!docPath || !docName || skipSaveRef.current || chatLoading || isStreaming) return;

    const savePath = docPath;
    const saveName = docName;
    const saveSessionId = activeSessionId;
    const id = window.setTimeout(() => {
      if (skipSaveRef.current || chatLoading || isStreamingRef.current) return;
      if (docPathRef.current !== savePath || !docNameRef.current) return;
      if (messagesDocPathRef.current !== savePath) return;
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
          reportPersistError(err, "Autosave failed");
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
      onThreadSwitchRef.current?.();

      skipSaveRef.current = true;
      bumpSaveEpoch();
      setChatLoading(true);

      const snapshot = messagesRef.current;
      if (
        snapshot.length > 0 &&
        messagesSignature(snapshot) !== loadedSnapshotRef.current
      ) {
        try {
          await persistOutgoing(docPath, docName ?? "", sessionIdRef.current, snapshot);
          loadedSnapshotRef.current = messagesSignature(snapshot);
        } catch (err) {
          reportPersistError(err, "Failed to save before thread switch");
          if (gen === opGenRef.current) {
            skipSaveRef.current = false;
            setChatLoading(false);
          }
          return;
        }
      }

      try {
        const switched = await switchThread(docPath, sessionId);
        if (gen !== opGenRef.current) return;
        setMessagesRef.current(sanitizeMessagesForChat(switched.messages));
        loadedSnapshotRef.current = messagesSignature(switched.messages);
        messagesDocPathRef.current = docPath;
        setActiveSessionId(switched.sessionId);
        onActiveSessionIdChangeRef.current?.(switched.sessionId);
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
    [docPath, docName, refreshSessions, persistOutgoing, bumpOpGen, bumpSaveEpoch, reportPersistError],
  );

  const newThread = useCallback(async () => {
    if (!docPath || !docName) return;
    const gen = bumpOpGen();
    onStopStreamRef.current?.();
    onThreadSwitchRef.current?.();

    skipSaveRef.current = true;
    bumpSaveEpoch();
    setChatLoading(true);

    const snapshot = messagesRef.current;
    if (
      snapshot.length > 0 &&
      messagesSignature(snapshot) !== loadedSnapshotRef.current
    ) {
      try {
        await persistOutgoing(docPath, docName, sessionIdRef.current, snapshot);
        loadedSnapshotRef.current = messagesSignature(snapshot);
      } catch (err) {
        reportPersistError(err, "Failed to save before new thread");
        if (gen === opGenRef.current) {
          skipSaveRef.current = false;
          setChatLoading(false);
        }
        return;
      }
    }

    try {
      const { sessionId, threads: nextThreads } = await createThread(docPath, docName);
      if (gen !== opGenRef.current) return;
      setMessagesRef.current([]);
      loadedSnapshotRef.current = messagesSignature([]);
      messagesDocPathRef.current = docPath;
      setActiveSessionId(sessionId);
      setThreads(nextThreads);
      onActiveSessionIdChangeRef.current?.(sessionId);
    } finally {
      if (gen === opGenRef.current) {
        skipSaveRef.current = false;
        setChatLoading(false);
      }
    }
    await refreshSessions();
  }, [docPath, docName, refreshSessions, persistOutgoing, bumpOpGen, bumpSaveEpoch, reportPersistError]);

  const clearCurrentThread = useCallback(async () => {
    if (!docPath) return;
    const gen = bumpOpGen();
    onStopStreamRef.current?.();
    bumpSaveEpoch();
    skipSaveRef.current = true;
    setChatLoading(true);
    try {
      await clearActiveThread(docPath, sessionIdRef.current);
      setMessagesRef.current([]);
      loadedSnapshotRef.current = messagesSignature([]);
      const loaded = await loadActiveMessages(docPath);
      if (gen !== opGenRef.current) return;
      setActiveSessionId(loaded.sessionId);
      setThreads(loaded.threads);
      messagesDocPathRef.current = docPath;
      onActiveSessionIdChangeRef.current?.(loaded.sessionId);
      appliedLoadKeyRef.current = loadKey;
      await refreshSessions();
    } finally {
      if (gen === opGenRef.current) {
        skipSaveRef.current = false;
        setChatLoading(false);
      }
    }
  }, [docPath, loadKey, refreshSessions, bumpOpGen, bumpSaveEpoch]);

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
          setMessagesRef.current(sanitizeMessagesForChat(loaded.messages));
          loadedSnapshotRef.current = messagesSignature(loaded.messages);
          messagesDocPathRef.current = docPath;
          setActiveSessionId(loaded.sessionId);
          setThreads(loaded.threads);
          onActiveSessionIdChangeRef.current?.(loaded.sessionId);
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
      bumpSaveEpoch();
      if (path === docPath) onStopStreamRef.current?.();
      await clearDocSessions(path);
      if (path === docPath) {
        bumpOpGen();
        skipSaveRef.current = true;
        try {
          onActiveSessionIdChangeRef.current?.("default");
          setMessagesRef.current([]);
          setThreads([]);
          setActiveSessionId("default");
          messagesDocPathRef.current = null;
          appliedLoadKeyRef.current = "";
          loadedSnapshotRef.current = messagesSignature([]);
        } finally {
          skipSaveRef.current = false;
        }
      }
      await refreshSessions();
    },
    [docPath, refreshSessions, bumpOpGen, bumpSaveEpoch],
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
    flushPendingSave,
  };
}
