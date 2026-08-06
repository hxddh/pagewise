import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { MAX_NOTE_TEXT, removeMark, setMarkNote, type Mark } from "../../lib/mark-store";
import { Button } from "../../components/ui/Button";
import { TextArea } from "../../components/ui/Field";
import { Panel } from "../../components/ui/Panel";

interface MarkNoteProps {
  path: string;
  mark: Mark;
  /** The open file's stamp, to tell whether this mark predates it. */
  currentStamp: string;
  onClose: () => void;
}

/**
 * The card for one mark: what was marked, and what the reader wanted to say.
 *
 * Anchored to the bottom of the preview rather than to the mark itself. A
 * popover over the page would have to dodge the page edges and re-place itself
 * on every zoom, and it would cover the very words being annotated.
 */
export function MarkNote({ path, mark, currentStamp, onClose }: MarkNoteProps) {
  const { t } = useI18n();
  const [note, setNote] = useState(mark.note);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // A different mark selected while this card is open replaces its contents.
  useEffect(() => {
    setNote(mark.note);
  }, [mark.id, mark.note]);

  // Save on unmount too: closing the card, selecting another mark or turning
  // the page must not silently discard what was typed.
  const latest = useRef(note);
  latest.current = note;
  useEffect(() => {
    const id = mark.id;
    return () => {
      setMarkNote(path, id, latest.current);
    };
  }, [path, mark.id]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [mark.id]);

  return (
    <Panel tone="elevated" className="mark-note" role="dialog" aria-label={t("marks.noteDialog")}>
      <div className="mark-note-head">
        <span className="mark-note-page">{t("marks.onPage", { page: mark.page })}</span>
        <Button
          variant="ghost"
          size="sm"
          icon
          className="mark-note-close"
          onClick={onClose}
          aria-label={t("common.close")}
        >
          ×
        </Button>
      </div>
      {mark.text && <blockquote className="mark-note-quote">{mark.text}</blockquote>}
      {currentStamp && mark.stamp && mark.stamp !== currentStamp && (
        // The file changed under the mark. The rectangle may now cover the
        // wrong words, so say so rather than let the quote above be read as
        // what is currently there.
        <p className="mark-note-stale">{t("marks.staleMark")}</p>
      )}
      <TextArea
        ref={textareaRef}
        className="mark-note-input"
        value={note}
        maxLength={MAX_NOTE_TEXT}
        placeholder={t("marks.notePlaceholder")}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      />
      <div className="mark-note-actions">
        <Button
          variant="ghost"
          size="sm"
          className="mark-note-delete"
          onClick={() => {
            // The unmount save that follows finds no mark with this id and
            // does nothing, so deleting does not resurrect it.
            removeMark(path, mark.id);
            onClose();
          }}
        >
          {t("marks.delete")}
        </Button>
      </div>
    </Panel>
  );
}
