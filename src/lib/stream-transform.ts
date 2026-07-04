import { smoothStream } from "ai";

type WordSegmenter = { segment(input: string): Iterable<{ segment: string }> };

let cjkSegmenter: WordSegmenter | undefined;

function resolveCjkSegmenter(): WordSegmenter | undefined {
  if (cjkSegmenter) return cjkSegmenter;
  const IntlWithSegmenter = Intl as typeof Intl & {
    Segmenter?: new (
      locales?: string | string[],
      options?: { granularity?: "grapheme" | "word" | "sentence" },
    ) => WordSegmenter;
  };
  if (typeof IntlWithSegmenter.Segmenter === "function") {
    cjkSegmenter = new IntlWithSegmenter.Segmenter(undefined, { granularity: "word" });
  }
  return cjkSegmenter;
}

/**
 * Streaming transform for chat: locale-aware chunking without artificial delay.
 * Word-regex chunking buffers CJK text until flush; Segmenter releases per grapheme/word.
 */
export function resolveStreamingTransform() {
  const segmenter = resolveCjkSegmenter();
  if (segmenter) {
    return smoothStream({ chunking: segmenter, delayInMs: null });
  }
  return smoothStream({ chunking: "line", delayInMs: null });
}
