import { generateVisionText } from "./vision-api";
import { loadVisionSettings } from "./settings";
import { assertApiKeyForAgent } from "./llm";
import { recordVisionCall } from "./usage-tracker";
import { renderRegionToJpegBytes } from "./pdf";
import type { DocFigure } from "./types";

/** A figure smaller than this is a rule, a bullet or a logo — not a figure. */
const MIN_FIGURE_POINTS = 24;

const FIGURE_PROMPT =
  "Describe this figure from a document: what it shows, and any text, labels, " +
  "axes or values visible in it. If it is a chart, state what is being compared " +
  "and the values you can read. Be specific and do not speculate beyond the image.";

/** Timeout mirrors background indexing: the same model, the same kind of call. */
const FIGURE_TIMEOUT_MS = 60_000;

/**
 * Figures worth offering the model, largest first.
 *
 * Documents embed decorative images — rules, bullets, logos — that cost a
 * billed call and describe nothing. Ordering by area means index 1 is the
 * figure a reader would call "the figure on this page".
 */
export function figuresOnPage(figures: DocFigure[] | undefined, page: number): DocFigure[] {
  return (figures ?? [])
    .filter(
      (f) =>
        f.page === page &&
        f.rect.width >= MIN_FIGURE_POINTS &&
        f.rect.height >= MIN_FIGURE_POINTS,
    )
    .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height);
}

/**
 * Send one figure to the vision model and return what it says.
 *
 * The whole page would otherwise go — the figure diluted by the surrounding
 * prose, at a larger image and a higher cost.
 */
export async function describeFigure(
  path: string,
  page: number,
  figure: DocFigure,
  signal?: AbortSignal,
): Promise<string> {
  const settings = await loadVisionSettings();
  assertApiKeyForAgent(settings);

  const bytes = await renderRegionToJpegBytes(path, page, figure.rect, 1568, 0.85, signal);
  recordVisionCall(path);

  const fetchSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(FIGURE_TIMEOUT_MS)])
    : AbortSignal.timeout(FIGURE_TIMEOUT_MS);

  return (
    await generateVisionText(settings, FIGURE_PROMPT, bytes, {
      signal: fetchSignal,
      mediaType: "image/jpeg",
      attributeUsage: true,
    })
  ).trim();
}
