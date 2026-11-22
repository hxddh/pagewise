import { memo, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "../i18n";
import { activeHeadingIndex } from "../lib/outline-nav";
import { labelForPage } from "../lib/page-labels";
import type { DocHeading } from "../lib/types";
import { ListRow } from "./ui/ListRow";

const MAX_OUTLINE_DEPTH = 5;
const VIRTUALIZE_THRESHOLD = 80;
const OUTLINE_ROW_PITCH = 30;
const OUTLINE_OVERSCAN = 12;

interface OutlineSidebarProps {
  outline: DocHeading[];
  currentPage: number;
  pageLabels?: string[];
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
  pageLabels,
  tabs,
  onPageSelect,
}: OutlineSidebarProps) {
  const { t } = useI18n();
  const listRef = useRef<HTMLElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const active = activeHeadingIndex(outline, currentPage);
  const virtualized = outline.length > VIRTUALIZE_THRESHOLD;
  const [windowRange, setWindowRange] = useState({
    start: 0,
    end: Math.min(outline.length, 40),
  });

  const updateWindow = useCallback(() => {
    if (!virtualized) return;
    const el = listRef.current;
    if (!el) return;
    const height = el.clientHeight || 600;
    const visible = Math.ceil(height / OUTLINE_ROW_PITCH) + OUTLINE_OVERSCAN * 2;
    const rawStart = Math.floor(el.scrollTop / OUTLINE_ROW_PITCH) - OUTLINE_OVERSCAN;
    const start = Math.min(
      Math.max(0, rawStart),
      Math.max(0, outline.length - visible),
    );
    const end = Math.min(outline.length, start + visible);
    setWindowRange((prev) =>
      prev.start === start && prev.end === end ? prev : { start, end },
    );
  }, [virtualized, outline.length]);

  useEffect(() => {
    if (!virtualized) return;
    updateWindow();
  }, [virtualized, outline.length, updateWindow]);

  // Follow the reader: paging through the document should move the highlight
  // into view rather than leave it scrolled off.
  useEffect(() => {
    if (virtualized && active >= 0 && listRef.current) {
      const list = listRef.current;
      const rowTop = active * OUTLINE_ROW_PITCH;
      const rowBottom = rowTop + OUTLINE_ROW_PITCH;
      if (rowTop < list.scrollTop || rowBottom > list.scrollTop + list.clientHeight) {
        list.scrollTop = Math.max(0, rowTop - list.clientHeight / 2);
        updateWindow();
      }
      return;
    }
    const el = activeRef.current;
    const list = el?.closest(".outline-list");
    if (!el || !list) return;
    const elRect = el.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    if (elRect.top < listRect.top || elRect.bottom > listRect.bottom) {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [active, virtualized, updateWindow]);

  const start = virtualized ? windowRange.start : 0;
  const end = virtualized ? windowRange.end : outline.length;
  const topPad = virtualized ? start * OUTLINE_ROW_PITCH : 0;
  const bottomPad = virtualized ? Math.max(0, (outline.length - end) * OUTLINE_ROW_PITCH) : 0;

  return (
    <aside className="thumb-sidebar outline-sidebar" aria-label={t("preview.outline")}>
      <div className="thumb-sidebar-header">
        {tabs}
      </div>
      <nav
        ref={listRef}
        className="outline-list"
        onScroll={virtualized ? updateWindow : undefined}
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          const nav = listRef.current;
          if (!nav) return;
          const buttons = Array.from(nav.querySelectorAll<HTMLButtonElement>("button.outline-item"));
          if (buttons.length === 0) return;
          e.preventDefault();
          const cur = document.activeElement instanceof HTMLButtonElement ? buttons.indexOf(document.activeElement) : -1;
          const delta = e.key === "ArrowDown" ? 1 : -1;
          const next = cur < 0 ? 0 : (cur + delta + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }}
      >
        {topPad > 0 && <div style={{ height: topPad, flexShrink: 0 }} aria-hidden />}
        {outline.slice(start, end).map((heading, offset) => {
          const i = start + offset;
          const printed = labelForPage(pageLabels ?? null, heading.page);
          const pageDisplay = printed ?? String(heading.page);
          return (
            <ListRow
              key={`${heading.page}-${i}-${heading.title}`}
              ref={i === active ? activeRef : undefined}
              className={`outline-item level-${heading.level}`}
              active={i === active}
              style={
                {
                  "--outline-depth": Math.min(Math.max(heading.level, 1), MAX_OUTLINE_DEPTH) - 1,
                } as CSSProperties
              }
              title={`${heading.title} · ${t("preview.pageHit", { page: printed ? `${printed} (${heading.page})` : heading.page })}`}
              onClick={() => onPageSelect(heading.page)}
              label={<span className="outline-title">{heading.title}</span>}
              trailing={<span className="outline-page">{pageDisplay}</span>}
            />
          );
        })}
        {bottomPad > 0 && <div style={{ height: bottomPad, flexShrink: 0 }} aria-hidden />}
      </nav>
    </aside>
  );
});
