import type { RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { Globe } from "lucide-react";
import { useI18n } from "../../i18n";
import { Button } from "../../components/ui/Button";
import { TextArea } from "../../components/ui/Field";
import { hasSeenComposerHint, markComposerHintSeen } from "../../lib/onboarding-hints";
import { reclaimUndeliveredNotes } from "../../lib/agent-steer";

/**
 * Put the caret at the end of the composer's text: "Ask about this" fills the
 * composer, and a caret landing in front of the quoted passage would turn
 * "type your question" into "type, then move the caret".
 */
export function focusComposerInput(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  el.focus();
  const end = el.value.length;
  try {
    el.setSelectionRange(end, end);
  } catch {
    // A hidden or detached textarea may refuse the range; focus is enough.
  }
}

export interface ComposerProps {
  draft: string;
  onDraftChange: (value: string) => void;
  /**
   * Attempt a send. Resolves true when the text left the composer — a new run
   * started, or a correction reached the run already going.
   */
  onSend: (text: string, options: { webSearch: boolean }) => Promise<boolean>;
  /** A stream is open; agentBusy is any run at all (incl. the send phase). */
  busy: boolean;
  agentBusy: boolean;
  /** The document is loading; the input is disabled. */
  loading: boolean;
  hasApiKey: boolean;
  hasDocument: boolean;
  /** This provider's model can search the web natively (OpenRouter). */
  webSearchAvailable: boolean;
  onStop: () => void;
  /** The textarea, so "Ask about this" can put the caret in it. */
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

const COMPOSER_MAX_HEIGHT = 200;

/**
 * The input, and everything that is about the input: the once-only keyboard
 * line, the per-message web opt-in (re-armed when a send fails untouched),
 * the height driven by the draft, and the late-correction hand-back. The send
 * itself is the panel's — whether a correction goes to the running agent or
 * starts a run of its own is about the run, not the box.
 */
export function Composer({
  draft,
  onDraftChange,
  onSend,
  busy,
  agentBusy,
  loading,
  hasApiKey,
  hasDocument,
  webSearchAvailable,
  onStop,
  textareaRef,
}: ComposerProps) {
  const { t } = useI18n();
  const [showHint, setShowHint] = useState(() => !hasSeenComposerHint());
  const [webForNext, setWebForNext] = useState(false);
  // Bumped on every manual toggle click: a failed send re-arms the web choice
  // only if the reader has not made a newer explicit one.
  const webToggleSeqRef = useRef(0);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }, [draft, textareaRef]);

  // A correction that arrived too late goes back in the composer — the run can
  // finish before the step that would have carried the note. Dropping the
  // reader's words is the one outcome that is never acceptable.
  useEffect(() => {
    if (busy) return;
    const undelivered = reclaimUndeliveredNotes();
    if (undelivered.length === 0) return;
    if (draftRef.current.trim()) return; // they have already typed something newer
    onDraftChange(undelivered.join("\n"));
  }, [busy, onDraftChange]);

  async function submit() {
    const text = draft.trim();
    if (!text) return;
    const seqAtSend = webToggleSeqRef.current;
    const useWeb = webSearchAvailable && webForNext;
    // The choice is spent on this message; a new one starts off.
    if (webForNext) setWebForNext(false);
    let sent = false;
    try {
      sent = await onSend(text, { webSearch: useWeb });
    } catch {
      sent = false;
    }
    if (sent) {
      // The one-time keyboard line under the input has done its job.
      markComposerHintSeen();
      setShowHint(false);
      return;
    }
    // Not sent: re-arm the failed send's web opt-in only if the reader hasn't
    // clicked the toggle since — their newer explicit choice wins.
    if (useWeb && webToggleSeqRef.current === seqAtSend) setWebForNext(true);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    void submit();
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
    <form className="composer" onSubmit={handleSubmit}>
      <TextArea
        ref={textareaRef}
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={
          busy
            ? t("agent.placeholderSteer")
            : !hasDocument
              ? t("agent.placeholderNoDoc")
              : hasApiKey
                ? t("agent.placeholder")
                : t("agent.placeholderNoKey")
        }
        rows={1}
        disabled={loading}
      />
      <div className="composer-footer">
        {/* Kept as an element either way: it is what holds the send button at
            the right edge of the footer. */}
        <span className="composer-hint">{showHint ? t("agent.hint") : null}</span>
        {webSearchAvailable && hasDocument && (
          <Button
            variant="ghost"
            size="md"
            icon
            className="web-toggle"
            onClick={() => {
              webToggleSeqRef.current += 1;
              setWebForNext((v) => !v);
            }}
            aria-pressed={webForNext}
            title={webForNext ? t("agent.webSearchOn") : t("agent.webSearchOff")}
            aria-label={webForNext ? t("agent.webSearchOn") : t("agent.webSearchOff")}
          >
            <Globe size={15} />
          </Button>
        )}
        {(busy || agentBusy) && !draft.trim() ? (
          <Button variant="secondary" size="md" onClick={onStop}>
            {t("agent.stop")}
          </Button>
        ) : busy && draft.trim() ? (
          // Typing during a run turns Stop into Steer: the same key, and the
          // run it replaces keeps every page it already read.
          <Button type="submit" variant="primary" size="md" disabled={loading || !hasDocument}>
            {t("agent.steer")}
          </Button>
        ) : (
          // Send, with or without a provider (24.0). Without one this button
          // used to read "Configure AI" and Enter opened Settings — the box
          // looked ready and was not. Now a question sent before AI is
          // connected opens Settings and waits in the box, going out once a
          // provider is (ChatPanel). The empty state above carries "Connect AI".
          <Button
            type="submit"
            variant="primary"
            size="md"
            disabled={!draft.trim() || loading || !hasDocument}
          >
            {t("agent.send")}
          </Button>
        )}
      </div>
    </form>
  );
}
