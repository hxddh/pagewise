import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useState } from "react";
import type { ChatStatus, UIMessage } from "ai";
import { MessageContent } from "../components/MessageContent";
import { EmptyState } from "../components/EmptyState";
import type { LoadedDocument } from "../lib/types";

interface ChatPanelProps {
  activeDoc: LoadedDocument | null;
  messages: UIMessage[];
  sendMessage: (message: { text: string }) => Promise<void>;
  status: ChatStatus;
  error: Error | undefined;
  hasApiKey: boolean;
  loadingDoc: boolean;
  onOpenPath: (path: string) => Promise<void>;
  onPageFocus: (page: number) => void;
  onFileError: (message: string | null) => void;
  onOpenSettings: () => void;
  onStop: () => void;
  onClearChat: () => void;
  onCollapse: () => void;
  onExportChat: () => void;
  onExportSummary: () => void;
}

export function ChatPanel({
  activeDoc,
  messages,
  sendMessage,
  status,
  error,
  hasApiKey,
  loadingDoc,
  onOpenPath,
  onPageFocus,
  onFileError,
  onOpenSettings,
  onStop,
  onClearChat,
  onCollapse,
  onExportChat,
  onExportSummary,
}: ChatPanelProps) {
  const [input, setInput] = useState("");
  const [loadingFile, setLoadingFile] = useState(false);

  const openFile = useCallback(async () => {
    onFileError(null);
    const selected = await open({
      multiple: false,
      filters: [
        {
          name: "Documents",
          extensions: ["pdf", "png", "jpg", "jpeg", "webp", "tiff", "bmp", "gif"],
        },
      ],
    });
    if (!selected || typeof selected !== "string") return;

    setLoadingFile(true);
    try {
      await onOpenPath(selected);
    } finally {
      setLoadingFile(false);
    }
  }, [onOpenPath, onFileError]);

  const busy = status === "streaming" || status === "submitted";

  const submit = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    await sendMessage({ text });
  }, [input, busy, sendMessage]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await submit();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <div className="chat-panel">
      <header className="panel-header">
        <h2>Agent</h2>
        <div className="header-actions">
          {messages.length > 0 && (
            <>
              <button type="button" className="btn ghost" onClick={onExportChat} disabled={busy}>
                Export
              </button>
              <button type="button" className="btn ghost" onClick={onExportSummary} disabled={busy}>
                Summary
              </button>
              <button type="button" className="btn ghost" onClick={onClearChat} disabled={busy}>
                Clear
              </button>
            </>
          )}
          <button
            type="button"
            className="btn icon-btn"
            onClick={onCollapse}
            title="Hide panel"
            aria-label="Hide agent panel"
          >
            →
          </button>
        </div>
      </header>

      <div className="messages">
        {messages.length === 0 ? (
          <EmptyState
            hasApiKey={hasApiKey}
            hasDocument={!!activeDoc}
            onOpenSettings={onOpenSettings}
            onOpenFile={openFile}
            onSendExample={(text) => void sendMessage({ text })}
          />
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`message ${m.role}`}>
              {m.role === "assistant" ? (
                <MessageContent
                  message={m}
                  docName={activeDoc?.name}
                  markdown
                  onPageFocus={onPageFocus}
                />
              ) : (
                <MessageContent message={m} />
              )}
            </div>
          ))
        )}
      </div>

      {error && <p className="error-line chat-error">{error.message}</p>}

      <form className="composer" onSubmit={handleSubmit}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            activeDoc ? "Ask about this document…" : "Open a document to begin…"
          }
          rows={3}
          disabled={loadingDoc}
        />
        <div className="composer-footer">
          <span className="composer-hint">Enter to send · Shift+Enter for newline</span>
          {busy ? (
            <button type="button" className="btn stop-btn" onClick={onStop}>
              Stop
            </button>
          ) : (
            <button
              type="submit"
              className="btn primary"
              disabled={!input.trim() || !activeDoc || loadingDoc}
            >
              Send
            </button>
          )}
        </div>
      </form>

      {(loadingFile || loadingDoc) && <div className="loading-toast">Opening file…</div>}
    </div>
  );
}
