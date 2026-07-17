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

/** Split text into reveal units (locale-aware for CJK). */
export function splitStreamSegments(text: string): string[] {
  if (!text) return [];
  const segmenter = resolveSegmenter();
  if (segmenter) {
    return [...segmenter.segment(text)].map((part) => part.segment);
  }
  return [...text];
}

/**
 * Progressively reveal streamed text on the client.
 * Providers often batch the final answer into one delta; this keeps UI motion smooth.
 */
export function useStreamingReveal(text: string, live: boolean): string {
  const segments = useMemo(() => splitStreamSegments(text), [text]);
  const [visibleCount, setVisibleCount] = useState(() =>
    live ? 0 : segments.length,
  );

  // Read segments through a ref inside the ticker: making the timer depend on
  // the text would reset it on every delta, so a fast stream (chunks < 12 ms
  // apart) would starve the reveal and the live bubble would render empty
  // exactly when text is arriving fastest.
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;

  useEffect(() => {
    if (!live) {
      setVisibleCount(segmentsRef.current.length);
      return;
    }
    const id = window.setInterval(() => {
      setVisibleCount((current) => {
        const total = segmentsRef.current.length;
        if (current >= total) return current;
        const backlog = total - current;
        const step = backlog > 48 ? 6 : backlog > 16 ? 3 : 1;
        return Math.min(total, current + step);
      });
    }, 12);

    return () => window.clearInterval(id);
  }, [live]);

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
