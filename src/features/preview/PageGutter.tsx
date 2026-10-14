import { memo, useMemo } from "react";
import { useI18n } from "../../i18n";
import type { PageCitation } from "../../lib/page-citations";
import { gutterEntries, type GutterEntry } from "./page-gutter";

/**
 * Where a page sits, as the scroller laid it out.
 *
 * Handed over rather than recomputed: `page-layout.ts` decides where a page is
 * and `PageScroller` is the only thing that knows how the column centres it, so
 * the margin reads those numbers instead of inventing a second coordinate
 * system beside them.
 */
export interface PageMarginBox {
  /** Scrolltop of the page's top edge. */
  top: number;
  /** CSS length for the page's outer (right) edge within the column. */
  left: string;
  /** Rendered height of the page; the strip never runs past it. */
  height: number;
}

interface PageGutterProps {
  path: string;
  /** 1-based. */
  page: number;
  box: PageMarginBox;
  /** Bumped when this document's marks or findings change. */
  revision: number;
  /** Answers citing each page, from the conversation. */
  citations?: Map<number, PageCitation[]> | null;
  /** The reader picked a mark: jump to it and open its note. */
  onSelectMark?: (page: number, id: string) => void;
  /** The reader picked a finding: show it on its page. */
  onSelectFinding?: (id: string, page: number) => void;
  /** The reader picked an answer: bring the turn in front of them. */
  onRevealMessage?: (messageId: string) => void;
}

/**
 * The page's outer margin: a small dot per mark, finding and citing answer.
 *
 * A mark used to be reachable only from the sidebar tab, which meant the page
 * itself could not tell the reader it had been marked. The margin is where
 * marginalia has always lived, and it costs the page nothing: the strip is
 * absolutely positioned beside the page box, so the page's own geometry — and
 * everything `page-layout.ts` computed from it — is untouched.
 *
 * The note on hover is the `title` attribute, deliberately. A styled tooltip
 * would have to draw outside the strip, and the strip lives inside the
 * scroller, whose `overflow: auto` would clip it at the page edge. The native
 * tooltip is drawn by the platform, outside the layout, and is what the mark
 * and finding layers already use for exactly this.
 */
export const PageGutter = memo(function PageGutter({
  path,
  page,
  box,
  revision,
  citations,
  onSelectMark,
  onSelectFinding,
  onRevealMessage,
}: PageGutterProps) {
  const { t } = useI18n();
  const entries = useMemo(
    // `revision` is the subscription; the stores themselves are read
    // synchronously, as the layers do.
    () => (void revision, gutterEntries(path, page, citations)),
    [path, page, revision, citations],
  );

  if (entries.length === 0) return null;

  const note = (entry: GutterEntry): string => {
    switch (entry.kind) {
      case "mark":
        return entry.note;
      case "finding":
        return entry.note;
      case "answer":
        return entry.note || t("gutter.answerCites", { page: entry.page });
    }
  };

  const label = (entry: GutterEntry): string => {
    switch (entry.kind) {
      case "mark":
        return entry.fromNote
          ? t("marks.markWithNote", { note: entry.note })
          : t("marks.markPlain", { text: entry.note.slice(0, 80) });
      case "finding":
        return t("record.onPage", { claim: entry.note });
      case "answer":
        return t("gutter.answerCites", { page: entry.page });
    }
  };

  const activate = (entry: GutterEntry) => {
    if (entry.kind === "mark") onSelectMark?.(entry.page, entry.id);
    else if (entry.kind === "finding") onSelectFinding?.(entry.id, entry.page);
    else onRevealMessage?.(entry.id);
  };

  return (
    <div
      className="page-gutter"
      role="group"
      aria-label={t("gutter.label")}
      data-page={page}
      style={{ top: box.top, left: box.left, maxHeight: box.height }}
    >
      {entries.map((entry) => (
        // raw-button: an 8px dot in the page margin — it has no box the shared
        // button styles could give it, and the group above is its label.
        <button
          key={`${entry.kind}-${entry.id}`}
          type="button"
          className={`gutter-dot gutter-dot-${entry.kind}`}
          data-gutter-kind={entry.kind}
          title={note(entry)}
          aria-label={label(entry)}
          onClick={() => activate(entry)}
        />
      ))}
    </div>
  );
});
