import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ConfirmDialog } from "../../components/overlays/ConfirmDialog";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useI18n } from "../../i18n";
import { useToast } from "../../hooks/useToast";
import { setActiveReaderSelection } from "../../lib/active-selection";
import { getHoveredHighlight, subscribeHoveredHighlight } from "../../lib/hover-highlight";
import { isOverlayOpen, isTypingTarget } from "../../lib/shortcut-guards";
import { usePageIndexStatus } from "../../hooks/usePageIndexStatus";
import { getPageIndexState, clearPageIndexState } from "../../lib/index-events";
import { sanitizeIndexErrorDetail } from "../../lib/index-error-display";
import { getPageTextLen, pageHasIndexableText } from "../../lib/doc-text";
import { indexPageInBackground, OCR_TRUSTED_CONFIDENCE } from "../../document/index-queue";
import { cachedOcrPage, ocrEnabled } from "../../lib/ocr/ocr-service";
import { useSettled } from "../../lib/use-settled";
import { isImeComposing } from "../../lib/ime";
import { usePdfViewer } from "./usePdfViewer";
import { useAskSelection } from "./useAskSelection";
import { selectionQuote } from "./selection-quote";
import { SearchHighlight } from "./SearchHighlight";
import { LinkLayer } from "./LinkLayer";
import { AnnotationLayer } from "./AnnotationLayer";
import { MarkLayer } from "./MarkLayer";
import { FindingLayer } from "./FindingLayer";
import { RegionSelectLayer } from "./RegionSelectLayer";
import { PageScroller, type SubPageScrollTarget } from "./PageScroller";
import { PageGutter, type PageMarginBox } from "./PageGutter";
import { ReadingLine } from "./ReadingLine";
import { regionSnapshot } from "./region-snapshot";
import { useMarkRevision } from "./useMarks";
import { useRevealedCitation, useSearchHit } from "./useSearchHit";
import { CitationHighlight, type RevealedCitation } from "./CitationHighlight";
import { pdfRectToBox, topLeftRectToBox, type HighlightBox } from "./search-highlight";
import { sidebarTabState } from "./sidebar-tabs";
import { addMark, getMarks } from "../../lib/mark-store";
import { getFindings } from "../../lib/finding-store";
import { placeFinding } from "../../lib/finding-anchors";
import { extractRegion, getPageGeometry } from "../../lib/pdf";
import { pageRuns } from "../../lib/finding-anchors";
import { wordsInRegion } from "../../lib/ocr/ocr-region";
import { clientRectToPageRect } from "./selection-quote";
import { displayUrl, parseInternalGotoPage } from "../../lib/safe-link";
import type { LoadedDocument, PdfRect } from "../../lib/types";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Field";
import { PreviewToolbar } from "../../components/PreviewToolbar";
import { ThumbnailSidebar } from "../../components/ThumbnailSidebar";
import { OutlineSidebar } from "../../components/OutlineSidebar";
import { usableOutline } from "../../lib/outline-nav";
import { DocumentSearch } from "../../components/DocumentSearch";
import { Tabs } from "../../components/ui/Tabs";
import type { AnswerNote, PageCitation } from "../../lib/page-citations";

function clampSelectionAnchor(
  x: number,
  y: number,
  panel: HTMLElement | null,
): { left: number; top: number } {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const rect = panel?.getBoundingClientRect();
  const minX = (rect ? rect.left : 0) + 104;
  const maxX = Math.max(minX, (rect ? rect.right : vw) - 104);
  const minY = (rect ? rect.top : 0) + 52;
  const maxY = Math.max(minY, (rect ? rect.bottom : vh) - 16);
  return {
    left: Math.min(maxX, Math.max(minX, x)),
    top: Math.min(maxY, Math.max(minY, y)),
  };
}

/** How long the page has to stay put before it counts as being read. */
const INDEX_SETTLE_MS = 500;
const INDEX_SETTLE_LOCAL_OCR_MS = 100;

interface PreviewPaneProps {
  doc: LoadedDocument;
  page: number;
  onPageChange: (page: number) => void;
  prefsRevision?: number;
  onOpenAiSettings?: () => void;
  onAskAboutSelection?: (text: string) => void;
  /** The record entry the reader picked in the other column, if any. */
  selectedFindingId?: string | null;
  onSelectFinding?: (id: string | null) => void;
  /** The mark the reader picked — on the page, in the margin, or in the record. */
  selectedMarkId?: string | null;
  onSelectMark?: (id: string | null) => void;
  /** A citation the reader followed from an answer, to light on its page. */
  revealedCitation?: RevealedCitation | null;
  /** Answers citing each page, for the margin's indigo dots. */
  citations?: Map<number, PageCitation[]> | null;
  /** Answers' sentences citing each page, with their states, for the column. */
  notes?: Map<number, AnswerNote[]> | null;
  /** Bring the answer that cited a page back in front of the reader. */
  onRevealMessage?: (messageId: string) => void;
  /**
   * True while the panel is closed: the margin is then the column (20.0) and
   * reserves its width, so a short answer and its states sit beside the page
   * without the panel having to open.
   */
  marginColumn?: boolean;
  /** Floating Ask bar state when the chat column is closed (Living Margin). */
  marginAsk?: {
    visible: boolean;
    draft: string;
    busy: boolean;
    progress?: string | null;
    errorMessage?: string | null;
    onDismissError?: () => void;
    reply?: {
      messageId: string;
      text: string;
      citedPages: number[];
    } | null;
    onDismissReply?: () => void;
    focusNonce: number;
    onDraftChange: (value: string) => void;
    onSubmit: (text: string) => void;
    onStop: () => void;
    onDismiss?: () => void;
  };
  /** Read the pages the sweep left — the scan-all flow with its confirmation (22.0). */
  onReadRest?: () => void;
}

