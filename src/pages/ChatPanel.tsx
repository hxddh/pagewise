import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChatStatus, UIMessage } from "ai";
import { MoreHorizontal, PanelRightClose } from "lucide-react";
import { useI18n } from "../i18n";
import { AnchoredMenu } from "../components/AnchoredMenu";
import { MessageAssistantFooter } from "../components/MessageAssistantFooter";
import { MessageContent } from "../components/MessageContent";
import type { PageWiseUIMessage } from "../lib/message-metadata";
import { EmptyState } from "../components/EmptyState";
import type { LoadedDocument } from "../lib/types";

import type { SendDocumentMessageOptions, RegenerateDocumentMessageOptions } from "../hooks/useDocAgent";
import {
  extractUserText,
  findLastMessage,
  getInFlightAssistantMessage,
  hasSubstantialAnswerText,
} from "../lib/messages-utils";

export interface ChatPanelHandle {
  focusComposer: () => void;
}

interface ChatPanelProps {
  activeDoc: LoadedDocument | null;
  previewPage: number;
  includeViewingPage: boolean;
  messages: UIMessage[];
  sendDocumentMessage: (opts: SendDocumentMessageOptions) => Promise<boolean>;
  editUserMessage?: (messageId: string, opts: SendDocumentMessageOptions) => Promise<boolean>;
  regenerateDocumentMessage?: (opts: RegenerateDocumentMessageOptions) => Promise<boolean>;
  status: ChatStatus;
  error: Error | undefined;
  errorMessage?: string;
  hasApiKey: boolean;
  agentToolsSupported?: boolean;
  settingsReady: boolean;
  loadingDoc: boolean;
  chatLoading?: boolean;
  agentBusy?: boolean;
  activity: string | null;
  historySettling?: boolean;
  composerDraft: string;
  onComposerDraftChange: (value: string) => void;
  onConfigureApi: () => void;
  onStop: () => void;
  onClearChat: () => void;
  onExportChat: () => void;
  onExportSummary: () => void;
  onCollapse?: () => void;
}

const COMPOSER_MAX_HEIGHT = 200;

