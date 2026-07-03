import { useCallback, useEffect, useRef, useState } from "react";
import type { UIMessage } from "ai";
import {
  clearChatSession,
  listChatSessions,
  loadChatSession,
  saveChatSession,
  type StoredChatSession,
} from "../lib/chat-sessions";

interface UseChatPersistenceOptions {
  docPath: string | null;
  docName: string | null;
  messages: UIMessage[];
  setMessages: (messages: UIMessage[]) => void;
}

export function useChatPersistence({
  docPath,
  docName,
  messages,
  setMessages,
}: UseChatPersistenceOptions) {
  const [sessions, setSessions] = useState<StoredChatSession[]>([]);
  const messagesRef = useRef(messages);
  const prevPathRef = useRef<string | null>(null);
  const skipSaveRef = useRef(false);

  messagesRef.current = messages;

  const refreshSessions = useCallback(async () => {
    setSessions(await listChatSessions());
  }, []);

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  // On document switch: persist previous chat, load new
  useEffect(() => {
    let cancelled = false;

    async function switchDocument() {
      const prev = prevPathRef.current;

      if (prev && prev !== docPath) {
        const prevSession = sessions.find((s) => s.docPath === prev);
        const prevName = prevSession?.docName ?? prev.split(/[/\\]/).pop() ?? prev;
        await saveChatSession(prev, prevName, messagesRef.current);
      }

      if (docPath && docPath !== prev) {
        skipSaveRef.current = true;
        const loaded = await loadChatSession(docPath);
        if (!cancelled) {
          setMessages(loaded);
          skipSaveRef.current = false;
        }
      } else if (!docPath && prev) {
        skipSaveRef.current = true;
        setMessages([]);
        skipSaveRef.current = false;
      }

      prevPathRef.current = docPath;
      await refreshSessions();
    }

    void switchDocument();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docPath]);

  // Debounced autosave for current document
  useEffect(() => {
    if (!docPath || !docName || skipSaveRef.current) return;

    const id = window.setTimeout(() => {
      void saveChatSession(docPath, docName, messages).then(refreshSessions);
    }, 600);

    return () => window.clearTimeout(id);
  }, [docPath, docName, messages, refreshSessions]);

  const deleteSession = useCallback(
    async (path: string) => {
      await clearChatSession(path);
      if (path === docPath) {
        skipSaveRef.current = true;
        setMessages([]);
        skipSaveRef.current = false;
      }
      await refreshSessions();
    },
    [docPath, setMessages, refreshSessions],
  );

  return { sessions, refreshSessions, deleteSession };
}
