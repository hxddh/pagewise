import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cachedReview, reviewBasis, subscribeReviews } from "../lib/claim-review";
import { setHoveredHighlight } from "../lib/hover-highlight";
import { useI18n } from "../i18n";
import {
  cachedCitationCheck,
  checkCitation,
  checksEpoch,
  subscribeChecks,
  withClaim,
  type CitationCheck,
} from "../lib/citation-check";
import { citationLabel, type CitationLink } from "../lib/remark-citations";
import { citationLevel } from "../lib/trust-level";
import { longKey, type CitationReason } from "../lib/trust-text";
import type { PdfRect } from "../lib/types";
import { AnchoredMenu } from "./AnchoredMenu";
import { ListRow } from "./ui/ListRow";

/**
 * What a citation needs from the panel it is drawn in: the document it cites,
 * and how to turn to a page. Absent where no document is open, and then a
 * citation is drawn as plain text — there is nothing to check it against.
 */
export interface CitationEnv {
  path: string;
  totalPages: number;
  /** Turn to `page`; with `rects`, light up where the words are. */
  /**
   * Go to the cited page and light the passage. `notice` is said when there is
   * no passage to light — the words were not found — so the click is not a
   * jump that silently shows nothing (21.0).
   */
  onReveal: (
    page: number,
    rects: PdfRect[] | null,
    notice?: string,
    secondPage?: { page: number; rects: PdfRect[] },
  ) => void;
  /**
   * Open the document search holding `text` (24.0). A red chip's first next
   * step: the words may be on another page, or worded a little differently.
   */
  onSearch?: (text: string) => void;
  /** Put `text` in the composer as the next question (24.0): cite this again. */
  onAsk?: (text: string) => void;
}

export const CitationContext = createContext<CitationEnv | null>(null);

/** The status a chip is drawn in: what its check found, or `pending` until it has run. */
export type CitationChipStatus = CitationReason;

/**
 * What a red chip searches for: the opening words of its quote, not all of it.
 *
 * The search is an exact substring match, and the whole quote is exactly what
 * the check already failed to find — searching for it again would show "no
 * results" and nothing else. The opening few words are usually still verbatim
 * when the rest drifted, and the reader can edit the field (24.0).
 */
export function searchSeed(quote: string): string {
  const text = quote.replace(/\s+/g, " ").trim();
  const words = text.split(" ");
  // Spaced scripts: four words. Unspaced (Chinese, Japanese): a dozen characters.
  if (words.length > 1) return words.slice(0, 4).join(" ").replace(/[,.;:，。；：]+$/, "");
  return Array.from(text).slice(0, 12).join("");
}

/**
 * One citation in an answer, and whether its words are on its page.
 *
 * The chip is the page number, set small against the sentence it supports,
 * in the colour of what the check found. The quote itself is not shown inline
 * — an answer with every passage quoted twice reads as a wall — but it is the
 * chip's title, and clicking turns to the page with the words lit.
 *
 * A red chip — words not found, or a passage the model read as saying
 * otherwise — opens a popover instead (24.0): the quote, why it is red, and
 * the next steps.
 *
 * The check runs once per citation per open document (`citation-check.ts`),
 * so a chip re-created by every streamed chunk costs nothing after the first.
 */
