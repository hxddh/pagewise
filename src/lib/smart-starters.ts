import { getMarks } from "./mark-store";
import { activeHeadingIndex, usableOutline } from "./outline-nav";
import type { LoadedDocument } from "./types";

type TranslateFn = (key: string, vars?: Record<string, string | number>) => string;

function clipTitle(raw: string, max = 28): string {
  const clean = raw.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Deterministic, zero-LLM contextual starter prompts for the open document (29.0).
 *
 * Synthesizes three concrete questions from structure already extracted locally:
 * the heading at `previewPage`, tables/figures/annotations in the PDF, and any
 * highlights the reader has already made. Falls back cleanly to page/document
 * starters when a document has no headings or structured elements.
 */
export function buildSmartStarters(
  doc: LoadedDocument | null | undefined,
  previewPage: number | undefined,
  totalPages: number | undefined,
  t: TranslateFn,
): string[] {
  const pages = totalPages ?? doc?.totalPages ?? 0;
  const current = previewPage && previewPage > 0 ? previewPage : 0;

  if (!doc) {
    return [
      current > 0
        ? t("empty.exampleThisPage", { page: current })
        : pages > 1
          ? t("empty.exampleWholeDoc", { count: pages })
          : t("empty.example1"),
      t("empty.example3"),
      t("empty.example2"),
    ];
  }

  const outline = doc.kind === "pdf" ? usableOutline(doc.outline, doc.totalPages) : [];
  const headingIdx = current > 0 && outline.length > 0 ? activeHeadingIndex(outline, current) : -1;
  const currentHeading = headingIdx >= 0 ? outline[headingIdx] : undefined;

  const first =
    current > 0 && currentHeading && currentHeading.page === current
      ? t("empty.starterSection", {
          page: current,
          title: clipTitle(currentHeading.title),
        })
      : current > 0
        ? t("empty.exampleThisPage", { page: current })
        : pages > 1
          ? t("empty.exampleWholeDoc", { count: pages })
          : t("empty.example1");

  let second = t("empty.example3");
  const annotCount = doc.annotations?.length ?? 0;
  const tablePages = doc.tablePages ?? [];
  const topHeadings = outline.filter((h) => h.level <= 2);
  if (annotCount > 0) {
    second = t("empty.starterAnnotations", { count: annotCount });
  } else if (tablePages.length > 0) {
    const nearTable =
      tablePages.find((p) => p === current) ??
      tablePages.find((p) => p > current) ??
      tablePages[0]!;
    second = t("empty.starterTables", { page: nearTable });
  } else if (topHeadings.length >= 2) {
    second = t("empty.starterOutline", {
      first: clipTitle(topHeadings[0]!.title, 18),
      second: clipTitle(topHeadings[1]!.title, 18),
    });
  }

  let third = t("empty.example2");
  const marks = getMarks(doc.path);
  const figures = doc.figures ?? [];
  if (marks.length > 0) {
    third = t("empty.starterMarks", { count: marks.length });
  } else if (figures.length > 0) {
    const nearFig =
      figures.find((f) => f.page === current) ??
      figures.find((f) => f.page > current) ??
      figures[0]!;
    third = t("empty.starterFigures", { page: nearFig.page });
  }

  // Deduplicate in case two slots resolved to the same string.
  const unique: string[] = [];
  for (const item of [first, second, third, t("empty.example3"), t("empty.example2"), t("empty.example1")]) {
    if (!unique.includes(item)) unique.push(item);
    if (unique.length === 3) break;
  }
  return unique;
}
