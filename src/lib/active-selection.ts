import type { PdfRect } from "./types";

export interface ActiveReaderSelection {
  path: string;
  page: number;
  text: string;
  kind: "text" | "region";
  pdfRect?: PdfRect;
}

let currentSelection: ActiveReaderSelection | null = null;

export function setActiveReaderSelection(sel: ActiveReaderSelection | null): void {
  if (!sel || (!sel.text.trim() && sel.kind !== "region")) {
    currentSelection = null;
    return;
  }
  currentSelection = {
    ...sel,
    text: sel.text.trim().slice(0, 2_400),
  };
}

export function getActiveReaderSelection(path: string | null): ActiveReaderSelection | null {
  if (!path || !currentSelection || currentSelection.path !== path) return null;
  return currentSelection;
}

export function clearActiveReaderSelection(onlyPath?: string): void {
  if (!currentSelection) return;
  if (onlyPath === undefined || currentSelection.path === onlyPath) {
    currentSelection = null;
  }
}
