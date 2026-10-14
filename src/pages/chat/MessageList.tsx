import type { ReactNode, RefObject } from "react";
import { useCallback, useEffect, useMemo } from "react";
import type { UIMessage } from "ai";
import { useI18n } from "../../i18n";
import { useFlipRows } from "../../hooks/useFlipRows";
import {
  findLastMessage,
  getInFlightAssistantMessage,
  hasSubstantialAnswerText,
} from "../../lib/messages-utils";
import type { VerifiedSentence } from "../../lib/citation-check";
import { MessageRow } from "./MessageRow";

export interface MessageListProps {
  messages: UIMessage[];
  /** Chat history is being read from disk. */
  chatLoading: boolean;
  /** A stream is open (status streaming/submitted). */
  busy: boolean;
  /** Any run at all, including the pre-stream send phase. */
  agentBusy: boolean;
  /** The newest answer is settling after a run (tool outputs being pruned). */
  settling: boolean;
  /** The run's activity line, already translated. */
  activity: string | null;
  /** Anything running: the rows' edit affordances stand down while true. */
  interactionBusy: boolean;
  /** The scroller. Shared with the panel: conversation keys and the send
   *  state machine both read the same "is the reader at the tail" flag. */
  listRef: RefObject<HTMLDivElement | null>;
  stickToBottomRef: RefObject<boolean>;
  /** Scroll to and focus this turn — a record entry pointing back at an answer. */
  reveal: { id: string; nonce: number } | null;
  /** Regenerate is available at all (an answer exists and a handler was given). */
  canRegenerate: boolean;
  onRegenerate: () => void;
  onKeep?: (claim: string, pages: number[], source: { body: string; messageId: string }) => void;
  onKeepVerified?: (sentences: VerifiedSentence[], messageId: string) => void;
  onEdit?: (messageId: string, text: string) => Promise<boolean>;
  readEditError: () => string | undefined;
  /** Drawn in place of the rows when the conversation is empty. */
  empty: ReactNode;
}

/**
 * The transcript: which turn is newest, which answer is still being written,
 * whether the activity line should show yet, and where a record entry points
 * back to. The scroll container is passed in — the panel's Alt+Up/Down and the
 * follow-the-tail flag live on it.
 */
export function MessageList({
  messages,
  chatLoading,
  busy,
  agentBusy,
  settling,
  activity,
  interactionBusy,
  listRef,
  stickToBottomRef,
  reveal,
  canRegenerate,
  onRegenerate,
  onKeep,
  onKeepVerified,
  onEdit,
  readEditError,
  empty,
}: MessageListProps) {
  const { t } = useI18n();

  const lastAssistant = useMemo(
    () => findLastMessage(messages, (m) => m.role === "assistant"),
    [messages],
  );
  const lastUser = useMemo(() => findLastMessage(messages, (m) => m.role === "user"), [messages]);
  const inFlight = useMemo(() => getInFlightAssistantMessage(messages, busy), [messages, busy]);
  // The activity line belongs to the answer that is still mostly empty.
  const showProgress = busy && !hasSubstantialAnswerText(inFlight);

  // Answer insertion (19.0): a new turn, or the in-progress row becoming a
  // real one, moves the rows above it — so those rows are animated from where
  // they were instead of appearing to jump. Reduced motion turns this off
  // inside the hook, because a layout effect is out of the stylesheet's reach.
  useFlipRows(listRef, "[data-message-id]", messages);

  // Following the tail: a new chunk pulls the reader back only if they had
  // not scrolled away.
  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distance < 48;
  }, [listRef, stickToBottomRef]);

  useEffect(() => {
    if (!stickToBottomRef.current || !listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, busy, activity, listRef, stickToBottomRef]);

  useEffect(() => {
    if (!reveal) return;
    const id = reveal.id;
    const frame = requestAnimationFrame(() => {
      const row = listRef.current?.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(id)}"]`,
      );
      if (!row) return;
      row.scrollIntoView({ block: "center" });
      row.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [reveal, listRef]);

  return (
    <div className="messages messages-panel" ref={listRef} onScroll={onScroll}>
      {chatLoading && (
        <div className="chat-loading chat-loading-overlay" aria-live="polite">
          <span className="preview-loading-spinner" aria-hidden />
          {t("agent.loadingHistory")}
        </div>
      )}
      {!chatLoading && messages.length === 0 ? (
        empty
      ) : (
        <>
          {messages.map((m) => {
            const isInFlight = busy && m.id === inFlight?.id;
            return (
              <MessageRow
                key={m.id}
                message={m}
                live={isInFlight}
                settling={settling && m.id === lastAssistant?.id && !busy}
                activity={
                  isInFlight && showProgress ? (activity ?? t("agent.thinking")) : null
                }
                canRegenerate={
                  !busy && m.id === lastAssistant?.id && !!lastUser && canRegenerate
                }
                onRegenerate={onRegenerate}
                onKeep={onKeep}
                onKeepVerified={onKeepVerified}
                onEdit={
                  onEdit && !interactionBusy && m.id === lastUser?.id
                    ? (messageId, text) => onEdit(messageId, text)
                    : undefined
                }
                readEditError={readEditError}
                interactionBusy={interactionBusy}
              />
            );
          })}
          {agentBusy && !inFlight && (
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
  );
}
