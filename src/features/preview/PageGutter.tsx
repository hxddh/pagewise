import { Fragment, memo, useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import type { AnswerNote, PageCitation } from "../../lib/page-citations";
import { columnEntries, columnTops, cardExcerpt, gutterEntries, type GutterEntry } from "./page-gutter";
import { getMarks } from "../../lib/mark-store";
import { getFindings } from "../../lib/finding-store";
import { placeFinding } from "../../lib/finding-anchors";
import { cachedCitationCheck, checkCitation } from "../../lib/citation-check";
import { getPageGeometry, type PageGeometry } from "../../lib/pdf";
import { citationLabel } from "../../lib/remark-citations";
import { TRUST_TEXT, longKey, stateKey, type TrustReason } from "../../lib/trust-text";
import { pdfRectToBox, topLeftRectToBox } from "./search-highlight";

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
  /** The margin the column reserves: how wide the strip is. */
  width: number;
}

interface PageGutterProps {
  path: string;
  /** 1-based. */
  page: number;
  box: PageMarginBox;
  /** Bumped when this document's marks or findings change. */
  revision: number;
  /**
   * True while the panel is closed and the margin is the column (20.0): the
   * entries carry their words instead of being dots.
   */
  column: boolean;
  /** Answers citing each page, from the conversation — the dots' list. */
  citations?: Map<number, PageCitation[]> | null;
  /** Answers' sentences citing each page, with their states — the column's. */
  notes?: Map<number, AnswerNote[]> | null;
  /** For checking an answer's marker the panel has not mounted a chip for. */
  totalPages: number;
  /** The reader picked a mark: jump to it and open its note. */
  onSelectMark?: (page: number, id: string) => void;
  /** The reader picked a finding: show it on its page. */
  onSelectFinding?: (id: string, page: number) => void;
  /** The reader picked an answer: bring the turn in front of them. */
  onRevealMessage?: (messageId: string) => void;
}

/**
 * Where one entry's passage is, as a fraction of the page's height.
 *
 * Each kind resolves its own anchor: a mark carries the rectangles it was made
 * with; a finding's words are looked up in the page's own runs by
 * `placeFinding`; an answer's are the rectangles the citation's check found.
 * Undefined when there is nothing to anchor to — a quote that was not found, a
 * check still running — and the column then starts the entry at the top of the
 * page.
 */
async function anchorFor(
  path: string,
  page: number,
  entry: GutterEntry,
  geometry: PageGeometry,
  totalPages: number,
): Promise<number | undefined> {
  if (entry.kind === "mark") {
    // Marks are stored measured from the page's top edge — the convention
    // `topLeftRectToBox` exists for (9.2.3).
    const mark = getMarks(path).find((m) => m.id === entry.id);
    const rect = mark?.rects[0];
    return rect ? topLeftRectToBox(rect, geometry).top : undefined;
  }
  if (entry.kind === "finding") {
    const finding = getFindings(path).find((f) => f.id === entry.id);
    if (!finding) return undefined;
    const placement = await placeFinding(path, finding);
    if (placement.status !== "located" && placement.status !== "mismatch") return undefined;
    if (placement.anchor.page !== page) return undefined;
    return pdfRectToBox(placement.anchor.bounds, geometry).top;
  }
  // An answer: the words of the marker that names this page. The check is
  // read from the cache the chips fill; a document whose panel has never been
  // opened has no chips, so the check is run here.
  for (const citation of entry.citations ?? []) {
    if (!citation.pages.includes(page)) continue;
    const check = cachedCitationCheck(path, citation) ?? (await checkCitation(path, totalPages, citation));
    if (check.status === "located" && check.page === page && check.rects?.length) {
      return pdfRectToBox(check.rects[0]!, geometry).top;
    }
  }
  return undefined;
}

/**
 * Where each column entry sits, and where its passage is.
 *
 * `tops` is where the card is drawn; `anchors` is the passage's own place on
 * the page, for the entries that have one. The collision rule may push a card
 * below its passage; the two together are what the card's tie is drawn from
 * (the card is drawn at its passage when they are equal, and needs no tie).
 */
