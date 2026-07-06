import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { loadDocument } from "../lib/load-document";
import { docCache } from "../lib/doc-cache";
import { clearPdfCache, setActivePdfPath } from "../lib/pdf";
import { addRecentFile, getRecentFiles, type RecentFile } from "../lib/recent-files";
import { cancelIndex, reindexDocument } from "../document/index-queue";
import { clearChat as clearChatFile, loadChat, saveChat } from "../chat/persist";
import { useDocAgent } from "../hooks/useDocAgent";
import { useConnectionStatus } from "../hooks/useConnectionStatus";
import { useResizeWidth } from "../hooks/useResizeWidth";
import { useTauriFileDrop } from "../hooks/useTauriFileDrop";
import { useI18n } from "../i18n";
import { useToast } from "../hooks/useToast";
import type { PageWiseUIMessage } from "../lib/message-metadata";
import { chatToMarkdown } from "../lib/export-markdown";
import { saveMarkdownFile } from "../lib/save-markdown";
import type { LoadedDocument } from "../lib/types";
import type { LoadProgress } from "../lib/load-progress";
import type { AppPhase } from "./types";
import { clearAgentMessageContext } from "../lib/agent-view-context";

interface SessionContextValue {
  phase: AppPhase;
  document: LoadedDocument | null;
  previewPage: number;
  setPreviewPage: (page: number) => void;
  messages: PageWiseUIMessage[];
  setMessages: (messages: PageWiseUIMessage[]) => void;
  fileError: string | null;
  clearFileError: () => void;
  loading: boolean;
  chatLoading: boolean;
  progress: LoadProgress | null;
  recentFiles: RecentFile[];
  openFileDialog: () => void;
  openPath: (path: string) => void;
  reindexDoc: () => void;
  agentOpen: boolean;
  setAgentOpen: (open: boolean) => void;
  agent: ReturnType<typeof useDocAgent>;
  connection: ReturnType<typeof useConnectionStatus>;
  chatWidth: number;
  onPointerDown: (e: React.PointerEvent) => void;
  nudgeWidth: (delta: number) => void;
  minWidth: number;
  maxWidth: number;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  clearChat: () => Promise<void>;
  exportChat: () => Promise<void>;
  isDragging: boolean;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within SessionProvider");
  return ctx;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const { showToast } = useToast();

