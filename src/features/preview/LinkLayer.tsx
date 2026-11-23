import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../i18n";
import { docCache } from "../../lib/doc-cache";
import { getPageGeometry, renderPageToJpegBytes } from "../../lib/pdf";
import { isSafeLink, parseInternalGotoPage } from "../../lib/safe-link";
import type { DocLink } from "../../lib/types";
import { pdfRectToBox, type HighlightBox } from "./search-highlight";

interface LinkLayerProps {
  path: string;
  page: number;
  /** Every link in the document; this layer draws the ones on `page`. */
  links: DocLink[];
  onActivate: (url: string) => void;
}

interface PlacedLink {
  url: string;
  targetPage: number | null;
  label: string;
  box: HighlightBox;
}

interface LinkPeekState {
  url: string;
  targetPage: number;
  heading: string | null;
  snippet: string;
  thumbUrl: string | null;
  left: number;
  top: number;
  above: boolean;
}

const PEEK_DELAY_MS = 240;
const PEEK_HIDE_GRACE_MS = 110;
const PEEK_THUMB_EDGE = 520;
const PEEK_THUMB_QUALITY = 0.78;
const MAX_PEEK_THUMBS = 8;

/** Small LRU of rendered target-page preview Blob URLs (`path|stamp|page`). */
const peekThumbCache = new Map<string, string>();

function getCachedPeekThumb(key: string): string | null {
  const hit = peekThumbCache.get(key);
  if (!hit) return null;
  peekThumbCache.delete(key);
  peekThumbCache.set(key, hit);
  return hit;
}

function storePeekThumb(key: string, blobUrl: string): void {
  const prev = peekThumbCache.get(key);
  if (prev && prev !== blobUrl) URL.revokeObjectURL(prev);
  peekThumbCache.delete(key);
  peekThumbCache.set(key, blobUrl);
  while (peekThumbCache.size > MAX_PEEK_THUMBS) {
    const oldest = peekThumbCache.keys().next().value;
    if (oldest === undefined) break;
    const url = peekThumbCache.get(oldest);
    peekThumbCache.delete(oldest);
    if (url) URL.revokeObjectURL(url);
  }
}

function summarizeTargetPage(path: string, targetPage: number): { heading: string | null; snippet: string } {
  const doc = docCache.get(path);
  if (!doc) return { heading: null, snippet: "" };
  const outlineHit = doc.outline?.find((b) => b.page === targetPage)?.title?.trim() || null;
  const raw = doc.pages[targetPage - 1]?.text ?? "";
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/^#+\s*/, "").replace(/\|/g, " ").replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0 && !/^[-:| ]+$/.test(l));
  const heading = outlineHit ?? (lines[0] && lines[0].length <= 90 ? lines[0] : null);
  const bodyLines = heading && lines[0] === heading ? lines.slice(1) : lines;
  const joined = bodyLines.join(" ").trim();
  const snippet = joined.length > 160 ? `${joined.slice(0, 159).trimEnd()}…` : joined;
  return { heading, snippet };
}

/**
 * What the link says out loud.
 *
 * A bare URL is what a screen reader had to read out before — for a link whose
 * visible words are "the specification", announcing the raw href is the least
 * useful thing available. The line the link sits on names it the way the page
 * does; the URL still follows, since where a link goes is worth hearing.
 */
function linkLabel(context: string, url: string): string {
  const trimmed = context.trim();
  const internalPage = parseInternalGotoPage(url);
  if (internalPage !== null) {
    return trimmed ? `${trimmed} — p. ${internalPage}` : `p. ${internalPage}`;
  }
  return trimmed ? `${trimmed} — ${url}` : url;
}

