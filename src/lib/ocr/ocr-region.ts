/**
 * The recognised words inside a rectangle the reader drew on a scan (14.0).
 *
 * On a page with a text layer the extractor reads a region; on a scan it has
 * nothing to read, and a region mark used to carry no text at all. OCR's
 * words do have positions, so the region's text is the words whose centres
 * fall inside it, in reading order.
 *
 * The rectangle arrives in the frame a mark is stored in — offset from the
 * page's visible box, top-left origin (`clientRectToPageRect`) — and the words
 * in absolute PDF space, bottom-left origin. `view` is what converts between
 * them.
 */
import type { PageGeometry } from "../pdf";
import type { PdfRect, TextItemRect } from "../types";
import { joinWords } from "./ocr-result";

export interface ViewportLike {
  width: number;
  height: number;
  convertToViewportPoint(x: number, y: number): [number, number];
  convertToViewportRectangle?(rect: [number, number, number, number]): number[];
}

export interface PdfPageViewportSource {
  getViewport(params: { scale: number }): ViewportLike;
  view?: readonly number[];
}

function isPageSource(v: unknown): v is PdfPageViewportSource {
  return Boolean(
    v &&
      typeof v === "object" &&
      "getViewport" in v &&
      typeof (v as PdfPageViewportSource).getViewport === "function",
  );
}

function isGeometry(
  v: unknown,
): v is Pick<PageGeometry, "viewportWidth" | "viewportHeight" | "toViewportPoint"> {
  return Boolean(v && typeof v === "object" && "toViewportPoint" in v);
}

function projectPdfRect(
  rect: [number, number, number, number],
  vp: ViewportLike | Pick<PageGeometry, "viewportWidth" | "viewportHeight" | "toViewportPoint">,
): { x: number; y: number; width: number; height: number } {
  if (!isGeometry(vp) && typeof vp.convertToViewportRectangle === "function") {
    const [x1, y1, x2, y2] = vp.convertToViewportRectangle(rect);
    const x = Math.min(x1!, x2!);
    const y = Math.min(y1!, y2!);
    return { x, y, width: Math.abs(x2! - x1!), height: Math.abs(y2! - y1!) };
  }
  const toVp = isGeometry(vp)
    ? vp.toViewportPoint
    : (x: number, y: number) => vp.convertToViewportPoint(x, y);
  const [ax, ay] = toVp(rect[0], rect[1]);
  const [bx, by] = toVp(rect[2], rect[3]);
  const x = Math.min(ax, bx);
  const y = Math.min(ay, by);
  return { x, y, width: Math.abs(bx - ax), height: Math.abs(by - ay) };
}

export function pdfRectToViewportCrop(
  rect: PdfRect,
  pageOrViewport: PdfPageViewportSource | ViewportLike,
  options: {
    scale?: number;
    frame?: "pdf" | "view";
    view?: readonly [number, number, number, number];
  } = {},
): PdfRect {
  const scale = options.scale ?? 1;
  const vp = isPageSource(pageOrViewport) ? pageOrViewport.getViewport({ scale }) : pageOrViewport;
  let x1 = rect.x;
  let y1 = rect.y;
  let x2 = rect.x + rect.width;
  let y2 = rect.y + rect.height;
  if (options.frame === "view") {
    const rawView =
      options.view ?? (isPageSource(pageOrViewport) ? pageOrViewport.view : undefined);
    const viewLeft = rawView?.[0] ?? 0;
    const viewTop = rawView?.[3] ?? vp.height / Math.max(scale, 1e-6);
    x1 = rect.x + viewLeft;
    x2 = x1 + rect.width;
    y2 = viewTop - rect.y;
    y1 = y2 - rect.height;
  }
  const box = projectPdfRect([x1, y1, x2, y2], vp);
  const x = Math.max(0, Math.min(vp.width, box.x));
  const y = Math.max(0, Math.min(vp.height, box.y));
  const width = Math.max(0, Math.min(box.width, vp.width - x));
  const height = Math.max(0, Math.min(box.height, vp.height - y));
  return { x, y, width, height };
}

export function wordsInRegion(
  items: readonly TextItemRect[],
  region: PdfRect,
  view: readonly [number, number, number, number],
  viewportOrPage?:
    | PdfPageViewportSource
    | ViewportLike
    | Pick<PageGeometry, "viewportWidth" | "viewportHeight" | "toViewportPoint">,
): string {
  const [viewLeft, , , viewTop] = view;
  const left = region.x + viewLeft;
  const right = left + region.width;
  const top = viewTop - region.y;
  const bottom = top - region.height;

  if (viewportOrPage) {
    const vp = isPageSource(viewportOrPage)
      ? viewportOrPage.getViewport({ scale: 1 })
      : viewportOrPage;
    const target = projectPdfRect([left, bottom, right, top], vp);
    const projected = items
      .map((it) => ({
        text: it.text,
        box: projectPdfRect(
          [it.rect.x, it.rect.y, it.rect.x + it.rect.width, it.rect.y + it.rect.height],
          vp,
        ),
      }))
      .filter(({ box }) => {
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        return (
          cx >= target.x &&
          cx <= target.x + target.width &&
          cy >= target.y &&
          cy <= target.y + target.height
        );
      });

    const sorted = [...projected].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
    const lines: (typeof projected)[] = [];
    for (const w of sorted) {
      const cy = w.box.y + w.box.height / 2;
      const line = lines.find((l) => {
        const f = l[0]!;
        return (
          Math.abs(f.box.y + f.box.height / 2 - cy) <= Math.max(f.box.height, w.box.height) / 2
        );
      });
      if (line) line.push(w);
      else lines.push([w]);
    }
    return lines
      .map((l) => l.sort((a, b) => a.box.x - b.box.x).reduce((acc, w) => joinWords(acc, w.text), ""))
      .join("\n");
  }

  const inside = items.filter((it) => {
    const cx = it.rect.x + it.rect.width / 2;
    const cy = it.rect.y + it.rect.height / 2;
    return cx >= left && cx <= right && cy >= bottom && cy <= top;
  });

  const sorted = [...inside].sort((a, b) => b.rect.y + b.rect.height - (a.rect.y + a.rect.height));
  const lines: TextItemRect[][] = [];
  for (const w of sorted) {
    const cy = w.rect.y + w.rect.height / 2;
    const line = lines.find((l) => {
      const f = l[0]!;
      return Math.abs(f.rect.y + f.rect.height / 2 - cy) <= Math.max(f.rect.height, w.rect.height) / 2;
    });
    if (line) line.push(w);
    else lines.push([w]);
  }
  return lines
    .map((l) => l.sort((a, b) => a.rect.x - b.rect.x).reduce((acc, w) => joinWords(acc, w.text), ""))
    .join("\n");
}
