import { generateVisionText } from "./vision-api";
import { loadVisionSettings } from "./settings";
import { assertApiKeyForAgent } from "./llm";
import { recordVisionCall } from "./usage-tracker";
import {
  getPageGeometry,
  readAuthorizedFileBytes,
  renderPageToJpegBytes,
  renderRegionToJpegBytes,
} from "./pdf";
import { ensureProviderCompatibleImage } from "./image-transcode";
import { sniffImageType } from "./file-type";
import type { DocFigure, LoadedDocument } from "./types";

/** A figure smaller than this is a rule, a bullet or a logo — not a figure. */
const MIN_FIGURE_POINTS = 24;

const FIGURE_PROMPT =
  "Describe this figure from a document: what it shows, and any text, labels, " +
  "axes or values visible in it. If it is a chart, state what is being compared " +
  "and the values you can read. Be specific and do not speculate beyond the image.";

const FIGURE_TIMEOUT_MS = 60_000;
const FIGURE_MAX_EDGE = 1_568;
const FIGURE_QUALITY = 0.85;

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

function buildFigurePrompt(question?: string): string {
  const q = question?.trim();
  return q ? `${FIGURE_PROMPT}\n\nFocus specifically on answering: ${q}` : FIGURE_PROMPT;
}

/** Convert a top-left `Frame::View` selection rectangle into bottom-left PDF user space. */
export async function viewRectToPdfRect(
  path: string,
  page: number,
  viewRect: DocFigure["rect"],
): Promise<DocFigure["rect"]> {
  const geom = await getPageGeometry(path, page);
  const [viewLeft, , , viewTop] = geom.view;
  return {
    x: viewLeft + viewRect.x,
    y: viewTop - viewRect.y - viewRect.height,
    width: viewRect.width,
    height: viewRect.height,
  };
}

export async function describeFigure(
  path: string,
  page: number,
  figure: DocFigure,
  signal?: AbortSignal,
  question?: string,
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
    await generateVisionText(settings, buildFigurePrompt(question), bytes, {
      signal: fetchSignal,
      mediaType: "image/jpeg",
      attributeUsage: true,
    })
  ).trim();
}

/**
 * Inspect either an embedded figure crop or — when a page draws vector plots,
 * formulas, or diagrams without an XObject bitmap — the full rendered page.
 */
export async function describeFigureOrPage(
  path: string,
  doc: Pick<LoadedDocument, "kind">,
  page: number,
  figure: DocFigure | undefined,
  question?: string,
  signal?: AbortSignal,
): Promise<string> {
  if (figure) {
    return describeFigure(path, page, figure, signal, question);
  }

  const settings = await loadVisionSettings();
  assertApiKeyForAgent(settings);

  let bytes: Uint8Array;
  let mediaType = "image/jpeg";
  if (doc.kind === "image") {
    const raw = await readAuthorizedFileBytes(path, signal);
    const compatible = await ensureProviderCompatibleImage(
      raw,
      sniffImageType(raw) ?? "image/jpeg",
    );
    bytes = compatible.bytes;
    mediaType = compatible.mediaType;
  } else {
    bytes = await renderPageToJpegBytes(
      path,
      page,
      FIGURE_MAX_EDGE,
      FIGURE_QUALITY,
      signal,
    );
  }
  recordVisionCall(path);

  const fetchSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(FIGURE_TIMEOUT_MS)])
    : AbortSignal.timeout(FIGURE_TIMEOUT_MS);

  return (
    await generateVisionText(settings, buildFigurePrompt(question), bytes, {
      signal: fetchSignal,
      mediaType,
      attributeUsage: true,
    })
  ).trim();
}