interface ColumnPlacement {
  tops: number[];
  anchors: Array<number | undefined>;
}

/**
 * How far the collision rule may push a card before it draws a tie to its
 * passage, as a fraction of the page's height (20.0).
 *
 * `columnTops` keeps cards from overlapping (`COLUMN_MIN_STEP`); a card the
 * push moved is no longer beside its passage, and the tie is what says where
 * it came from. Below this the card's top edge is close enough to the passage
 * that a hairline would be a smudge on its own border — the push's own step is
 * `COLUMN_MIN_STEP`, so any real displacement draws the tie.
 */
const COLUMN_TIE_MIN = 0.005;

/**
 * How many lanes the margin's ties may use (20.0): the free margin left of the
 * cards (`--tie-gutter`, 14px — see `preview.css`) holds three 2px lanes 4px
 * apart. A page with more pushed cards than lanes reuses the outermost — at
 * that density the margin is past what it is for, and the panel is the page's
 * record. The lanes are the stylesheet's; this is only how many there are.
 */
const MAX_TIE_LANES = 3;

/**
 * The page's outer margin: a dot per mark, finding and citing answer while the
 * panel is open, and the column (20.0) while it is closed.
 *
 * A mark used to be reachable only from the sidebar tab, which meant the page
 * itself could not tell the reader it had been marked. The margin is where
 * marginalia has always lived, and it costs the page nothing: the strip is
 * absolutely positioned beside the page box, so the page's own geometry — and
 * everything `page-layout.ts` computed from it — is untouched.
 *
 * The column's entries sit beside the passage each one is about, as a fraction
 * of the page's height (`columnTops`), and carry the words: a short answer's
 * sentence with the state of its evidence, so the reader does not have to open
 * the panel for the common case. Where two passages are close enough that the
 * collision rule pushes a card down, the card draws a tie — a line from the
 * passage's own place on the page to the card, in the card's own ink, with a
 * tick across the margin and a cap at the page's edge at the passage end, and
 * an elbow into the card's corner — so a card is never merely far from the
 * passage it is about. The page's ties take separate lanes (the margin's free
 * left edge), ranked by the passage each comes from, so each tie reaches its
 * own passage without crossing another or running under a card, and two ties
 * in different lanes sit far enough apart to read as two objects. The note on
 * hover is the `title`
 * attribute, deliberately — a styled tooltip would have to draw outside the
 * strip, and the strip lives inside the scroller, whose `overflow: auto` would
 * clip it at the page edge. The native tooltip is drawn by the platform,
 * outside the layout, and is what the mark and finding layers already use for
 * exactly this.
 */