export const ChatPanel = forwardRef<ChatPanelHandle, ChatPanelProps>(function ChatPanel(
  {
    activeDoc,
    previewPage,
    includeViewingPage,
    messages,
    sendDocumentMessage,
    editUserMessage,
    regenerateDocumentMessage,
    status,
    error,
    errorMessage,
    hasApiKey,
    agentToolsSupported = true,
    settingsReady,
    loadingDoc,
    chatLoading = false,
    agentBusy = false,
    activity,
    historySettling = false,
    composerDraft,
    onComposerDraftChange,
    onConfigureApi,
    onStop,
    onClearChat,
    onExportChat,
    onExportSummary,
    onCollapse,
  },
  ref,
) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    setEditingUserId(null);
    setEditDraft("");
    setEditError(null);
  }, [activeDoc?.path, chatLoading]);

  useImperativeHandle(ref, () => ({
    focusComposer: () => composerRef.current?.focus(),
  }));

  const busy = status === "streaming" || status === "submitted";
  const interactionBusy = busy || chatLoading || agentBusy;

  const lastAssistant = useMemo(
    () => findLastMessage(messages, (m) => m.role === "assistant"),
    [messages],
  );
  const inFlightAssistant = useMemo(
    () => getInFlightAssistantMessage(messages, busy),
    [messages, busy],
  );
  const lastUser = useMemo(
    () => findLastMessage(messages, (m) => m.role === "user"),
    [messages],
  );
  const showProgress = busy && !hasSubstantialAnswerText(inFlightAssistant);

  const composerDraftRef = useRef(composerDraft);
  composerDraftRef.current = composerDraft;

  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }, [composerDraft]);

  useEffect(() => {
    if (!stickToBottomRef.current || !messagesRef.current) return;
    messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
  }, [messages, status, activity]);

  const onMessagesScroll = useCallback(() => {
    const el = messagesRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distance < 48;
  }, []);

  const submit = useCallback(async () => {
    const text = composerDraft.trim();
    if (!text || interactionBusy) return;
    if (!hasApiKey || !agentToolsSupported) {
      onConfigureApi();
      return;
    }
    if (!activeDoc) return;
    stickToBottomRef.current = true;
    onComposerDraftChange("");
    try {
      const payload = {
        text,
        path: activeDoc.path,
        docName: activeDoc.name,
        docKind: activeDoc.kind,
        viewingPage: previewPage,
        totalPages: activeDoc.totalPages,
        includeViewingPage,
      };
      const sent = await sendDocumentMessage(payload);
      // Only restore the failed send's text if the user hasn't started a new
      // draft in the meantime — otherwise we'd clobber what they just typed.
      if (!sent && !composerDraftRef.current) {
        onComposerDraftChange(text);
      }
    } catch {
      if (!composerDraftRef.current) {
        onComposerDraftChange(text);
      }
    }
  }, [
    composerDraft,
    interactionBusy,
    hasApiKey,
    agentToolsSupported,
    activeDoc,
    previewPage,
    includeViewingPage,
    onConfigureApi,
    onComposerDraftChange,
    sendDocumentMessage,
  ]);

  // Read the viewing page / include-flag through refs: MessageAssistantFooter's
  // memo comparator intentionally ignores onRegenerate, so a footer already
  // rendered can hold an older handleRegenerate closure. Reading current values
  // from refs makes Regenerate use the page the user is actually on.
  const previewPageRef = useRef(previewPage);
  previewPageRef.current = previewPage;
  const includeViewingPageRef = useRef(includeViewingPage);
  includeViewingPageRef.current = includeViewingPage;

  const handleRegenerate = useCallback(async () => {
    if (!activeDoc || !regenerateDocumentMessage || interactionBusy) return;
    if (!hasApiKey || !agentToolsSupported) {
      onConfigureApi();
      return;
    }
    stickToBottomRef.current = true;
    await regenerateDocumentMessage({
      path: activeDoc.path,
      docName: activeDoc.name,
      docKind: activeDoc.kind,
      viewingPage: previewPageRef.current,
      totalPages: activeDoc.totalPages,
      includeViewingPage: includeViewingPageRef.current,
    });
  }, [
    activeDoc,
    regenerateDocumentMessage,
    interactionBusy,
    hasApiKey,
    agentToolsSupported,
    onConfigureApi,
  ]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await submit();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Ignore Enter while an IME composition is active (critical for CJK input).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <div className="chat-panel">
      <header className="panel-header">
        <div className="panel-header-main">
          <h2>{t("agent.title")}</h2>
        </div>
        <div className="header-actions">
          {onCollapse && (
            <button
              type="button"
              className="btn icon-btn"
              onClick={onCollapse}
              title={t("agent.hidePanel")}
              aria-label={t("agent.hidePanel")}
            >
              <PanelRightClose size={16} />
            </button>
          )}
          <button
            ref={moreBtnRef}
            type="button"
            className={`btn icon-btn ${menuOpen ? "active" : ""}`}
            onClick={() => setMenuOpen((o) => !o)}
            aria-label={t("agent.more")}
            aria-expanded={menuOpen}
            disabled={messages.length === 0}
          >
            <MoreHorizontal size={16} />
          </button>
          <AnchoredMenu
            open={menuOpen && messages.length > 0}
            onClose={() => setMenuOpen(false)}
            anchorRef={moreBtnRef}
            className="anchored-popover"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                void onExportChat();
              }}
              disabled={interactionBusy}
            >
              {t("agent.exportChat")}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                void onExportSummary();
              }}
              disabled={interactionBusy}
            >
              {t("agent.exportSummary")}
            </button>
            <button
              type="button"
              role="menuitem"
              className="danger"
              onClick={() => {
                setMenuOpen(false);
                onClearChat();
              }}
              disabled={interactionBusy}
            >
              {t("agent.clear")}
            </button>
          </AnchoredMenu>
        </div>
      </header>

      <div className="messages messages-panel" ref={messagesRef} onScroll={onMessagesScroll}>
        {chatLoading && (
          <div className="chat-loading chat-loading-overlay" aria-live="polite">
            <span className="preview-loading-spinner" aria-hidden />
            {t("agent.loadingHistory")}
          </div>
        )}
        {!chatLoading && messages.length === 0 ? (
          <EmptyState
            hasApiKey={hasApiKey}
            agentToolsSupported={agentToolsSupported}
            settingsReady={settingsReady}
            hasDocument={!!activeDoc}
            onConfigureApi={onConfigureApi}
            onExamplePrompt={(text) => {
              onComposerDraftChange(text);
              composerRef.current?.focus();
            }}
          />
        ) : (
          <>
            {messages.map((m) => (
              <div key={m.id} className={`message ${m.role}`}>
                {m.role === "assistant" ? (
                  <>
                    <MessageContent
                      message={m}
                      markdown
                      live={busy && m.id === inFlightAssistant?.id}
                      settling={historySettling && m.id === lastAssistant?.id && !busy}
                      activity={
                        busy && m.id === inFlightAssistant?.id && showProgress
                          ? (activity ?? t("agent.thinking"))
                          : null
                      }
                    />
                    <MessageAssistantFooter
                      message={m as PageWiseUIMessage}
                      live={busy && m.id === inFlightAssistant?.id}
                      canRegenerate={
                        !busy &&
                        m.id === lastAssistant?.id &&
                        !!lastUser &&
                        !!regenerateDocumentMessage
                      }
                      onRegenerate={() => void handleRegenerate()}
                    />
                  </>
                ) : editingUserId === m.id ? (
                  <form
                    className="message-edit-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!activeDoc || !editUserMessage || interactionBusy) return;
                      const text = editDraft.trim();
                      if (!text) return;
                      setEditError(null);
                      void editUserMessage(m.id, {
                        text,
                        path: activeDoc.path,
                        docName: activeDoc.name,
                        docKind: activeDoc.kind,
                        viewingPage: previewPage,
                        totalPages: activeDoc.totalPages,
                        includeViewingPage,
                      }).then((ok) => {
                        if (ok) {
                          setEditingUserId(null);
                          setEditError(null);
                        } else {
                          setEditError(errorMessage ?? t("agent.editFailed"));
                        }
                      });
                    }}
                  >
                    <textarea
                      className="message-edit-input"
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      rows={3}
                      autoFocus
                    />
                    <div className="message-edit-actions">
                      <button type="submit" className="btn btn-primary btn-sm" disabled={interactionBusy}>
                        {t("agent.resend")}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => {
                          setEditingUserId(null);
                          setEditError(null);
                        }}
                      >
                        {t("agent.cancelEdit")}
                      </button>
                    </div>
                    {editError && (
                      <p className="message-edit-error" role="alert">
                        {editError}
                      </p>
                    )}
                  </form>
                ) : (
                  <>
                    <MessageContent message={m} />
                    {editUserMessage && !interactionBusy && m.id === lastUser?.id && (
                      <button
                        type="button"
                        className="message-edit-btn"
                        onClick={() => {
                          setEditingUserId(m.id);
                          setEditError(null);
                          setEditDraft(extractUserText(m));
                        }}
                      >
                        {t("agent.editMessage")}
                      </button>
                    )}
                  </>
                )}
              </div>
            ))}
            {busy && showProgress && !inFlightAssistant && (
              <div className="message assistant message-in-progress" aria-live="polite">
                <p className="agent-generating-line message-inline-progress">
                  <span className="typing-dots" aria-hidden>
                    <span />
                    <span />
                    <span />
                  </span>
                  {activity ?? t("agent.thinking")}
                </p>
              </div>
            )}
          </>
        )}
      </div>

      {error && (
        <p className="error-line chat-error" role="alert">
          {errorMessage ?? error.message}
        </p>
      )}

      <form className="composer" onSubmit={handleSubmit}>
        <textarea
          ref={composerRef}
          value={composerDraft}
          onChange={(e) => onComposerDraftChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={activeDoc ? t("agent.placeholder") : t("agent.placeholderNoDoc")}
          rows={1}
          disabled={loadingDoc}
        />
        <div className="composer-footer">
          <span className="composer-hint">{t("agent.hint")}</span>
          {busy ? (
            <button type="button" className="btn stop-btn" onClick={onStop}>
              {t("agent.stop")}
            </button>
          ) : (
            <button
              type="submit"
              className="btn primary"
              disabled={!composerDraft.trim() || loadingDoc || !activeDoc}
            >
              {t("agent.send")}
            </button>
          )}
        </div>
      </form>
    </div>
  );
});
