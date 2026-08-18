import { memo, useMemo, useState } from "react";
import { Sparkles, Undo2, User } from "lucide-react";
import { useI18n } from "../i18n";
import {
  getFindings,
  isSuperseded,
  setFindingStruck,
  type Finding,
} from "../lib/finding-store";
import { Button } from "./ui/Button";
import { Input } from "./ui/Field";

interface RecordPanelProps {
  path: string;
  /** Changes when this document's record does, so the list re-reads it. */
  revision: number;
  currentPage: number;
  /** Some entries were written against a different version of this file. */
  stale: boolean;
  onJumpToPage: (page: number) => void;
}

/**
 * What is known about this document, at a width that can hold it.
 *
 * 9.0 put this in the page sidebar, next to marks. That column is 160px and
 * sized for a thumbnail of a page; a finding is prose, and its claims wrapped
 * to four or five lines there. It cannot be widened at a 900px window without
 * pushing the preview toolbar back into the overlap 8.1.6 fixed.
 *
 * So the record lives here instead, in the assistant column — 360px at its
 * narrowest, 480 at its widest. That is what "the primary surface, with the
 * transcript one tab away" meant in the 9.0 design; putting it in the sidebar
 * was the mistake, and this corrects it. Marks stay where the reader made
 * them, and the page sidebar goes back to being about the page.
 *
 * NO MARGIN RENDERING. The 9.0 design promised findings drawn beside the text
 * they came from. They cannot be: a finding is anchored to page numbers, not
 * to a rectangle, because the assistant reads page text and has no
 * coordinates. Filtering to the current page is the honest version of that
 * idea — turn to page 12 and see what is known about page 12.
 */
export const RecordPanel = memo(function RecordPanel({
  path,
  revision,
  currentPage,
  stale,
  onJumpToPage,
}: RecordPanelProps) {
  const { t } = useI18n();
  const [filter, setFilter] = useState("");
  const [thisPageOnly, setThisPageOnly] = useState(false);

  const { rows, total } = useMemo(() => {
    void revision;
    const all = getFindings(path);
    let shown = all;
    if (thisPageOnly) shown = shown.filter((f) => f.pages.includes(currentPage));
    const needle = filter.trim().normalize("NFC").toLowerCase();
    if (needle) {
      shown = shown.filter((f) =>
        `${f.claim}\n${f.evidence}\n${f.why ?? ""}`.normalize("NFC").toLowerCase().includes(needle),
      );
    }
    return { rows: shown, total: all.length };
  }, [path, revision, filter, thisPageOnly, currentPage]);

  const all = useMemo(() => {
    void revision;
    return getFindings(path);
  }, [path, revision]);

  if (total === 0) {
    return (
      <div className="record-panel record-empty">
        <p>{t("record.empty")}</p>
        <p className="record-empty-hint">{t("record.emptyHint")}</p>
      </div>
    );
  }

  return (
    <div className="record-panel">
      <div className="record-controls">
        <Input
          type="search"
          size="sm"
          className="record-filter"
          value={filter}
          placeholder={t("record.filterPlaceholder")}
          aria-label={t("record.filterPlaceholder")}
          onChange={(e) => setFilter(e.target.value)}
        />
        <Button
          variant={thisPageOnly ? "secondary" : "ghost"}
          size="sm"
          className="record-page-toggle"
          aria-pressed={thisPageOnly}
          onClick={() => setThisPageOnly((v) => !v)}
        >
          {t("record.thisPage", { page: currentPage })}
        </Button>
      </div>
      {stale && <p className="mark-stale-note">{t("record.staleFile")}</p>}
      {rows.length === 0 ? (
        <p className="record-none">{t("record.noMatch")}</p>
      ) : (
        <ul className="record-list">
          {rows.map((finding) => (
            <RecordEntry
              key={finding.id}
              path={path}
              finding={finding}
              superseded={isSuperseded(all, finding.id)}
              currentPage={currentPage}
              onJumpToPage={onJumpToPage}
            />
          ))}
        </ul>
      )}
    </div>
  );
});

/**
 * One entry, and the pages it came from.
 *
 * The pages are controls, not decoration: a claim the reader cannot trace back
 * to the text is the failure this record has to avoid, and the assistant is
 * told these again on the next question.
 */
function RecordEntry({
  path,
  finding,
  superseded,
  currentPage,
  onJumpToPage,
}: {
  path: string;
  finding: Finding;
  superseded: boolean;
  currentPage: number;
  onJumpToPage: (page: number) => void;
}) {
  const { t } = useI18n();
  const struck = Boolean(finding.struck);
  const byReader = finding.author === "reader";
  const inactive = struck || superseded;

  return (
    <li className={`record-entry ${inactive ? "record-entry-inactive" : ""}`}>
      <div className="record-entry-head">
        <span className={`record-byline ${byReader ? "record-byline-reader" : ""}`}>
          {byReader ? <User size={11} aria-hidden /> : <Sparkles size={11} aria-hidden />}
          {byReader ? t("record.byReader") : t("record.byAssistant")}
        </span>
        {inactive && (
          <span className="record-state">
            {struck ? t("marks.struck") : t("marks.replaced")}
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          icon
          className="record-strike"
          title={struck ? t("marks.unstrike") : t("marks.strike")}
          aria-label={struck ? t("marks.unstrike") : t("marks.strike")}
          onClick={() => setFindingStruck(path, finding.id, !struck)}
        >
          <Undo2 size={13} />
        </Button>
      </div>
      <p className="record-claim">{finding.claim}</p>
      {finding.why && <p className="record-why">{finding.why}</p>}
      <div className="record-pages">
        {finding.pages.map((page) => (
          /* raw-button: an inline page chip in a row of them; a control's padding would break the line */
          <button
            key={page}
            type="button"
            className={`record-page-chip ${page === currentPage ? "here" : ""}`}
            title={t("preview.pageTitle", { page })}
            onClick={() => onJumpToPage(page)}
          >
            {page}
          </button>
        ))}
      </div>
    </li>
  );
}
