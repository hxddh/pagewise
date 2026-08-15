import { memo, useEffect, useRef, type CSSProperties } from "react";
import { useI18n } from "../i18n";
import { activeHeadingIndex } from "../lib/outline-nav";
import type { DocHeading } from "../lib/types";

/**
 * How far a heading may be indented, in levels.
 *
 * The sidebar gives a row about 143px; each level past the first costs 12 of
 * it, and the title ellipsizes into whatever is left. Level 5 takes 56px of
 * padding and leaves about 87px of title — the point past which the indent
 * stops telling the reader more than the truncation costs them.
 */
const MAX_OUTLINE_DEPTH = 5;

interface OutlineSidebarProps {
  outline: DocHeading[];
  currentPage: number;
  /** Rendered in the header so the two sidebars switch in place. */
  tabs: React.ReactNode;
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
            /*
             * The indent has to come from the level itself. The stylesheet used
             * to carry one rule, `.level-2`, so every heading at level 3 or
             * deeper fell back to level 1's padding and sat at exactly the same
             * x as a top-level section — measured 64px for levels 1, 3, 4 and 5
             * alike. A three-level document's outline read as flat, which is
             * the one thing an outline is for.
             *
             * Capped at MAX_OUTLINE_DEPTH: PDF outlines nest as deep as their
             * author liked, and an uncapped indent would push the title out of
             * a 160px sidebar entirely.
             */
            style={
              {
                "--outline-depth": Math.min(Math.max(heading.level, 1), MAX_OUTLINE_DEPTH) - 1,
              } as CSSProperties
            }
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
