import type { PdfRect } from "./types";

/**
 * Ephemeral bidirectional hover highlight state (29.0).
 *
 * Hovering a citation chip in an answer, an entry in the Record ledger, or a
 * dot/card in the page margin illuminates the corresponding passage on any
 * visible PDF page without scrolling or stealing focus.
 */
export type HoveredHighlight =
  | {
      kind: "citation";
      path: string;
      page: number;
      rects: PdfRect[];
      secondPage?: { page: number; rects: PdfRect[] };
    }
  | {
      kind: "finding";
      path: string;
      id: string;
    }
  | {
      kind: "mark";
      path: string;
      id: string;
    };

let current: HoveredHighlight | null = null;
const listeners = new Set<() => void>();

export function getHoveredHighlight(): HoveredHighlight | null {
  return current;
}

export function subscribeHoveredHighlight(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setHoveredHighlight(next: HoveredHighlight | null): void {
  if (current === next) return;
  current = next;
  for (const fn of [...listeners]) fn();
}

export function clearHoveredHighlight(path?: string): void {
  if (!current) return;
  if (path !== undefined && current.path !== path) return;
  current = null;
  for (const fn of [...listeners]) fn();
}