export function CitationChip({ link, children }: { link: CitationLink; children?: ReactNode }) {
  const env = useContext(CitationContext);
  const { t, locale } = useI18n();
  const [check, setCheck] = useState<CitationCheck | null>(() => (env ? cachedCitationCheck(env.path, link) : null));
  const [, setSiblingTick] = useState(0);
  const pagesKey = link.pages.join(",");
  // Checks forgotten — the page's words were read again (22.0): check again.
  const epoch = useSyncExternalStore(subscribeChecks, checksEpoch);
  const hasSiblings = Boolean(link.siblings && link.siblings.length > 0);

  useEffect(() => {
    if (!env || !hasSiblings) return;
    return subscribeChecks(() => setSiblingTick((n) => n + 1));
  }, [env, hasSiblings]);

  useEffect(() => {
    if (!env) return;
    let live = true;
    setCheck(cachedCitationCheck(env.path, link));
    checkCitation(env.path, env.totalPages, link).then(
      (c) => live && setCheck(c),
      () => undefined,
    );
    return () => {
      live = false;
    };
    // `link` is rebuilt on every render from its URL; its content is the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env?.path, env?.totalPages, pagesKey, link.quote, epoch]);
  // `link.claim` does not change what is checked, only how it is read.

  // The model's reading, when the reader asked for one (15.0). Shown beside
  // the local verdict, never in place of it. Subscribed before any early
  // return: a hook after one breaks when the document arrives (16.0, B11).
  const review = useSyncExternalStore(subscribeReviews, () =>
    env && link.quote && link.claim ? cachedReview(env.path, link.claim, link.quote, reviewBasis(check)) : null,
  );

  // The red chip's popover (24.0), plus quiet non-modal hover card (29.0).
  // Declared before the early return below, for the same reason the review subscription is.
  const [open, setOpen] = useState(false);
  const [hoverCard, setHoverCard] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const hoverLightTimerRef = useRef<number | null>(null);
  const litByMeRef = useRef(false);
  const chipRef = useRef<HTMLButtonElement>(null);

  useEffect(
    () => () => {
      if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
      if (hoverLightTimerRef.current !== null) window.clearTimeout(hoverLightTimerRef.current);
      if (litByMeRef.current) {
        litByMeRef.current = false;
        setHoveredHighlight(null);
      }
    },
    [],
  );

  useEffect(() => {
    if (!hoverCard) return;
    const dismissOnScroll = () => {
      setHoverCard(null);
      if (litByMeRef.current) {
        litByMeRef.current = false;
        setHoveredHighlight(null);
      }
    };
    window.addEventListener("scroll", dismissOnScroll, true);
    return () => window.removeEventListener("scroll", dismissOnScroll, true);
  }, [hoverCard]);

  const label = children ?? citationLabel(link.pages);
  if (!env) return <sup className="cite cite-inert">{label}</sup>;

  // Read against the sentence it supports: a number the passage does not state
  // turns a found quote into a doubted one (15.0).
  const read = withClaim(check, link.claim ?? "", link.quote, env.path, link.siblings);
  const status: CitationChipStatus = read?.status ?? "pending";
  const pages = citationLabel(link.pages);
  // The words the check found, from the one table of them (trust-text.ts):
  // the same sentence the record shows for the same state.
  const verdict = t(longKey(status), {
    page: String(read?.page ?? link.pages[0]),
    pages,
    numbers: (read?.unstated ?? []).join(locale === "zh-CN" ? "、" : ", "),
  });
  const reviewLine = review ? `\n${t(`cite.review.${review.verdict}`)}: ${review.reason}` : "";
  // Three levels on screen; the precise reason in the title (16.0).
  const level = citationLevel(status, review?.verdict);
  const headline = level === "none" ? "" : `${t(`level.${level}`)} — `;
  const title = (link.quote ? `“${link.quote}”\n${headline}${verdict}` : `${headline}${verdict}`) + reviewLine;

  // A red chip opens its explanation where it is (24.0). Until then the click
  // turned the page, lit nothing, and said why in a toast at the far corner
  // of the window — and the hover title is not shown in every webview.
  const flagged = level === "notFound";
  const target = read?.page ?? link.pages[0]!;
  // `outOfRange` cites a page the document does not have: nothing to open.
  const canOpen = status !== "outOfRange";

  const clearHover = () => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    if (hoverLightTimerRef.current !== null) {
      window.clearTimeout(hoverLightTimerRef.current);
      hoverLightTimerRef.current = null;
    }
    setHoverCard((prev) => (prev === null ? prev : null));
    if (litByMeRef.current) {
      litByMeRef.current = false;
      setHoveredHighlight(null);
    } else {
      setHoveredHighlight(null);
    }
  };

  const reveal = () => {
    clearHover();
    const rects = read?.rects ?? null;
    // A chip whose words were not found has nothing to light, and a yellow
    // `check` chip (mismatch / model review doubt) should also explain why it
    // was flagged when clicked rather than silently lighting the page (29.0).
    const shouldExplain =
      !flagged && ((!rects && status !== "pending" && status !== "located") || level === "check");
    const notice = shouldExplain ? `${headline}${verdict}${reviewLine}` : undefined;
    if (read?.secondPage) {
      env.onReveal(target, rects, notice, read.secondPage);
    } else {
      env.onReveal(target, rects, notice);
    }
  };

  return (
    <>
      {/* raw-button: an inline mark inside a sentence — it has to sit on the text line, not read as a control */}
      <button
        ref={chipRef}
        type="button"
        className={`cite cite-level-${level} cite-${status}${review ? ` cite-review-${review.verdict}` : ""}`}
        title={title}
        aria-label={title}
        aria-haspopup={flagged ? "dialog" : undefined}
        aria-expanded={flagged ? open : undefined}
        onMouseEnter={() => {
          if (read?.rects?.length && read.page) {
            if (hoverLightTimerRef.current !== null) window.clearTimeout(hoverLightTimerRef.current);
            const targetPage = read.page;
            const targetRects = read.rects;
            const targetSecond = read.secondPage;
            hoverLightTimerRef.current = window.setTimeout(() => {
              hoverLightTimerRef.current = null;
              litByMeRef.current = true;
              setHoveredHighlight({
                kind: "citation",
                path: env.path,
                page: targetPage,
                rects: targetRects,
                secondPage: targetSecond,
              });
            }, 60);
          }
          if (flagged || open) return;
          if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
          hoverTimerRef.current = window.setTimeout(() => {
            const box = chipRef.current?.getBoundingClientRect();
            if (!box) return;
            const vw = window.innerWidth || 1280;
            const vh = window.innerHeight || 800;
            const above = box.bottom + 140 > vh && box.top > 140;
            const left = Math.min(Math.max(12, box.left), Math.max(12, vw - 332));
            const top = above ? box.top - 6 : box.bottom + 6;
            setHoverCard({ left, top, above });
          }, 180);
        }}
        onMouseLeave={clearHover}
        onClick={() => {
          clearHover();
          if (flagged) setOpen((o) => !o);
          else reveal();
        }}
      >
        {label}
      </button>
      {hoverCard && !flagged && !open && typeof document !== "undefined" &&
        createPortal(
          <div
            className="anchored-popover cite-popover cite-hover-card"
            data-level={level}
            data-above={hoverCard.above ? "true" : undefined}
            aria-hidden="true"
            style={{ left: hoverCard.left, top: hoverCard.top }}
          >
            <div className="cite-popover-body">
              <p className="cite-hover-verdict">
                {headline}
                {verdict}
              </p>
              {review && (
                <p className="cite-popover-review">
                  {t(`cite.review.${review.verdict}`)}: {review.reason}
                </p>
              )}
              {link.quote && (
                <blockquote className="cite-popover-quote">
                  “{link.quote}”
                </blockquote>
              )}
              <p className="cite-popover-page">{t("cite.popover.quoted", { pages })}</p>
            </div>
          </div>,
          document.body,
        )}
      {flagged && (
        <AnchoredMenu
          open={open}
          onClose={() => setOpen(false)}
          anchorRef={chipRef}
          className="anchored-popover cite-popover"
          align="start"
          role="dialog"
        >
          <div className="cite-popover-body" aria-label={t("cite.popover.label")}>
            <p className="cite-popover-verdict">
              {headline}
              {verdict}
            </p>
            {review && (
              <p className="cite-popover-review">
                {t(`cite.review.${review.verdict}`)}: {review.reason}
              </p>
            )}
            {link.quote && <blockquote className="cite-popover-quote">“{link.quote}”</blockquote>}
            <p className="cite-popover-page">{t("cite.popover.quoted", { pages })}</p>
          </div>
          <div className="cite-popover-actions">
            {link.quote && env.onSearch && (
              <ListRow
                label={t("cite.popover.search")}
                onClick={() => {
                  setOpen(false);
                  env.onSearch!(searchSeed(link.quote!));
                }}
              />
            )}
            {env.onAsk && (
              <ListRow
                label={t("cite.popover.ask")}
                onClick={() => {
                  setOpen(false);
                  env.onAsk!(t("cite.popover.askPrompt", { pages, claim: link.claim || link.quote || "" }));
                }}
              />
            )}
            {canOpen && (
              <ListRow
                label={t("cite.popover.open")}
                onClick={() => {
                  setOpen(false);
                  reveal();
                }}
              />
            )}
          </div>
        </AnchoredMenu>
      )}
    </>
  );
}