export const PageGutter = memo(function PageGutter({
  path,
  page,
  box,
  revision,
  column,
  citations,
  notes,
  totalPages,
  onSelectMark,
  onSelectFinding,
  onRevealMessage,
}: PageGutterProps) {
  const { t } = useI18n();
  const entries = useMemo(
    // `revision` is the subscription; the stores themselves are read
    // synchronously, as the layers do.
    () =>
      column
        ? columnEntries(path, page, notes)
        : gutterEntries(path, page, citations),
    [column, path, page, revision, citations, notes],
  );

  // Where each entry sits in the column, as page fractions — and where its
  // passage is, for the tie. Resolved here because it needs the page's
  // geometry: one call per mounted page, the same one the mark and finding
  // layers make.
  const [placement, setPlacement] = useState<ColumnPlacement>({ tops: [], anchors: [] });
  useEffect(() => {
    if (!column || entries.length === 0) {
      setPlacement({ tops: [], anchors: [] });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const geometry = await getPageGeometry(path, page);
        const anchors: Array<number | undefined> = [];
        for (const entry of entries) {
          anchors.push(await anchorFor(path, page, entry, geometry, totalPages));
          if (cancelled) return;
        }
        if (!cancelled) setPlacement({ tops: columnTops(anchors), anchors });
      } catch {
        // The page reads fine without its margin.
        if (!cancelled) setPlacement({ tops: [], anchors: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [column, path, page, totalPages, entries]);

  // The lane each tie runs in, keyed by entry index: the page's ties ranked by
  // the passage they come from — the topmost takes the lane nearest the cards,
  // each later one steps left (`preview.css`). Two ties from one passage keep
  // the DOM's order. A page with more ties than lanes reuses the outermost
  // (`MAX_TIE_LANES`); the tie itself is still the caller's rule below.
  const tieLanes = useMemo(() => {
    const lanes = new Map<number, number>();
    placement.tops
      .map((top, i) => ({ top, anchor: placement.anchors[i], i }))
      .filter((tie): tie is { top: number; anchor: number; i: number } =>
        tie.anchor !== undefined && tie.top - tie.anchor > COLUMN_TIE_MIN,
      )
      .sort((a, b) => a.anchor - b.anchor || a.i - b.i)
      .forEach((tie, rank) => lanes.set(tie.i, Math.min(rank, MAX_TIE_LANES - 1)));
    return lanes;
  }, [placement]);

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

  if (!column) {
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
  }

  return (
    <div
      className="page-gutter page-gutter-column"
      role="group"
      aria-label={t("gutter.label")}
      data-page={page}
      style={{ top: box.top, left: box.left, width: box.width, height: box.height }}
    >
      {entries.map((entry, i) => {
        const reason = entry.reason as TrustReason | undefined;
        const level = reason ? TRUST_TEXT[reason].level : "none";
        const pages = (entry.citations ?? [])
          .map((c) => citationLabel(c.pages))
          .join(", ");
        // The card's title: the sentence in full (the card itself may clip it)
        // and what its evidence turned out to be, in the one table of those
        // words (`trust-text.ts`) — the same sentence the chip's tooltip shows.
        const title = reason
          ? `${entry.text}\n${t(longKey(reason), {
              page: String(entry.page),
              pages: pages || String(entry.page),
              numbers: (entry.unstated ?? []).join("、"),
            })}`
          : note(entry);
        const top = placement.tops[i] ?? 0;
        const anchor = placement.anchors[i];
        // The collision rule may have pushed this card below its passage; the
        // tie is the line from the passage's own place on the page to the
        // card, drawn only when the card is no longer beside it. Its lane is
        // the rank of the passage among the page's ties (`tieLanes`).
        const tieFrom = anchor !== undefined && top - anchor > COLUMN_TIE_MIN ? anchor : null;
        const tieLane = tieLanes.get(i);
        // The card's own ink classes, shared by the card's border and its tie
        // (`preview.css`): the tie is drawn in the accent its card already
        // wears, so it says which card it belongs to.
        const ink = `gutter-note-${entry.kind}${reason ? ` gutter-note-${level}` : ""}`;
        return (
          <Fragment key={`${entry.kind}-${entry.id}-${i}`}>
            {tieFrom !== null && (
              <span
                className={`gutter-note-leader ${ink}`}
                aria-hidden
                data-tie-lane={tieLane ?? 0}
                style={{ top: `${tieFrom * 100}%`, height: `${(top - tieFrom) * 100}%` }}
              />
            )}
            {/* raw-button: a card in the page margin, not a control with a box
                of its own — the strip is its frame and the group above is its
                label. */}
            <button
              type="button"
              className={`gutter-note ${ink}`}
              data-gutter-kind={entry.kind}
              data-gutter-state={entry.state}
              style={{ top: `${top * 100}%` }}
              title={title}
              aria-label={entry.kind === "answer" ? title : label(entry)}
              onClick={() => activate(entry)}
            >
              <span className="gutter-note-text">{cardExcerpt(entry.text)}</span>
              {entry.state && (
                // The sentence's own word, from the one table of those words
                // (`trust-text.ts`): the same word the chip's headline and the
                // footer's tally use — never a check's internal status.
                <span className="gutter-note-state">{t(stateKey(entry.state, reason))}</span>
              )}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
});
