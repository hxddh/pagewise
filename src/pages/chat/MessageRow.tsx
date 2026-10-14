import { useState } from "react";
import type { UIMessage } from "ai";
import { useI18n } from "../../i18n";
import { MessageAssistantFooter } from "../../components/MessageAssistantFooter";
import { MessageContent } from "../../components/MessageContent";
import { Button } from "../../components/ui/Button";
import { TextArea } from "../../components/ui/Field";
import { extractUserText } from "../../lib/messages-utils";
import type { PageWiseUIMessage } from "../../lib/message-metadata";
import type { VerifiedSentence } from "../../lib/citation-check";

export interface MessageRowProps {
  message: UIMessage;
  /** The answer currently being written. */
  live: boolean;
  /** The newest answer, settling after a run. */
  settling: boolean;
  /** The activity line while this live answer has no text yet. */
  activity: string | null;
  /** Regenerate is offered on this row (it is the newest answer). */
  canRegenerate: boolean;
  onRegenerate: () => void;
  /** Keep a claim from this answer in the record. Absent with no document. */
  onKeep?: (claim: string, pages: number[], source: { body: string; messageId: string }) => void;
  /** Keep the answer's verified sentences, one record entry each. */
  onKeepVerified?: (sentences: VerifiedSentence[], messageId: string) => void;
  /** Rewrite this question. Absent when editing is not offered on this row. */
  onEdit?: (messageId: string, text: string) => Promise<boolean>;
  /** Read the latest provider error, for an edit whose resend just failed. */
  readEditError: () => string | undefined;
  /** Anything running: while true, an edit cannot be resubmitted. */
  interactionBusy: boolean;
}

/**
 * One turn in the conversation: its content, its footer, and the edit form on
 * a question (the one thing genuinely per-message). Everything else — whether
 * a run is live, whether this is the newest answer, whether claims can be
 * kept — is the conversation's, and arrives as props from MessageList.
 */
export function MessageRow({
  message,
  live,
  settling,
  activity,
  canRegenerate,
  onRegenerate,
  onKeep,
  onKeepVerified,
  onEdit,
  readEditError,
  interactionBusy,
}: MessageRowProps) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [editError, setEditError] = useState<string | null>(null);

  const assistant = message.role === "assistant";

  function submitEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!onEdit || interactionBusy) return;
    const text = draft.trim();
    if (!text) return;
    setEditError(null);
    void onEdit(message.id, text).then((ok) => {
      if (ok) {
        setEditing(false);
        setEditError(null);
        return;
      }
      // The agent error state settles a render after the reject; read it next
      // frame so the real provider message shows, not the generic fallback.
      requestAnimationFrame(() => setEditError(readEditError() ?? t("agent.editFailed")));
    });
  }

  return (
    <div
      data-message-id={message.id}
      // Programmatically focusable only: keyboard navigation moves focus here,
      // but Tab must not walk every turn of a long conversation on the way to
      // the composer.
      tabIndex={-1}
      className={`message ${message.role}`}
    >
      {assistant ? (
        <>
          <MessageContent
            message={message}
            markdown
            live={live}
            settling={settling}
            activity={activity}
          />
          <MessageAssistantFooter
            message={message as PageWiseUIMessage}
            onKeep={onKeep}
            onKeepVerified={onKeepVerified}
            live={live}
            canRegenerate={canRegenerate}
            onRegenerate={onRegenerate}
          />
        </>
      ) : editing ? (
        <form className="message-edit-form" onSubmit={submitEdit}>
          <TextArea
            className="message-edit-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            autoFocus
          />
          <div className="message-edit-actions">
            <Button type="submit" variant="primary" size="md" disabled={interactionBusy}>
              {t("agent.resend")}
            </Button>
            <Button
              variant="secondary" size="sm"
              onClick={() => {
                setEditing(false);
                setEditError(null);
              }}
            >
              {t("agent.cancelEdit")}
            </Button>
          </div>
          {editError && (
            <p className="message-edit-error" role="alert">
              {editError}
            </p>
          )}
        </form>
      ) : (
        <>
          <MessageContent message={message} />
          {onEdit && !interactionBusy && (
            <Button
              variant="ghost" size="sm"
              className="message-edit-trigger"
              onClick={() => {
                setEditing(true);
                setEditError(null);
                setDraft(extractUserText(message));
              }}
            >
              {t("agent.editMessage")}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
