import { ChevronLeft } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import { useI18n } from "../i18n";
import { activeHeadingIndex } from "../lib/outline-nav";
import type { DocHeading } from "../lib/types";
import { Button } from "./ui/Button";

interface OutlineSidebarProps {
  outline: DocHeading[];
  currentPage: number;
  /** Rendered in the header so the two sidebars switch in place. */
  tabs: React.ReactNode;
  onClose: () => void;
  onPageSelect: (page: number) => void;
}

/**
 * Chapter navigation.
 *
 * Most PDFs carry no bookmarks — a 117-page textbook in the test fixtures
 * carries none — so for those this list is the only structure the document has.
 * It is recovered from the page text when the document is opened; nothing here
 * re-reads the file.
 */
export const OutlineSidebar = memo(function OutlineSidebar({
  outline,
  currentPage,
  tabs,
  onClose,
  onPageSelect,
}: OutlineSidebarProps) {
  const { t } = useI18n();
  const activeRef = useRef<HTMLButtonElement>(null);
  const active = activeHeadingIndex(outline, currentPage);

  // Follow the reader: paging through the document should move the highlight
  // into view rather than leave it scrolled off.
  useEffect(() => {
    const el = activeRef.current;
    const list = el?.closest(".outline-list");
    if (!el || !list) return;
    const elRect = el.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    if (elRect.top < listRect.top || elRect.bottom > listRect.bottom) {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [active]);

  return (
    <aside className="thumb-sidebar outline-sidebar" aria-label={t("preview.outline")}>
      <div className="thumb-sidebar-header">
        {tabs}
        <Button variant="ghost" size="md"
         
          className="toolbar-btn"
          onClick={onClose}
          title={t("preview.thumbnailsHide")}
          aria-label={t("preview.thumbnailsHide")}
        >
          <ChevronLeft size={14} />
        </Button>
      </div>
      <nav className="outline-list">
        {outline.map((heading, i) => (
          // raw-button: a list row indented by heading level, with its own active state
          <button
            key={`${heading.page}-${i}-${heading.title}`}
            ref={i === active ? activeRef : undefined}
            type="button"
            className={`outline-item level-${heading.level} ${i === active ? "active" : ""}`}
            aria-current={i === active ? "true" : undefined}
            title={`${heading.title} · ${t("preview.pageHit", { page: heading.page })}`}
            onClick={() => onPageSelect(heading.page)}
          >
            <span className="outline-title">{heading.title}</span>
            <span className="outline-page">{heading.page}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
});
