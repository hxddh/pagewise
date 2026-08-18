import { MessageSquareQuote } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { useI18n } from "../i18n";
import { getMarks, type Mark } from "../lib/mark-store";
import { Button } from "./ui/Button";
import { Input } from "./ui/Field";

interface MarkSidebarProps {
  path: string;
  /** Changes when this document's marks do, so the list re-reads them. */
  revision: number;
  currentPage: number;
  selectedId: string | null;
  /** Some marks were made against a different version of this file. */
  stale: boolean;
  /** Rendered in the header so the sidebars switch in place. */
  tabs: React.ReactNode;
  onSelect: (page: number, id: string) => void;
  /** Put this mark into the composer. Absent when there is nothing to ask. */
  onAsk?: (mark: Mark) => void;
}

/**
 * Everything the reader marked, in page order.
 *
 * Without this a mark in a 300-page document is only findable by remembering
 * where it was, which is the thing marking it was supposed to solve.
 *
 * 9.0 also put the assistant's findings here, and 9.2 took them out again. A
 * finding is prose and this column is 160px, sized for a thumbnail of a page —
 * claims wrapped to four or five lines, and the column cannot be widened at a
 * 900px window without undoing 8.1.6. The record moved to the assistant
 * column, which is 360px at its narrowest. What stays here is what the reader
 * put on the page, which is what this sidebar was always for.
 */
export const MarkSidebar = memo(function MarkSidebar({
  path,
  revision,
  currentPage,
  selectedId,
  stale,
  tabs,
  onSelect,
  onAsk,
}: MarkSidebarProps) {
  const { t } = useI18n();
  const [filter, setFilter] = useState("");
  // `revision` is the subscription; the record itself is read synchronously.
  const entries = useMemo(() => {
    void revision;
    const all = getMarks(path);
    // Notes are the reader's own words and are in no search index — ⌘F covers
    // the document, deliberately not this. Once there are fifty marks, "where
    // did I write that" needs an answer somewhere.
    const needle = filter.trim().normalize("NFC").toLowerCase();
    if (!needle) return all;
    return all.filter((m) =>
      `${m.text}\n${m.note}`.normalize("NFC").toLowerCase().includes(needle),
    );
  }, [path, revision, filter]);

  return (
    <aside className="thumb-sidebar outline-sidebar" aria-label={t("preview.marks")}>
      <div className="thumb-sidebar-header">
        {tabs}
      </div>
      {stale && <p className="mark-stale-note">{t("marks.staleFile")}</p>}
      {(entries.length > 0 || filter) && (
        <Input
          type="search"
          size="sm"
          className="mark-filter"
          value={filter}
          placeholder={t("marks.filterPlaceholder")}
          aria-label={t("marks.filterPlaceholder")}
          onChange={(e) => setFilter(e.target.value)}
        />
      )}
      {entries.length === 0 ? (
        <p className="outline-empty">{filter ? t("marks.noFilterMatch") : t("marks.empty")}</p>
      ) : (
        <nav className="outline-list">
          {entries.map((mark) => (
            <MarkRow
              key={mark.id}
              mark={mark}
              selectedId={selectedId}
              currentPage={currentPage}
              onSelect={onSelect}
              onAsk={onAsk}
            />
          ))}
        </nav>
      )}
    </aside>
  );
});

/**
 * One passage the reader marked.
 *
 * A row rather than a bare button: marking a passage and then asking about it
 * is the reason to mark it, and before this the only way was to find the page,
 * find the passage and select it again.
 */
function MarkRow({
  mark,
  selectedId,
  currentPage,
  onSelect,
  onAsk,
}: {
  mark: Mark;
  selectedId: string | null;
  currentPage: number;
  onSelect: (page: number, id: string) => void;
  onAsk?: (mark: Mark) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="mark-row">
      {/* raw-button: a list row carrying page, quote and note; Button would flatten it */}
      <button
        type="button"
        className={`outline-item mark-item ${
          mark.id === selectedId ? "active" : mark.page === currentPage ? "mark-item-here" : ""
        }`}
        aria-current={mark.id === selectedId ? "true" : undefined}
        title={mark.note || mark.text}
        onClick={() => onSelect(mark.page, mark.id)}
      >
        <span className="outline-title">
          <span className="mark-item-text">{mark.text || t("marks.noText")}</span>
          {mark.note && <span className="mark-item-note">{mark.note}</span>}
        </span>
        <span className="outline-page">{mark.page}</span>
      </button>
      {onAsk && (
        <Button
          variant="ghost"
          size="sm"
          icon
          className="mark-ask-btn"
          title={t("marks.ask")}
          aria-label={t("marks.ask")}
          onClick={() => onAsk(mark)}
        >
          <MessageSquareQuote size={13} />
        </Button>
      )}
    </div>
  );
}
