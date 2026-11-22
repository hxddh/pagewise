import type { ReactNode, RefObject } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDown } from "lucide-react";
import type { UIMessage } from "ai";
import { useI18n } from "../../i18n";
import { useFlipRows } from "../../hooks/useFlipRows";
import {
  findLastMessage,
  getInFlightAssistantMessage,
  hasSubstantialAnswerText,
} from "../../lib/messages-utils";
import type { VerifiedSentence } from "../../lib/answer-sentences";
import { Button } from "../../components/ui/Button";
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

  // Answer insertion (19.0): keyed on the ordered list of message IDs rather
  // than the `messages` reference so 6ms streaming token deltas inside the last
  // message never trigger synchronous `offsetTop` layout thrashing in `useLayoutEffect`.
  const flipKey = useMemo(() => messages.map((m) => m.id).join("\n"), [messages]);
  useFlipRows(listRef, "[data-message-id]", flipKey);

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
    if (!busy) return;
    const el = listRef.current;
    const tail = el?.lastElementChild;
    if (!el || !tail || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (!stickToBottomRef.current) return;
      el.scrollTop = el.scrollHeight;
    });
    ro.observe(tail);
    return () => {
      ro.disconnect();
    };
  }, [busy, messages.length, listRef, stickToBottomRef]);

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
    <>
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
                      ? onEdit
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
      {busy && messages.length > 0 && (
        <JumpToBottomButton listRef={listRef} stickToBottomRef={stickToBottomRef} />
      )}
    </>
  );
}

/**
 * Out-of-flow scroll-observer pill toggled via GPU opacity so scrolling a
 * 200-turn `.messages` flex column never triggers a flex-container reflow (29.0).
 */
function JumpToBottomButton({
  listRef,
  stickToBottomRef,
}: {
  listRef: RefObject<HTMLDivElement | null>;
  stickToBottomRef: RefObject<boolean>;
}) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    let timer = 0;
    const onScroll = () => {
      if (timer !== 0) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = 0;
        const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
        const shouldShow = distance >= 120;
        setVisible((prev) => (prev === shouldShow ? prev : shouldShow));
      }, 120);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (timer !== 0) window.clearTimeout(timer);
      el.removeEventListener("scroll", onScroll);
    };
  }, [listRef]);

  return (
    <Button
      variant="secondary"
      size="sm"
      icon
      className="messages-jump-bottom"
      data-visible={visible ? "true" : undefined}
      tabIndex={visible ? 0 : -1}
      aria-hidden={!visible}
      title={t("agent.scrollToBottom")}
      aria-label={t("agent.scrollToBottom")}
      onClick={() => {
        stickToBottomRef.current = true;
        setVisible(false);
        const el = listRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      }}
    >
      <ArrowDown size={14} />
    </Button>
  );
}
