import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { renderThumbnail } from "../lib/pdf";

/**
 * The pitch of one thumbnail row: the button plus the gap below it.
 *
 * Every windowing calculation in this file measures with it — how many rows fit,
 * which row is first, how tall the spacer above the window is, where to scroll
 * so the current page is revealed — so it has to be the distance from one row's
 * top to the next one's, not the height of the button alone.
 *
 * It was 112, the button height, while the list also applied an 8px gap. So the
 * true pitch was 120 and every one of those calculations was off by 8px per
 * row, drifting further the longer the document. Splitting the constant in two
 * makes the arithmetic mean what it says.
 *
 * The button height itself is what a portrait page needs: a 612x792 page drawn
 * at the sidebar's ~134px content width is ~173px tall, and the row also holds
 * the page number and its padding. At 112 the contents needed 144 and overflowed
 * — with `overflow: visible` the page number landed on top of the next
 * thumbnail, so every page but the last had its number covered.
 *
 * A wider page than portrait shrinks to fit rather than growing the row; see
 * `.thumb-canvas`. A fixed pitch and a content-determined height cannot both
 * win, and the pitch is what the virtualization depends on.
 */
const THUMB_GAP = 8;
/*
 * How wide a thumbnail is drawn.
 *
 * It was 96, and `.thumb-canvas`'s `width: 100%` was never going to change that
 * — `renderThumbnail` sets the element's width and height inline, and an inline
 * style beats a stylesheet. Measured: computed width 96px inside a 146px card,
 * with 40px of `--bg-base` painted either side of every page in the list.
 *
 * 96 was right when the sidebar was 128 wide. It was widened to 160 so the
 * "Pages / Outline / Marks" strip would stop being cut to "Mar" — see
 * `.thumb-sidebar`, whose own comment says the thumbnails are "~100px and
 * unaffected". They were unaffected; they were also never revisited, and the
 * loose, half-empty look of that column is the whole of what was left behind.
 *
 * 160 sidebar − 12 list padding − 8 item padding − 2 border = 138, less 2 for
 * the scrollbar the list gets on any real document.
 */
const THUMB_IMAGE_WIDTH = 136;
/*
 * And the row that holds one, tall enough that a portrait page is not shrunk.
 *
 * A Letter page at 136px across is 176px tall; the label, the gap between them
 * and the button's own padding need about 29 more. Below that, `.thumb-canvas`
 * shrinks to fit — correctly, but on every single page, which is the letterbox
 * again by a different route.
 */
const THUMB_BUTTON_HEIGHT = 208;
const THUMB_ROW_HEIGHT = THUMB_BUTTON_HEIGHT + THUMB_GAP;
const OVERSCAN = 4;

interface ThumbnailSidebarProps {
  path: string;
  totalPages: number;
  currentPage: number;
  /** Replaces the header label so the sidebars can switch in place. */
  tabs?: React.ReactNode;
  onPageSelect: (page: number) => void;
}

const ThumbnailItem = memo(function ThumbnailItem({
  path,
  page,
  active,
  onSelect,
  pageLabel,
  visible,
}: {
  path: string;
  page: number;
  active: boolean;
  onSelect: () => void;
  pageLabel: string;
  visible: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!active) return;
    const el = rootRef.current;
    const container = el?.closest(".thumb-list");
    if (!el || !container) return;
    const elRect = el.getBoundingClientRect();
    const boxRect = container.getBoundingClientRect();
    const outOfView = elRect.top < boxRect.top || elRect.bottom > boxRect.bottom;
    if (outOfView) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);

  useEffect(() => {
    if (!visible || !canvasRef.current) return;
    let cancelled = false;
    renderThumbnail(path, page, canvasRef.current, THUMB_IMAGE_WIDTH, () => cancelled).catch(() => {
      if (!cancelled && canvasRef.current) {
        const ctx = canvasRef.current.getContext("2d");
        if (ctx) {
          const fill =
            getComputedStyle(document.documentElement)
              .getPropertyValue("--bg-hover")
              .trim() || "#1a1a1e";
          ctx.fillStyle = fill;
          ctx.fillRect(0, 0, canvasRef.current.width, canvasRef.current.height);
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [visible, path, page]);

  return (
    // raw-button: a page thumbnail: a canvas and a label, sized by the page it shows
    <button
      ref={rootRef}
      type="button"
      className={`thumb-item ${active ? "active" : ""}`}
      onClick={onSelect}
      title={pageLabel}
      aria-label={pageLabel}
      aria-current={active ? "page" : undefined}
      style={{ height: THUMB_BUTTON_HEIGHT }}
    >
      <canvas ref={canvasRef} className="thumb-canvas" />
      <span className="thumb-label">{page}</span>
    </button>
  );
});

export const ThumbnailSidebar = memo(function ThumbnailSidebar({
  path,
  totalPages,
  currentPage,
  tabs,
  onPageSelect,
}: ThumbnailSidebarProps) {
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ start: 1, end: Math.min(totalPages, 12) });

  const updateRange = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const visibleCount = Math.ceil(el.clientHeight / THUMB_ROW_HEIGHT) + OVERSCAN * 2;
    // Clamp start to totalPages too — a stale (large) scrollTop carried over from
    // a longer document would otherwise yield start > end and render no rows.
    const rawStart = Math.floor(el.scrollTop / THUMB_ROW_HEIGHT) + 1 - OVERSCAN;
    const start = Math.min(
      Math.max(1, rawStart),
      Math.max(1, totalPages - visibleCount + 1),
    );
    const end = Math.min(totalPages, start + visibleCount);
    setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, [totalPages]);

  useEffect(() => {
    updateRange();
  }, [totalPages, updateRange]);

  // On document switch the list's scrollTop and range survive (this is a single
  // persistent instance), so reset to the top and recompute for the new length.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = 0;
    setRange({ start: 1, end: Math.min(totalPages, 12) });
  }, [path, totalPages]);

  // The virtualized range is scroll-driven, so when the page changes externally
  // (nav, search jump, follow-agent) or the sidebar opens on a far page, the
  // active thumbnail can be outside the rendered window and never gets revealed.
  // Scroll it into view and recompute the range so it renders.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const rowTop = (currentPage - 1) * THUMB_ROW_HEIGHT;
    const rowBottom = rowTop + THUMB_ROW_HEIGHT;
    if (rowTop < el.scrollTop || rowBottom > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, rowTop - el.clientHeight / 2 + THUMB_ROW_HEIGHT / 2);
      updateRange();
    }
  }, [currentPage, updateRange]);

  const pages: number[] = [];
  for (let p = range.start; p <= range.end; p++) pages.push(p);

  return (
    <aside className="thumb-sidebar" aria-label={t("preview.pages")}>
      <div className="thumb-sidebar-header">
        {tabs ?? <span>{t("preview.pages")}</span>}
      </div>
      <div
        className="thumb-list"
        ref={listRef}
        onScroll={updateRange}
        style={{ position: "relative" }}
      >
        <div style={{ height: (range.start - 1) * THUMB_ROW_HEIGHT }} aria-hidden />
        {pages.map((page) => (
          <ThumbnailItem
            key={page}
            path={path}
            page={page}
            active={page === currentPage}
            onSelect={() => onPageSelect(page)}
            pageLabel={t("preview.pageTitle", { page })}
            visible
          />
        ))}
        <div
          style={{ height: Math.max(0, (totalPages - range.end) * THUMB_ROW_HEIGHT) }}
          aria-hidden
        />
      </div>
    </aside>
  );
});