function PreviewPaneInner({
  doc,
  page,
  onPageChange,
  prefsRevision = 0,
  onOpenAiSettings,
  onAskAboutSelection,
  selectedFindingId = null,
  onSelectFinding,
  selectedMarkId = null,
  onSelectMark,
  revealedCitation = null,
  citations = null,
  notes = null,
  onRevealMessage,
  marginColumn = false,
  marginAsk,
  onReadRest,
}: PreviewPaneProps) {
  const { t } = useI18n();
  const { showToast } = useToast();
  const [thumbsVisible, setThumbsVisible] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<"pages" | "outline">("pages");
  const [regionMode, setRegionMode] = useState(false);
  const [altKeyHeld, setAltKeyHeld] = useState(false);
  const [altRegionActive, setAltRegionActive] = useState(false);
  const [altDragSeed, setAltDragSeed] = useState<{
    page: number;
    pointerId: number;
    clientX: number;
    clientY: number;
    nonce: number;
  } | null>(null);
  const altSeedNonceRef = useRef(0);
  const [jumpPillVisible, setJumpPillVisible] = useState(false);
  const [selOffscreen, setSelOffscreen] = useState(false);
  const hovered = useSyncExternalStore(subscribeHoveredHighlight, getHoveredHighlight);
  const [pendingRegion, setPendingRegion] = useState<{
    page: number;
    pdfRect: PdfRect;
    text: string;
    x: number;
    y: number;
  } | null>(null);
  const marginInputRef = useRef<HTMLInputElement | null>(null);
  const markRevision = useMarkRevision(doc.path);
  // What the reader searched for when they jumped here, so the hit can be
  // marked on the page. Forgotten as soon as they navigate away from it — see
  // `useSearchHit`, which is where that rule lives.
  const [searchHit, setSearchHit] = useSearchHit(page, doc.path);
  const citation = useRevealedCitation(page, revealedCitation);
  // A link the reader clicked, held until they confirm. Document URLs are
  // untrusted input, so nothing opens the browser on its own.
  const [pendingLink, setPendingLink] = useState<string | null>(null);
  const [scrollTarget, setScrollTarget] = useState<SubPageScrollTarget | null>(null);
  const targetNonceRef = useRef(0);

  const toggleThumbs = useCallback(() => setThumbsVisible((v) => !v), []);
  const handleRestorePlace = useCallback((place: { page: number; topFraction: number }) => {
    targetNonceRef.current += 1;
    setScrollTarget({
      page: place.page,
      topFraction: place.topFraction,
      heightFraction: 0.05,
      nonce: targetNonceRef.current,
    });
  }, []);
  const viewer = usePdfViewer({
    doc,
    page,
    onPageChange,
    prefsRevision,
    onToggleThumbs: toggleThumbs,
    onRestorePlace: handleRestorePlace,
  });

  const jumpWithHistory = useCallback(
    (target: number) => {
      viewer.recordJumpFromCurrent(target);
      onPageChange(target);
    },
    [viewer, onPageChange],
  );

  // Show a quiet transient jump-back / forward pill whenever reading history changes.
  useEffect(() => {
    if (!viewer.canGoBack && !viewer.canGoForward) {
      setJumpPillVisible(false);
      return;
    }
    setJumpPillVisible(true);
    const id = window.setTimeout(() => setJumpPillVisible(false), 8000);
    return () => window.clearTimeout(id);
  }, [viewer.canGoBack, viewer.canGoForward, viewer.backPage, viewer.forwardPage, page]);

  useEffect(() => {
    if (doc.kind !== "pdf") {
      setAltKeyHeld(false);
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Alt" && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        setAltKeyHeld(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Alt" || !e.altKey) setAltKeyHeld(false);
    };
    const onBlur = () => setAltKeyHeld(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [doc.kind]);

  useEffect(() => {
    if (!altRegionActive) return;
    const end = () => {
      setAltRegionActive(false);
      setAltDragSeed(null);
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", end);
    };
  }, [altRegionActive]);

  const handleSearchFocusBox = useCallback(
    (box: HighlightBox) => {
      if (!searchHit) return;
      targetNonceRef.current += 1;
      setScrollTarget({
        page: searchHit.page,
        topFraction: box.top,
        heightFraction: box.height,
        nonce: targetNonceRef.current,
      });
    },
    [searchHit],
  );

  useEffect(() => {
    if (!revealedCitation?.rects?.length || doc.kind !== "pdf") return;
    let cancelled = false;
    void getPageGeometry(doc.path, revealedCitation.page)
      .then((geometry) => {
        if (cancelled) return;
        const boxes = revealedCitation.rects.map((r) => pdfRectToBox(r, geometry));
        const top = Math.min(...boxes.map((b) => b.top));
        const bottom = Math.max(...boxes.map((b) => b.top + b.height));
        targetNonceRef.current += 1;
        setScrollTarget({
          page: revealedCitation.page,
          topFraction: top,
          heightFraction: Math.max(0.02, bottom - top),
          nonce: targetNonceRef.current,
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [doc.path, doc.kind, revealedCitation?.nonce, revealedCitation?.page, revealedCitation?.rects]);

  useEffect(() => {
    if (!selectedFindingId || doc.kind !== "pdf") return;
    const finding = getFindings(doc.path).find((f) => f.id === selectedFindingId);
    if (!finding) return;
    let cancelled = false;
    void Promise.all([placeFinding(doc.path, finding), getPageGeometry(doc.path, page)])
      .then(([placement, geometry]) => {
        if (cancelled) return;
        if (
          (placement.status === "located" || placement.status === "mismatch") &&
          placement.anchor.page === page
        ) {
          const box = pdfRectToBox(placement.anchor.bounds, geometry);
          targetNonceRef.current += 1;
          setScrollTarget({
            page,
            topFraction: box.top,
            heightFraction: box.height,
            nonce: targetNonceRef.current,
          });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [doc.path, doc.kind, page, selectedFindingId]);

  useEffect(() => {
    if (!selectedMarkId || doc.kind !== "pdf") return;
    const mark = getMarks(doc.path).find((m) => m.id === selectedMarkId);
    if (!mark || mark.page !== page || mark.rects.length === 0) return;
    let cancelled = false;
    void getPageGeometry(doc.path, mark.page)
      .then((geometry) => {
        if (cancelled) return;
        const boxes = mark.rects.map((r) => topLeftRectToBox(r, geometry));
        const top = Math.min(...boxes.map((b) => b.top));
        const bottom = Math.max(...boxes.map((b) => b.top + b.height));
        targetNonceRef.current += 1;
        setScrollTarget({
          page: mark.page,
          topFraction: top,
          heightFraction: Math.max(0.02, bottom - top),
          nonce: targetNonceRef.current,
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [doc.path, doc.kind, page, selectedMarkId]);

  // Bumped whenever the view changes or this pane goes away, so an in-flight
  // selection read can tell that its answer no longer belongs anywhere.
  const quoteRun = useRef(0);
  useEffect(() => () => {
    quoteRun.current += 1;
  }, [doc.path]);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  // The panel itself, so the in-document search can portal into its box
  // rather than over the whole window.
  const panelRef = useRef<HTMLDivElement | null>(null);
  const bindScroller = useCallback(
    (node: HTMLDivElement | null) => {
      scrollerRef.current = node;
      viewer.bindScroller(node);
    },
    [viewer],
  );
  const [askSel, clearAskSel] = useAskSelection(
    scrollerRef,
    doc.kind === "pdf",
  );

  // Sync active PDF text / region selection into the agent's live view context (29.0).
  useEffect(() => {
    if (askSel) {
      setActiveReaderSelection({
        path: doc.path,
        page: askSel.page,
        text: askSel.text,
        kind: "text",
      });
      return;
    }
    if (pendingRegion) {
      setActiveReaderSelection({
        path: doc.path,
        page: pendingRegion.page,
        text: pendingRegion.text,
        kind: "region",
        pdfRect: pendingRegion.pdfRect,
      });
      return;
    }
    setActiveReaderSelection(null);
  }, [doc.path, askSel, pendingRegion]);

  // Hide the fixed selection toolbar if the reader scrolls the selected text out of view.
  useEffect(() => {
    setSelOffscreen(false);
    if (!askSel) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const onScroll = () => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        setSelOffscreen(true);
        return;
      }
      const rangeBox = sel.getRangeAt(0).getBoundingClientRect();
      const panelBox = (panelRef.current ?? scroller).getBoundingClientRect();
      setSelOffscreen(
        rangeBox.bottom < panelBox.top + 40 || rangeBox.top > panelBox.bottom - 16,
      );
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [askSel]);

  const copySelectionCitation = useCallback(() => {
    if (!askSel || doc.kind !== "pdf") return;
    const box = askSel.pageBox;
    const selectionRect = askSel.rect;
    const selPage = askSel.page;
    const selPages = askSel.pages;
    const rawText = askSel.text;
    const run = quoteRun.current;
    clearAskSel();
    window.getSelection()?.removeAllRanges();
    void selectionQuote(doc.path, selPage, rawText, selectionRect, box, selPages).then(
      async (resolved) => {
        if (quoteRun.current !== run) return;
        const quote = (resolved || rawText).trim();
        if (!quote) return;
        const shortName = doc.name.replace(/\.pdf$/i, "");
        const formatted = `“${quote}” (${shortName}, ${t("preview.pageHit", { page: selPage })})`;
        try {
          await navigator.clipboard.writeText(formatted);
          showToast(t("toast.citationCopied"), "default");
        } catch {
          showToast(t("toast.copyFailed"), "error");
        }
      },
    );
  }, [askSel, clearAskSel, doc.kind, doc.name, doc.path, showToast, t]);

  useEffect(() => {
    if (!askSel || doc.kind !== "pdf") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target) || isOverlayOpen()) return;
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "c") {
        e.preventDefault();
        copySelectionCitation();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [askSel, doc.kind, copySelectionCitation]);

  const createSelectionMarks = useCallback(
    (openNote: boolean) => {
      if (!askSel || doc.kind !== "pdf") return;
      const slices =
        askSel.pages && askSel.pages.length > 0
          ? askSel.pages
          : [{ page: askSel.page, pageBox: askSel.pageBox, rects: askSel.rects }];
      const text = askSel.text;
      const run = quoteRun.current;
      clearAskSel();
      window.getSelection()?.removeAllRanges();
      void (async () => {
        try {
          let firstCreatedId: string | null = null;
          for (const slice of slices) {
            const geometry = await getPageGeometry(doc.path, slice.page);
            if (quoteRun.current !== run) return;
            const mark = addMark(doc.path, {
              page: slice.page,
              rects: slice.rects.map((r) => clientRectToPageRect(r, slice.pageBox, geometry)),
              text: slice.text || text,
              stamp: doc.stamp ?? "",
            });
            if (!mark) {
              showToast(t("marks.capReached"), "error");
              break;
            }
            if (!firstCreatedId) firstCreatedId = mark.id;
          }
          if (openNote && firstCreatedId) onSelectMark?.(firstCreatedId);
        } catch {
          // Nothing to place the mark against; leaving the page unmarked is
          // better than marking it in the wrong spot.
        }
      })();
    },
    [askSel, clearAskSel, doc.kind, doc.path, doc.stamp, onSelectMark, showToast, t],
  );

  const askButton =
    askSel && onAskAboutSelection ? (
      <Button
        variant="primary"
        size="md"
        className="ask-selection-btn"
        // Keep the selection alive through the click.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          const box = askSel.pageBox;
          const selectionRect = askSel.rect;
          const selPage = askSel.page;
          const selPages = askSel.pages;
          const run = quoteRun.current;
          clearAskSel();
          window.getSelection()?.removeAllRanges();
          void selectionQuote(doc.path, selPage, askSel.text, selectionRect, box, selPages).then(
            (quote) => {
              if (quoteRun.current !== run) return;
              onAskAboutSelection(`"${quote}"`);
            },
          );
        }}
      >
        {t("preview.askAboutSelection")}
      </Button>
    ) : null;

  // Choice 2A (29.0): "Mark" highlights silently in 1 click without stealing
  // focus; "Note" creates the mark and opens the note card; "Cite" copies quote + page.
  const markButton =
    askSel && doc.kind === "pdf" ? (
      <>
        <Button
          variant="secondary"
          size="md"
          className="mark-selection-btn"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => createSelectionMarks(false)}
        >
          {t("marks.markSelection")}
        </Button>
        <Button
          variant="secondary"
          size="md"
          className="mark-selection-btn"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => createSelectionMarks(true)}
        >
          {t("marks.noteSelection")}
        </Button>
        <Button
          variant="secondary"
          size="md"
          className="mark-selection-btn"
          onMouseDown={(e) => e.preventDefault()}
          onClick={copySelectionCitation}
        >
          {t("marks.citeSelection")}
        </Button>
      </>
    ) : null;

  // Leaving the mode or dismissing a boxed region has to be possible with Escape.
  useEffect(() => {
    if (!regionMode && !pendingRegion) return;
    const onKey = (e: KeyboardEvent) => {
      if (isImeComposing(e)) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        setRegionMode(false);
        setPendingRegion(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [regionMode, pendingRegion]);

  useEffect(() => {
    setPendingRegion(null);
  }, [doc.path, page]);

  useEffect(() => {
    if (askSel) setPendingRegion(null);
  }, [askSel]);

  useEffect(() => {
    if (!marginColumn || !marginAsk?.visible || marginAsk.focusNonce === 0) return;
    const id = requestAnimationFrame(() => marginInputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [marginColumn, marginAsk?.visible, marginAsk?.focusNonce]);

  const handleLinkActivate = useCallback(
    (url: string) => {
      const gotoTarget = parseInternalGotoPage(url);
      if (gotoTarget !== null) {
        const clamped = Math.max(1, Math.min(doc.kind === "pdf" ? doc.totalPages : 1, gotoTarget));
        const previousPage = page;
        jumpWithHistory(clamped);
        if (clamped !== previousPage) {
          showToast(t("toast.jumpedToPage", { page: clamped }), "default", {
            label: t("toast.backToPage", { page: previousPage }),
            onClick: () => {
              if (!viewer.goBack()) onPageChange(previousPage);
            },
          });
        }
        return;
      }
      setPendingLink(url);
    },
    [doc, page, jumpWithHistory, viewer, onPageChange, showToast, t],
  );

  // The page below indexes itself when it has no text of its own, and indexing
  // a scanned page is a billed vision call. While the preview flipped one page
  // at a time, a click cost at most one call. Scrolling changes the current
  // page continuously, so an unsettled page number would spend a call on every
  // page scrolled *past* — a 200-page scan, scrolled through once, unattended.
  // The page you are looking at is the one you stopped on.
  const indexSettleMs = ocrEnabled() ? INDEX_SETTLE_LOCAL_OCR_MS : INDEX_SETTLE_MS;
  const indexPage = useSettled(doc.kind === "pdf" ? page : 1, indexSettleMs);
  const indexState = usePageIndexStatus(doc.path, indexPage);
  const pageTextLen = getPageTextLen(doc.path, indexPage, doc.pages);

  useEffect(() => {
    if (pageHasIndexableText(doc.path, indexPage, doc.pages)) return;
    const state = getPageIndexState(doc.path, indexPage);
    if (state?.status === "indexing") return;
    if (state?.status === "failed") return;
    if (state?.status === "done" && pageHasIndexableText(doc.path, indexPage, doc.pages)) {
      return;
    }
    indexPageInBackground(doc.path, indexPage);
  }, [doc.path, doc.kind, indexPage, pageTextLen]);

  const transientRetryRef = useRef(0);

  useEffect(() => {
    transientRetryRef.current = 0;
  }, [doc.path, indexPage]);

  useEffect(() => {
    const state = getPageIndexState(doc.path, indexPage);
    if (state?.status !== "failed") return;
    const detail = sanitizeIndexErrorDetail(state.error);
    const transient = detail === "timeout";
    if (!transient) return;
    if (transientRetryRef.current >= 6) return;

    const delayMs = Math.min(30_000, 4000 * 2 ** transientRetryRef.current);
    const timer = window.setTimeout(() => {
      if (pageHasIndexableText(doc.path, indexPage, doc.pages)) return;
      transientRetryRef.current += 1;
      clearPageIndexState(doc.path, indexPage);
      indexPageInBackground(doc.path, indexPage);
    }, delayMs);

    return () => window.clearTimeout(timer);
  }, [doc.path, doc.kind, indexPage, indexState?.status, indexState?.error, indexState?.failureReason]);

  const indexHint = useMemo(() => {
    // Three things to say about a page, and silence when it is fine (16.0):
    // being read, read but worth checking, could not be read. "Indexed ·
    // vision model" and "Read on this computer · 96% confidence" on every
    // readable page told the reader how, when all they needed was whether.
    const hasText = pageHasIndexableText(doc.path, indexPage, doc.pages);
    if (hasText) {
      const pageSource = doc.pages.find((p) => p.page === indexPage)?.source;
      const read = pageSource === "ocr" ? cachedOcrPage(doc.path, indexPage) : undefined;
      if (read && read.confidence < OCR_TRUSTED_CONFIDENCE) {
        return t("preview.readPoorly", { confidence: String(Math.round(read.confidence)) });
      }
      return null;
    }
    if (indexState?.status === "indexing") return t("preview.reading");
    if (indexState?.status === "failed") {
      let hint: string;
      switch (indexState.failureReason) {
        case "vision_failed":
          hint = t("preview.indexFailedNeedVision");
          break;
        case "insufficient_text":
          hint = t("preview.indexFailedInsufficient");
          break;
        default:
          hint = t("preview.indexFailedUnknown");
      }
      const detail = sanitizeIndexErrorDetail(indexState.error);
      if (detail && detail !== indexState.failureReason) {
        return `${hint} · ${t(`preview.indexError.${detail}`)}`;
      }
      return hint;
    }
    if (pageTextLen === 0) return t("preview.reading");
    return null;
  }, [doc.path, doc.pages, indexPage, indexState, pageTextLen, t]);

  const indexHintActionable =
    indexState?.status === "failed" &&
    indexState.failureReason === "vision_failed" &&
    !!onOpenAiSettings;

  const showRetryOnVisionFailed =
    indexState?.status === "failed" && indexState.failureReason === "vision_failed";

  const indexFailed = indexState?.status === "failed";

  const retryIndex = () => {
    clearPageIndexState(doc.path, indexPage);
    indexPageInBackground(doc.path, indexPage);
  };

  const totalPages = doc.kind === "pdf" ? doc.totalPages : 1;

  // One function for every page rather than a closure per page: the scroller
  // re-renders on every frame of a scroll, and a fresh function each time would
  // make `PageSlot`'s memo miss, re-reconciling every mounted page and all four
  // of its overlay layers sixty times a second.
  const renderOverlays = useCallback(
    (slotPage: number) => {
      const citationRects =
        citation?.page === slotPage
          ? citation.rects
          : citation?.secondPage?.page === slotPage
            ? citation.secondPage.rects
            : hovered?.kind === "citation" && hovered.path === doc.path
              ? hovered.page === slotPage
                ? hovered.rects
                : hovered.secondPage?.page === slotPage
                  ? hovered.secondPage.rects
                  : null
              : null;
      return (
        <>
          {searchHit?.page === slotPage && (
            <SearchHighlight
              path={doc.path}
              page={slotPage}
              query={searchHit.query}
              focusIndex={searchHit.matchOnPage ?? 0}
              onFocusBox={handleSearchFocusBox}
            />
          )}
          {citationRects && citationRects.length > 0 && (
            <CitationHighlight path={doc.path} page={slotPage} rects={citationRects} />
          )}
          <RegionSelectLayer
            active={regionMode || altKeyHeld || altRegionActive}
            seed={altDragSeed?.page === slotPage ? altDragSeed : null}
            onRegion={(rect, pageBox) => {
              setRegionMode(false);
              setAltRegionActive(false);
              setAltDragSeed(null);
            const anchorX = rect.left + rect.width / 2;
            const anchorY = Math.max(48, rect.top);
            const run = quoteRun.current;
            void (async () => {
              try {
                const geometry = await getPageGeometry(doc.path, slotPage);
                if (quoteRun.current !== run) return;
                const pdfRect = clientRectToPageRect(rect, pageBox, geometry);
                let text = "";
                try {
                  text = regionSnapshot(await extractRegion(doc.path, slotPage, pdfRect));
                } catch {
                  // A region with no readable text is normal on a scan.
                }
                if (!text.trim()) {
                  const runs = await pageRuns(doc.path, slotPage);
                  if (runs.source === "ocr") {
                    text = wordsInRegion(runs.items, pdfRect, geometry.view, geometry);
                  }
                }
                if (quoteRun.current !== run) return;
                if (onAskAboutSelection) {
                  setPendingRegion({ page: slotPage, pdfRect, text, x: anchorX, y: anchorY });
                } else {
                  const mark = addMark(doc.path, {
                    page: slotPage,
                    rects: [pdfRect],
                    text,
                    stamp: doc.stamp ?? "",
                    kind: "region",
                  });
                  if (mark) onSelectMark?.(mark.id);
                  else showToast(t("marks.capReached"), "error");
                }
              } catch {
                // Nothing to place the mark against.
              }
            })();
          }}
        />
        <MarkLayer
          path={doc.path}
          page={slotPage}
          revision={markRevision}
          selectedId={selectedMarkId}
          onSelect={(id) => onSelectMark?.(id)}
        />
        <FindingLayer
          path={doc.path}
          page={slotPage}
          revision={markRevision}
          selectedId={selectedFindingId}
          onSelect={(id) => onSelectFinding?.(id)}
        />
        {doc.links && doc.links.length > 0 && (
          <LinkLayer
            path={doc.path}
            page={slotPage}
            links={doc.links}
            onActivate={handleLinkActivate}
          />
        )}
        {doc.annotations && doc.annotations.length > 0 && (
          <AnnotationLayer path={doc.path} page={slotPage} annotations={doc.annotations} />
        )}
        </>
      );
    },
    [
      doc.path,
      doc.links,
      doc.annotations,
      doc.stamp,
      searchHit,
      citation,
      hovered,
      regionMode,
      altKeyHeld,
      altRegionActive,
      altDragSeed,
      markRevision,
      selectedMarkId,
      selectedFindingId,
      onSelectFinding,
      onSelectMark,
      onAskAboutSelection,
      handleLinkActivate,
      handleSearchFocusBox,
      showToast,
      t,
    ],
  );

  // The margin, one strip per mounted page. Its dots are the three things the
  // page carries beyond its own text — what the reader marked, what the
  // assistant concluded, and which answers talked about it. While the panel is
  // closed the strip is the column (20.0) and the entries carry their words.
  const renderGutter = useCallback(
    (slotPage: number, box: PageMarginBox) => (
      <PageGutter
        path={doc.path}
        page={slotPage}
        box={box}
        revision={markRevision}
        column={marginColumn}
        citations={citations}
        notes={notes}
        totalPages={totalPages}
        selectedMarkId={selectedMarkId}
        currentStamp={doc.stamp ?? ""}
        onCloseMark={() => onSelectMark?.(null)}
        onSelectMark={(target, id) => {
          jumpWithHistory(target);
          onSelectMark?.(id);
        }}
        onSelectFinding={(id, target) => {
          jumpWithHistory(target);
          onSelectFinding?.(id);
        }}
        onRevealMessage={onRevealMessage}
      />
    ),
    [
      doc.path,
      doc.stamp,
      markRevision,
      marginColumn,
      citations,
      notes,
      totalPages,
      selectedMarkId,
      onPageChange,
      jumpWithHistory,
      onSelectMark,
      onSelectFinding,
      onRevealMessage,
    ],
  );

  const canvasBody = (
    <>
      {regionMode && doc.kind === "pdf" && (
        <div className="region-mode-pill" role="status">
          {t("marks.regionPill")}
        </div>
      )}
      {jumpPillVisible && doc.kind === "pdf" && (viewer.canGoBack || viewer.canGoForward) && (
        <div className="preview-jump-pill" role="group" aria-label={t("commands.jumpHistory")}>
          {viewer.canGoBack && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                viewer.goBack();
              }}
              title={`${t("toast.backToPage", { page: viewer.backPage })} (Alt+←)`}
            >
              <ArrowLeft size={12} aria-hidden />
              {t("preview.pageHit", { page: viewer.backPage })}
            </Button>
          )}
          {viewer.canGoForward && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                viewer.goForward();
              }}
              title={`${t("preview.pageHit", { page: viewer.forwardPage })} (Alt+→)`}
            >
              {t("preview.pageHit", { page: viewer.forwardPage })}
              <ArrowRight size={12} aria-hidden />
            </Button>
          )}
        </div>
      )}
      {indexHint &&
        (indexFailed ? (
          // A failed index always offers Retry (for vision_failed — often a
          // transient network error) alongside Settings when actionable. The
          // old settings-only branch hid Retry whenever onOpenAiSettings was
          // present, i.e. always in production.
          <div className="preview-index-badge-row" aria-live="polite">
            <div className="preview-index-badge">{indexHint}</div>
            {showRetryOnVisionFailed && (
              <Button variant="secondary" size="sm" className="preview-index-retry-btn" onClick={retryIndex}>
                {t("preview.retryIndex")}
              </Button>
            )}
            {indexHintActionable && onOpenAiSettings && (
              <Button variant="secondary" size="sm" className="preview-index-retry-btn" onClick={onOpenAiSettings}>
                {t("settings.title")}
              </Button>
            )}
          </div>
        ) : (
          <div className="preview-index-badge" aria-live="polite">
            {indexHint}
          </div>
        ))}
      {doc.kind === "pdf" ? (
        <PageScroller
          doc={doc}
          page={page}
          onPageChange={onPageChange}
          zoom={viewer.zoom}
          quality={viewer.quality}
          onScaleResolved={viewer.onScaleResolved}
          onPinchZoom={viewer.handlePinchZoom}
          scrollTarget={scrollTarget}
          marginColumn={marginColumn}
          containerRef={bindScroller}
          renderOverlays={renderOverlays}
          renderGutter={renderGutter}
        />
      ) : (
        <div className="preview-page-frame">
          <img src={convertFileSrc(doc.path)} alt={doc.name} className="preview-image" />
        </div>
      )}
      {/* What the document is being read as, and the way to stop it (19.0).
          In the chrome rather than on a page: a sweep is the document's, and
          it outlives any one page being scrolled past. */}
      <ReadingLine path={doc.path} onReadRest={onReadRest} />
      {marginColumn && marginAsk?.visible && (
        <div className="margin-ask-stack" onClick={(e) => e.stopPropagation()}>
          {marginAsk.errorMessage && (
            <div className="margin-ask-notice margin-ask-notice-error" role="alert">
              <span className="margin-ask-notice-text">{marginAsk.errorMessage}</span>
              {onOpenAiSettings && (
                <Button variant="ghost" size="sm" onClick={onOpenAiSettings}>
                  {t("settings.title")}
                </Button>
              )}
              {marginAsk.onDismissError && (
                <Button
                  variant="ghost"
                  size="sm"
                  icon
                  aria-label={t("agent.dismissError")}
                  onClick={marginAsk.onDismissError}
                >
                  ×
                </Button>
              )}
            </div>
          )}
          {!marginAsk.busy && marginAsk.reply && (
            <div className="margin-reply-card" role="status" aria-live="polite">
              <p className="margin-reply-text">{marginAsk.reply.text}</p>
              <div className="margin-reply-actions">
                {marginAsk.reply.citedPages.slice(0, 4).map((pNum) => (
                  <Button
                    key={pNum}
                    variant="secondary"
                    size="sm"
                    onClick={() => jumpWithHistory(pNum)}
                  >
                    {t("preview.pageHit", { page: pNum })}
                  </Button>
                ))}
                {onRevealMessage && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onRevealMessage(marginAsk.reply!.messageId)}
                  >
                    {t("gutter.openInChat")}
                  </Button>
                )}
                {marginAsk.onDismissReply && (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon
                    aria-label={t("common.dismiss")}
                    onClick={marginAsk.onDismissReply}
                  >
                    ×
                  </Button>
                )}
              </div>
            </div>
          )}
          <form
            className="margin-ask-bar"
            onSubmit={(e) => {
              e.preventDefault();
              const text = marginAsk.draft.trim();
              if (!text) return;
              marginAsk.onSubmit(text);
            }}
          >
            {marginAsk.busy && (
              <span className="margin-ask-status" aria-live="polite">
                <span className="margin-ask-dot" aria-hidden />
                {marginAsk.progress || t("agent.thinking")}
              </span>
            )}
            <Input
              ref={marginInputRef}
              size="sm"
              className="margin-ask-input"
              value={marginAsk.draft}
              placeholder={marginAsk.busy ? t("agent.placeholderSteer") : t("zen.ask")}
              aria-label={t("zen.ask")}
              onChange={(e) => marginAsk.onDraftChange(e.target.value)}
              onKeyDown={(e) => {
                if (isImeComposing(e)) return;
                if (e.key === "Escape" && marginAsk.onDismiss) {
                  e.stopPropagation();
                  marginAsk.onDismiss();
                }
              }}
            />
            {marginAsk.busy ? (
              <>
                {marginAsk.draft.trim() && (
                  <Button type="submit" variant="secondary" size="sm">
                    {t("agent.steer")}
                  </Button>
                )}
                <Button type="button" variant="ghost" size="sm" onClick={marginAsk.onStop}>
                  {t("agent.stop")}
                </Button>
              </>
            ) : (
              <Button type="submit" variant="primary" size="sm" disabled={!marginAsk.draft.trim()}>
                {t("agent.send")}
              </Button>
            )}
          </form>
        </div>
      )}
    </>
  );

  const hasBottomAsk = Boolean(marginColumn && marginAsk?.visible);

  const toolbar = (
    <PreviewToolbar
      filename={doc.name}
      page={doc.kind === "pdf" ? page : 1}
      totalPages={totalPages}
      pageLabels={doc.pageLabels}
      zoom={viewer.zoom}
      onZoomChange={viewer.handleZoomChange}
      onZoomIn={viewer.zoomIn}
      onZoomOut={viewer.zoomOut}
      zoomDisabled={doc.kind === "image"}
      onPageChange={jumpWithHistory}
      onStepPage={onPageChange}
      canGoBack={viewer.canGoBack}
      backPage={viewer.backPage}
      onGoBack={viewer.goBack}
      thumbsVisible={thumbsVisible}
      onToggleThumbs={toggleThumbs}
      regionMode={regionMode}
      onToggleRegionMode={
        doc.kind === "pdf" ? () => setRegionMode((v) => !v) : undefined
      }
    />
  );

  if (doc.kind === "image") {
    return (
      <div className="preview-panel">
        <DocumentSearch
          doc={doc}
          onJumpToPage={(target, query) => {
            onPageChange(target);
            setSearchHit(query ? { page: target, query } : null);
          }}
          onClearHighlight={() => setSearchHit(null)}
        />
        {toolbar}
        <div
          className={`preview-canvas-wrap image-wrap${hasBottomAsk ? " preview-canvas-has-ask" : ""}`}
          onClick={viewer.focusPreview}
        >
          {canvasBody}
        </div>
      </div>
    );
  }

  // Recovered from the page text when the document was opened; a document with
  // no headings simply has no tab to switch to.
  const outline = usableOutline(doc.outline, doc.totalPages);
  // Derived together, so the two cannot disagree — see `sidebar-tabs.ts` for
  // the two-tabs-selected-at-once bug that is about.
  const { showOutline } = sidebarTabState(sidebarTab, outline.length > 0);
  const sidebarTabs = (
    <Tabs
      items={[
        { id: "pages", label: t("preview.pages") },
        // A document without a recovered outline disables this tab rather than
        // offering one that silently falls back to pages.
        { id: "outline", label: t("preview.outline"), disabled: outline.length === 0 },
      ]}
      value={sidebarTab}
      onChange={setSidebarTab}
    />
  );

  return (
    <div className="preview-panel preview-with-thumbs" ref={panelRef}>
      <DocumentSearch
        doc={doc}
        containerRef={panelRef}
        onJumpToPage={(target, query, matchOnPage) => {
          jumpWithHistory(target);
          setSearchHit(
            query ? { page: target, query, matchOnPage: matchOnPage ?? 0, nonce: Date.now() } : null,
          );
        }}
        onClearHighlight={() => setSearchHit(null)}
      />

      {thumbsVisible &&
        (showOutline ? (
          <OutlineSidebar
            outline={outline}
            currentPage={page}
            pageLabels={doc.pageLabels}
            tabs={sidebarTabs}
            onPageSelect={jumpWithHistory}
          />
        ) : (
          <ThumbnailSidebar
            path={doc.path}
            totalPages={doc.totalPages}
            currentPage={page}
            pageLabels={doc.pageLabels}
            tabs={sidebarTabs}
            onPageSelect={jumpWithHistory}
          />
        ))}

      <div className="preview-main">
        {toolbar}
        <div
          className={`preview-canvas-wrap${hasBottomAsk ? " preview-canvas-has-ask" : ""}`}
          onClick={viewer.focusPreview}
          onPointerDownCapture={(e) => {
            if (doc.kind === "pdf" && e.altKey && e.button === 0 && !regionMode) {
              setAltRegionActive(true);
              if (!altKeyHeld) {
                const slotEl = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-page]");
                const slotPage = slotEl ? Number(slotEl.dataset.page) : NaN;
                if (Number.isInteger(slotPage) && slotPage >= 1) {
                  e.preventDefault();
                  setAltDragSeed({
                    page: slotPage,
                    pointerId: e.pointerId,
                    clientX: e.clientX,
                    clientY: e.clientY,
                    nonce: ++altSeedNonceRef.current,
                  });
                }
              }
            }
          }}
        >
          {canvasBody}
        </div>
      </div>
      {(askButton || markButton) && askSel && !selOffscreen && (
        <div
          className="selection-actions"
          style={clampSelectionAnchor(askSel.x, askSel.y, panelRef.current)}
        >
          {askButton}
          {markButton}
        </div>
      )}
      {!askSel && pendingRegion && (
        <div
          className="selection-actions"
          style={clampSelectionAnchor(pendingRegion.x, pendingRegion.y, panelRef.current)}
        >
          {onAskAboutSelection && (
            <Button
              variant="primary"
              size="md"
              className="ask-selection-btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                const region = pendingRegion;
                setPendingRegion(null);
                const prompt = region.text.trim()
                  ? `[${t("preview.pageTitle", { page: region.page })}] "${region.text.trim()}"`
                  : t("preview.askAboutRegion", { page: region.page });
                onAskAboutSelection(prompt);
              }}
            >
              {t("preview.askAboutSelection")}
            </Button>
          )}
          <Button
            variant="secondary"
            size="md"
            className="mark-selection-btn"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              const region = pendingRegion;
              setPendingRegion(null);
              const mark = addMark(doc.path, {
                page: region.page,
                rects: [region.pdfRect],
                text: region.text,
                stamp: doc.stamp ?? "",
                kind: "region",
              });
              if (!mark) showToast(t("marks.capReached"), "error");
            }}
          >
            {t("marks.markSelection")}
          </Button>
          <Button
            variant="secondary"
            size="md"
            className="mark-selection-btn"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              const region = pendingRegion;
              setPendingRegion(null);
              const mark = addMark(doc.path, {
                page: region.page,
                rects: [region.pdfRect],
                text: region.text,
                stamp: doc.stamp ?? "",
                kind: "region",
              });
              if (mark) onSelectMark?.(mark.id);
              else showToast(t("marks.capReached"), "error");
            }}
          >
            {t("marks.noteSelection")}
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={pendingLink !== null}
        message={t("preview.openLinkConfirm", { url: displayUrl(pendingLink ?? "") })}
        confirmLabel={t("preview.openLinkAction")}
        onConfirm={() => {
          const url = pendingLink;
          setPendingLink(null);
          if (url) void openUrl(url);
        }}
        onCancel={() => setPendingLink(null)}
      />
    </div>
  );
}

export const PreviewPane = memo(PreviewPaneInner);
