import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useI18n } from "../i18n";
import { useConversationKeys } from "../hooks/useConversationKeys";
import { PageRefContext } from "../components/Markdown";
import { CitationContext, type CitationEnv } from "../components/CitationChip";
import type { PdfRect } from "../lib/types";
import { RecordPanel } from "../components/RecordPanel";
import { findingsAreStale } from "../lib/finding-store";
import { ChatEmptyState } from "../components/EmptyState";
import type { LoadedDocument } from "../lib/types";
import type { DocAgent } from "../hooks/useDocAgent";
import { MessageList } from "./chat/MessageList";
import { Composer, focusComposerInput } from "./chat/Composer";
import { ChatNotices } from "./chat/ChatNotices";
import { useChatSend } from "./chat/useChatSend";
import { useRecordBridge } from "./chat/useRecordBridge";

export interface ChatPanelHandle {
  focusComposer: () => void;
}

/**
 * The assistant column: which half is showing, how the transcript and the
 * record talk to each other, and the section the composer sits in. The
 * transcript, the input, the notices, the send state machine and the record
 * bridge are their own files since 19.0; the header that used to live here is
 * the workspace's one strip, which is why the tabs arrive as a prop.
 */
export interface ChatPanelProps {
  doc: LoadedDocument | null;
  /** The page the reader is on. */
  page: number;
  includeViewingPage: boolean;
  /** The run, the transcript and the history, grouped (see useDocAgent). */
  agent: DocAgent;
  /** What the provider and settings allow. */
  connection: {
    hasApiKey: boolean;
    agentToolsSupported: boolean;
    webSearchAvailable: boolean;
    settingsReady: boolean;
  };
  session: { loading: boolean; chatLoading: boolean };
  composerDraft: string;
  onComposerDraftChange: (value: string) => void;
  /** Which half of the column is showing, owned by the workspace header. */
  panel: {
    tab: "chat" | "record";
    setTab: (tab: "chat" | "record") => void;
    /** Findings-store revision, so the record redraws when it changes. */
    revision: number;
  };
  /** Turning to pages, from answers, from the record, and from the margin. */
  reveal: {
    onJumpToPage?: (page: number) => void;
    onRevealFinding?: (id: string, page: number) => void;
    onRevealCitation?: (page: number, rects: PdfRect[] | null, notice?: string) => void;
    /** Turn to a mark and open its note. */
    onSelectMark?: (page: number, id: string) => void;
  };
  /** Pages with no text yet, and the way to read them. */
  scan: { count: number; onScanAllPages?: () => void };
  onConfigureApi: () => void;
}

