import { useEffect, useMemo, useRef, useState } from "react";

type WordSegmenter = { segment(input: string): Iterable<{ segment: string }> };

function resolveSegmenter(): WordSegmenter | undefined {
  const IntlWithSegmenter = Intl as typeof Intl & {
    Segmenter?: new (
      locales?: string | string[],
      options?: { granularity?: "grapheme" | "word" | "sentence" },
    ) => WordSegmenter;
  };
  if (typeof IntlWithSegmenter.Segmenter === "function") {
    return new IntlWithSegmenter.Segmenter(undefined, { granularity: "word" });
  }
  return undefined;
}

let sharedSegmenter: WordSegmenter | null | undefined;
function getSegmenter(): WordSegmenter | null {
  if (sharedSegmenter !== undefined) return sharedSegmenter;
  sharedSegmenter = resolveSegmenter() ?? null;
  return sharedSegmenter;
}

/** Split text into reveal units (locale-aware for CJK). */
export function splitStreamSegments(text: string): string[] {
  if (!text) return [];
  const segmenter = getSegmenter();
  if (segmenter) {
    return [...segmenter.segment(text)].map((part) => part.segment);
  }
  return [...text];
}

/**
 * Progressively reveal streamed text on the client.
 * Providers often batch the final answer into one delta; this keeps UI motion smooth
 * while segmenting incrementally in O(delta) instead of O(N²) (29.0).
 */
export function useStreamingReveal(text: string, live: boolean): string {
  const cacheRef = useRef<{ raw: string; segments: string[] }>({ raw: "", segments: [] });
  const segments = useMemo(() => {
    if (!live) {
      cacheRef.current = { raw: "", segments: [] };
      return text ? [text] : [];
    }
    const prev = cacheRef.current;
    // Incremental append: keep all segments except the last boundary word and only segment the new tail!
    if (prev.raw.length > 0 && text.startsWith(prev.raw) && prev.segments.length >= 2) {
      const stableSegs = prev.segments.slice(0, -1);
      const stableCharLen = prev.raw.length - prev.segments[prev.segments.length - 1]!.length;
      const tailSegs = splitStreamSegments(text.slice(stableCharLen));
      const next = [...stableSegs, ...tailSegs];
      cacheRef.current = { raw: text, segments: next };
      return next;
    }
    const fresh = splitStreamSegments(text);
    cacheRef.current = { raw: text, segments: fresh };
    return fresh;
  }, [text, live]);
  const [visibleCount, setVisibleCount] = useState(() =>
    live ? 0 : segments.length,
  );

  // Read segments through a ref inside the ticker: making the timer depend on
  // the text would reset it on every delta, so a fast stream (chunks < 12 ms
  // apart) would starve the reveal and the live bubble would render empty
  // exactly when text is arriving fastest.
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;
  // Holds the running ticker so a new-text effect run re-arms it WITHOUT
  // clearing a timer that's already ticking (which would reintroduce the
  // starvation bug on fast streams).
  const tickerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopTicker = () => {
    if (tickerRef.current !== null) {
      window.clearInterval(tickerRef.current);
      tickerRef.current = null;
    }
  };

  // Manage the ticker from the body (no re-run cleanup, so a delta never resets
  // a running timer → no starvation). A dedicated unmount effect below prevents
  // a leak when live is still true at teardown.
  useEffect(() => {
    if (!live) {
      stopTicker();
      setVisibleCount(segmentsRef.current.length);
      return;
    }
    if (visibleCount >= segments.length) return; // caught up; ticker self-stopped
    if (tickerRef.current !== null) return; // already ticking — don't restart

    tickerRef.current = window.setInterval(() => {
      setVisibleCount((current) => {
        const total = segmentsRef.current.length;
        if (current >= total) {
          stopTicker(); // stop waking until new text re-arms us
          return current;
        }
        const backlog = total - current;
        const step = backlog > 32 ? 8 : backlog > 10 ? 4 : 2;
        return Math.min(total, current + step);
      });
    }, 24);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, segments.length, visibleCount]);

  useEffect(() => stopTicker, []);

  useEffect(() => {
    if (!live) return;
    if (visibleCount > segments.length) {
      setVisibleCount(segments.length);
    }
  }, [live, segments.length, visibleCount]);

  if (!live) return text;
  if (visibleCount >= segments.length) return text;
  return segments.slice(0, visibleCount).join("");
}
