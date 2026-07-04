import { useEffect, useMemo, useState } from "react";

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

  useEffect(() => {
    if (!live) {
      setVisibleCount(segments.length);
      return;
    }
    if (visibleCount >= segments.length) return;

    const backlog = segments.length - visibleCount;
    const step = backlog > 48 ? 6 : backlog > 16 ? 3 : 1;
    const id = window.setTimeout(() => {
      setVisibleCount((current) => Math.min(segments.length, current + step));
    }, 12);

    return () => window.clearTimeout(id);
  }, [live, segments.length, visibleCount, segments]);

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