export const ChatPanel = forwardRef<ChatPanelHandle, ChatPanelProps>(function ChatPanel(
  {
    doc,
    page,
    includeViewingPage,
    agent,
    connection,
    session,
    composerDraft,
    onComposerDraftChange,
    panel,
    reveal,
    scan,
    onConfigureApi,
  },
  ref,
) {
  const { t } = useI18n();
  // Citations lead back to the open document; with none open they are text.
  const citationEnv = useMemo<CitationEnv | null>(
    () =>
      doc
        ? {
            path: doc.path,
            totalPages: doc.totalPages ?? 0,
            onReveal: (target, rects, notice) => {
              if (reveal.onRevealCitation) reveal.onRevealCitation(target, rects, notice);
              else reveal.onJumpToPage?.(target);
            },
          }
        : null,
    [doc?.path, doc?.totalPages, reveal.onRevealCitation, reveal.onJumpToPage],
  );
  // Keyed by path: dismissing the scan offer must not hide it for the next doc.
  const [scanHintDismissed, setScanHintDismissed] = useState<string | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const composerDraftRef = useRef(composerDraft);
  composerDraftRef.current = composerDraft;
  // Read through a ref: the error prop settles a render after a reject.
  const errorMessageRef = useRef(agent.run.errorMessage);
  errorMessageRef.current = agent.run.errorMessage;

  useImperativeHandle(ref, () => ({
    focusComposer: () => focusComposerInput(composerRef.current),
  }));

  const busy = agent.run.status === "streaming" || agent.run.status === "submitted";
  const agentBusy = agent.run.isBusy();
  const interactionBusy = busy || session.chatLoading || agentBusy;

  useEffect(() => {
    setScanHintDismissed(null);
  }, [doc?.path]);

  const readDraft = useCallback(() => composerDraftRef.current, []);
  const { send, regenerate } = useChatSend({
    doc,
    page,
    includeViewingPage,
    agent,
    busy,
    chatLoading: session.chatLoading,
    interactionBusy,
    hasApiKey: connection.hasApiKey,
    onConfigureApi,
    onComposerDraftChange,
    readDraft,
    stickToBottomRef,
  });
  const record = useRecordBridge({ doc, messages: agent.messages.list, setTab: panel.setTab });

  // Alt+Up / Alt+Down walk the conversation, on the panel root so it works
  // while the composer has focus; the find chord is the workspace's search.
  const convKeys = useConversationKeys(messagesRef, stickToBottomRef);

  return (
    <PageRefContext.Provider value={reveal.onJumpToPage ?? null}>
      <CitationContext.Provider value={citationEnv}>
        <section className="chat-panel" aria-label={t("agent.title")} onKeyDown={convKeys.onKeyDown}>
          {panel.tab === "record" ? (
            <RecordPanel
              path={doc?.path ?? ""}
              revision={panel.revision}
              currentPage={page}
              stale={doc ? findingsAreStale(doc.path, doc.stamp ?? "") : false}
              stamp={doc?.stamp ?? ""}
              totalPages={doc?.totalPages ?? 0}
              onJumpToPage={(target) => reveal.onJumpToPage?.(target)}
              onRevealFinding={reveal.onRevealFinding}
              onSelectMark={reveal.onSelectMark}
              onRevealMessage={record.revealMessage}
              hasMessage={record.hasMessage}
            />
          ) : (
            <MessageList
              messages={agent.messages.list}
              chatLoading={session.chatLoading}
              busy={busy}
              agentBusy={agentBusy}
              settling={agent.history.settling}
              activity={agent.run.progress}
              interactionBusy={interactionBusy}
              listRef={messagesRef}
              stickToBottomRef={stickToBottomRef}
              reveal={record.revealTarget}
              canRegenerate={!!doc}
              onRegenerate={() => void regenerate()}
              onKeep={doc ? record.keepClaim : undefined}
              onKeepVerified={doc ? record.keepVerified : undefined}
              onEdit={(messageId, text) =>
                agent.run.edit(messageId, {
                  text,
                  path: doc?.path ?? "",
                  docName: doc?.name ?? "",
                  docKind: doc?.kind ?? "pdf",
                  viewingPage: page,
                  totalPages: doc?.totalPages ?? 0,
                  includeViewingPage,
                })
              }
              readEditError={() => errorMessageRef.current}
              empty={
                <ChatEmptyState
                  hasApiKey={connection.hasApiKey}
                  agentToolsSupported={connection.agentToolsSupported}
                  settingsReady={connection.settingsReady}
                  hasDocument={!!doc}
                  totalPages={doc?.totalPages}
                  previewPage={page}
                  onConfigureApi={onConfigureApi}
                  onExamplePrompt={(text) => {
                    onComposerDraftChange(text);
                    composerRef.current?.focus();
                  }}
                />
              }
            />
          )}

          {/* The scan offer shows where the symptom does, after at least one
              turn — a remedy, not a welcome. */}
          <ChatNotices
            unscanned={scan.count}
            onScanAll={agent.messages.list.length > 0 ? scan.onScanAllPages : undefined}
            scanDismissed={!!doc && scanHintDismissed === doc.path}
            onDismissScan={() => setScanHintDismissed(doc?.path ?? null)}
            error={agent.run.error}
            errorMessage={agent.run.errorMessage}
            onRetry={() => void regenerate()}
            onDismissError={agent.run.clearError}
            interactionBusy={interactionBusy}
            canRetry={!!doc}
          />

          <Composer
            draft={composerDraft}
            onDraftChange={onComposerDraftChange}
            onSend={send}
            busy={busy}
            agentBusy={agentBusy}
            loading={session.loading}
            hasApiKey={connection.hasApiKey}
            hasDocument={!!doc}
            webSearchAvailable={connection.webSearchAvailable}
            onStop={agent.run.stop}
            onConfigureApi={onConfigureApi}
            textareaRef={composerRef}
          />
        </section>
      </CitationContext.Provider>
    </PageRefContext.Provider>
  );
});