  const [phase, setPhase] = useState<AppPhase>("empty");
  const [document, setDocument] = useState<LoadedDocument | null>(null);
  const [previewPage, setPreviewPage] = useState(1);
  const [fileError, setFileError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [chatLoading, setChatLoading] = useState(false);
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  const [agentOpen, setAgentOpen] = useState(
    () => localStorage.getItem("pagewise.agentOpen") !== "0",
  );
  const [settingsOpen, setSettingsOpen] = useState(false);

  const epochRef = useRef(0);
  const documentRef = useRef<LoadedDocument | null>(null);
  documentRef.current = document;
  const loadAbortRef = useRef<AbortController | null>(null);
  const chatHydrateRef = useRef<{ path: string; messages: PageWiseUIMessage[] } | null>(null);

  const chatId = document?.path ?? "pagewise-local";
  const agent = useDocAgent(chatId);
  const connection = useConnectionStatus();
  const resize = useResizeWidth();

  useEffect(() => {
    localStorage.setItem("pagewise.agentOpen", agentOpen ? "1" : "0");
  }, [agentOpen]);

  useEffect(() => {
    void getRecentFiles().then(setRecentFiles);
  }, []);

  useEffect(() => {
    return docCache.subscribe((path) => {
      if (documentRef.current?.path !== path) return;
      const fresh = docCache.get(path);
      if (fresh) setDocument(fresh);
    });
  }, []);

  useEffect(() => {
    const pending = chatHydrateRef.current;
    if (!pending || document?.path !== pending.path || chatId !== pending.path) return;
    agent.setMessages(pending.messages);
    chatHydrateRef.current = null;
    setChatLoading(false);
  }, [document?.path, chatId, agent]);

  const saveTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!document?.path || agent.messages.length === 0) return;
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      void saveChat(document.path, agent.messages).catch((e) => {
        if (import.meta.env.DEV) console.warn("[session] autosave failed", e);
      });
    }, 500);
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
  }, [document?.path, agent.messages]);

  const switchDocument = useCallback(
    async (path: string) => {
      const myEpoch = ++epochRef.current;
      const prev = documentRef.current;

      setPhase("switching");
      setLoading(true);
      setChatLoading(true);
      setProgress({ stage: "opening", message: "load.opening", percent: 0 });
      setFileError(null);

      const messagesToSave = [...agent.messages];
      agent.stop();
      agent.resetForDocumentSwitch();
      clearAgentMessageContext();

      if (prev) {
        try {
          await saveChat(prev.path, messagesToSave);
        } catch (e) {
          if (import.meta.env.DEV) console.warn("[session] save chat on switch failed", e);
          showToast(t("toast.chatSaveFailed"), "error");
        }
        cancelIndex(prev.path);
        docCache.remove(prev.path);
      }

      loadAbortRef.current?.abort();
      const controller = new AbortController();
      loadAbortRef.current = controller;

      try {
        const doc = await loadDocument(path, (p) => {
          if (epochRef.current === myEpoch) setProgress(p);
        }, controller.signal);

        if (epochRef.current !== myEpoch) return;

        const messages = (await loadChat(path)) as PageWiseUIMessage[];
        clearPdfCache();
        setActivePdfPath(doc.path);
        chatHydrateRef.current = { path: doc.path, messages };
        setDocument(docCache.get(doc.path) ?? doc);
        setPreviewPage(1);
        setPhase("ready");

        const recent = await addRecentFile({ path: doc.path, name: doc.name, kind: doc.kind });
        if (epochRef.current === myEpoch) setRecentFiles(recent);
        showToast(t("toast.opened", { name: doc.name }), "success");
      } catch (e) {
        if (epochRef.current !== myEpoch) return;
        if (e instanceof Error && e.name === "AbortError") return;
        const raw = e instanceof Error ? e.message : "";
        const msg =
          raw === "errors.unsupportedFile" || raw.startsWith("errors.")
            ? t(raw)
            : raw || t("load.failed");
        setFileError(msg);
        showToast(msg, "error");
        setPhase(prev ? "ready" : "empty");
        setChatLoading(false);
        chatHydrateRef.current = null;
        if (!prev) {
          setDocument(null);
        }
      } finally {
        if (epochRef.current === myEpoch) {
          setLoading(false);
          setProgress(null);
          if (loadAbortRef.current === controller) {
            loadAbortRef.current = null;
          }
        }
      }
    },
    [agent, showToast, t],
  );

  const openPath = useCallback((path: string) => void switchDocument(path), [switchDocument]);

  const openFileDialog = useCallback(() => {
    void (async () => {
      const selected = await open({
        multiple: false,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (typeof selected === "string") void switchDocument(selected);
    })();
  }, [switchDocument]);

  const { isDragging } = useTauriFileDrop((paths) => {
    const pdf = paths.find((p) => p.toLowerCase().endsWith(".pdf"));
    if (pdf) void switchDocument(pdf);
  });

  const reindexDoc = useCallback(() => {
    const path = documentRef.current?.path;
    if (!path) return;
    reindexDocument(path);
    showToast(t("toast.reindexStarted"), "default");
  }, [showToast, t]);

  const clearChat = useCallback(async () => {
    const doc = documentRef.current;
    if (!doc) return;
    agent.clearChat();
    await clearChatFile(doc.path);
  }, [agent]);

  const exportChat = useCallback(async () => {
    const doc = documentRef.current;
    if (!doc || agent.messages.length === 0) {
      showToast(t("toast.noMessages"), "error");
      return;
    }
    const md = chatToMarkdown(agent.messages, doc.name);
    try {
      const ok = await saveMarkdownFile(md, `${doc.name}-chat.md`, t("dialog.markdownFilter"));
      if (ok) showToast(t("toast.chatExported"), "success");
    } catch {
      showToast(t("toast.exportFailed"), "error");
    }
  }, [agent.messages, showToast, t]);

  const value = useMemo<SessionContextValue>(
    () => ({
      phase,
      document,
      previewPage,
      setPreviewPage,
      messages: agent.messages,
      setMessages: agent.setMessages,
      fileError,
      clearFileError: () => setFileError(null),
      loading,
      chatLoading,
      progress,
      recentFiles,
      openFileDialog,
      openPath,
      reindexDoc,
      agentOpen,
      setAgentOpen,
      agent,
      connection,
      chatWidth: resize.width,
      onPointerDown: resize.onPointerDown,
      nudgeWidth: resize.nudgeWidth,
      minWidth: resize.min,
      maxWidth: resize.max,
      settingsOpen,
      setSettingsOpen,
      clearChat,
      exportChat,
      isDragging,
    }),
    [
      phase,
      document,
      previewPage,
      agent,
      fileError,
      loading,
      chatLoading,
      progress,
      recentFiles,
      openFileDialog,
      openPath,
      reindexDoc,
      agentOpen,
      connection,
      resize,
      settingsOpen,
      clearChat,
      exportChat,
      isDragging,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
