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
 * The render a figure gets: 1,568px on its long edge, JPEG q0.85 — the only
 * place the larger render survives, and the number is the reason.
 *
 * A figure is read for what a page render cannot give it. The page path sends
 * 1,024px for the whole page; a figure occupying 416pt of a letter page —
 * measured on `eval/corpus/fetched/geobase-data-model.pdf`, page 13, a UML
 * diagram of labelled boxes — is only ~538px across inside that render, versus
 * 1,568px here (2.9× the resolution per axis, 8.5× the pixels). That is the
 * difference between reading a class name and guessing one, on the call whose
 * entire purpose is the labels and values the text layer does not carry.
 *
 * What it costs, measured the same way (pypdfium2 + Pillow, the OCR eval's
 * method): the crop encodes to 288 KB here against 146 KB at the page path's
 * 1,024/q0.80 — 2.0×, in the same band as the page render's own 2.0–2.2×,
 * and against 82 KB for a whole page at 1,024. It is one deliberate call per
 * figure, drawn from the question's scan allowance, and the background sweep
 * never takes this path.
 */
const FIGURE_MAX_EDGE = 1_568;
const FIGURE_QUALITY = 0.85;

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
 * Pages carrying a figure worth looking at.
 *
 * `read_figure` was added without anything telling the model when to use it:
 * the outline reported pages with tables but never pages with figures, so the
 * tool could only be reached by guessing. Same size filter as the reader, so a
 * page is never advertised as having a figure the reader would then skip.
 */
export function pagesWithFigures(figures: DocFigure[] | undefined): number[] {
  const pages = new Set<number>();
  for (const figure of figures ?? []) {
    if (
      figure.rect.width >= MIN_FIGURE_POINTS &&
      figure.rect.height >= MIN_FIGURE_POINTS
    ) {
      pages.add(figure.page);
    }
  }
  return [...pages].sort((a, b) => a - b);
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

  const bytes = await renderRegionToJpegBytes(
    path,
    page,
    figure.rect,
    FIGURE_MAX_EDGE,
    FIGURE_QUALITY,
    signal,
  );
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