export function LinkLayer({ path, page, links, onActivate }: LinkLayerProps) {
  const { t } = useI18n();
  const [placed, setPlaced] = useState<PlacedLink[]>([]);
  const [peek, setPeek] = useState<LinkPeekState | null>(null);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const thumbAbortRef = useRef<AbortController | null>(null);

  const clearTimers = useCallback(() => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const dismissPeek = useCallback(() => {
    clearTimers();
    thumbAbortRef.current?.abort();
    thumbAbortRef.current = null;
    setPeek((prev) => (prev === null ? prev : null));
  }, [clearTimers]);

  const scheduleDismiss = useCallback(() => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      thumbAbortRef.current?.abort();
      thumbAbortRef.current = null;
      setPeek(null);
    }, PEEK_HIDE_GRACE_MS);
  }, []);

  useEffect(() => () => dismissPeek(), [dismissPeek, path, page]);

  useEffect(() => {
    if (!peek) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismissPeek();
    };
    window.addEventListener("scroll", dismissPeek, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", dismissPeek, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [peek, dismissPeek]);

  useEffect(() => {
    const onPage = links.filter(
      (l) => l.page === page && (isSafeLink(l.url) || parseInternalGotoPage(l.url) !== null),
    );
    if (onPage.length === 0) {
      setPlaced([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const geometry = await getPageGeometry(path, page);
        if (cancelled) return;
        setPlaced(
          onPage.map((link) => ({
            url: link.url,
            targetPage: parseInternalGotoPage(link.url),
            label: linkLabel(link.context, link.url),
            box: pdfRectToBox(link.rect, geometry),
          })),
        );
      } catch {
        // The page still reads fine without clickable links.
        if (!cancelled) setPlaced([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, page, links]);

  if (placed.length === 0) return null;

  const startPeek = (link: PlacedLink, el: HTMLButtonElement) => {
    const targetPage = link.targetPage;
    const doc = docCache.get(path);
    const total = doc?.totalPages ?? 0;
    if (targetPage === null || targetPage === page || targetPage < 1 || (total > 0 && targetPage > total)) {
      return;
    }
    clearTimers();
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      const vw = window.innerWidth || 1280;
      const vh = window.innerHeight || 800;
      const above = rect.bottom + 240 > vh && rect.top > 240;
      const left = Math.min(Math.max(12, rect.left), Math.max(12, vw - 292));
      const top = above ? rect.top - 6 : rect.bottom + 6;
      const { heading, snippet } = summarizeTargetPage(path, targetPage);
      const cacheKey = `${path}|${doc?.stamp ?? ""}|${targetPage}`;
      const cachedThumb = getCachedPeekThumb(cacheKey);

      thumbAbortRef.current?.abort();
      const controller = new AbortController();
      thumbAbortRef.current = controller;

      setPeek({
        url: link.url,
        targetPage,
        heading,
        snippet,
        thumbUrl: cachedThumb,
        left,
        top,
        above,
      });

      if (!cachedThumb && typeof URL.createObjectURL === "function") {
        void renderPageToJpegBytes(
          path,
          targetPage,
          PEEK_THUMB_EDGE,
          PEEK_THUMB_QUALITY,
          controller.signal,
        )
          .then((bytes) => {
            if (controller.signal.aborted) return;
            const blobUrl = URL.createObjectURL(
              new Blob([bytes as BlobPart], { type: "image/jpeg" }),
            );
            storePeekThumb(cacheKey, blobUrl);
            setPeek((cur) =>
              cur && cur.targetPage === targetPage ? { ...cur, thumbUrl: blobUrl } : cur,
            );
          })
          .catch(() => {});
      }
    }, PEEK_DELAY_MS);
  };

  return (
    <>
      <div className="pdf-link-layer">
        {placed.map((link, i) => (
          // raw-button: a hit area positioned over the page at the link's own PDF coordinates
          <button
            key={`${link.url}-${i}`}
            type="button"
            className="pdf-link"
            title={link.targetPage !== null && link.targetPage !== page ? undefined : link.label}
            aria-label={link.label}
            style={{
              left: `${link.box.left * 100}%`,
              top: `${link.box.top * 100}%`,
              width: `${link.box.width * 100}%`,
              height: `${link.box.height * 100}%`,
            }}
            onMouseEnter={(e) => startPeek(link, e.currentTarget)}
            onMouseLeave={scheduleDismiss}
            onClick={(e) => {
              // The text layer sits under this and owns selection; a click meant
              // for the link should not also start one.
              e.stopPropagation();
              dismissPeek();
              onActivate(link.url);
            }}
          />
        ))}
      </div>
      {peek &&
        typeof document !== "undefined" &&
        createPortal(
          // raw-button: floating reference-peek card portaled above the page; clicking turns straight to the previewed destination
          <button
            type="button"
            className="anchored-popover cite-popover cite-hover-card link-peek-card"
            data-above={peek.above ? "true" : undefined}
            aria-label={t("preview.pageTitle", { page: peek.targetPage })}
            style={{ left: peek.left, top: peek.top }}
            onMouseEnter={clearTimers}
            onMouseLeave={scheduleDismiss}
            onClick={(e) => {
              e.stopPropagation();
              const targetUrl = peek.url;
              dismissPeek();
              onActivate(targetUrl);
            }}
          >
            <span className="link-peek-head">
              <span className="link-peek-page">{t("preview.pageTitle", { page: peek.targetPage })}</span>
              {peek.heading && <span className="link-peek-title">{peek.heading}</span>}
            </span>
            {peek.thumbUrl && (
              <span className="link-peek-thumb-wrap">
                <img src={peek.thumbUrl} alt="" className="link-peek-thumb" />
              </span>
            )}
            {peek.snippet && <span className="link-peek-snippet">{peek.snippet}</span>}
          </button>,
          document.body,
        )}
    </>
  );
}
