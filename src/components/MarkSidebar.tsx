import { ChevronLeft } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { useI18n } from "../i18n";
import { getMarks } from "../lib/mark-store";

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
  onClose: () => void;
  onSelect: (page: number, id: string) => void;
}

/**
 * Everything the reader marked, in page order.
 *
 * Without this a mark in a 300-page document is only findable by remembering
 * where it was, which is the thing marking it was supposed to solve.
 */
export const MarkSidebar = memo(function MarkSidebar({
  path,
  revision,
  currentPage,
  selectedId,
  stale,
  tabs,
  onClose,
  onSelect,
}: MarkSidebarProps) {
  const { t } = useI18n();
  const [filter, setFilter] = useState("");
  // `revision` is the subscription; the marks themselves are read synchronously.
  const marks = useMemo(() => {
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
        <button
          type="button"
          className="toolbar-btn"
          onClick={onClose}
          title={t("preview.thumbnailsHide")}
          aria-label={t("preview.thumbnailsHide")}
        >
          <ChevronLeft size={14} />
        </button>
      </div>
      {stale && <p className="mark-stale-note">{t("marks.staleFile")}</p>}
      {(marks.length > 0 || filter) && (
        <input
          type="search"
          className="mark-filter"
          value={filter}
          placeholder={t("marks.filterPlaceholder")}
          aria-label={t("marks.filterPlaceholder")}
          onChange={(e) => setFilter(e.target.value)}
        />
      )}
      {marks.length === 0 ? (
        <p className="outline-empty">{filter ? t("marks.noFilterMatch") : t("marks.empty")}</p>
      ) : (
        <nav className="outline-list">
          {marks.map((mark) => (
            <button
              key={mark.id}
              type="button"
              className={`outline-item mark-item ${
                mark.id === selectedId
                  ? "active"
                  : mark.page === currentPage
                    ? "mark-item-here"
                    : ""
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
          ))}
        </nav>
      )}
    </aside>
  );
});
