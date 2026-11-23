import type { PdfRect } from "./types";

export interface ActiveReaderSelection {
  path: string;
  page: number;
  text: string;
  kind: "text" | "region";
  /** Top-left `Frame::View` coordinates in PDF points (as `clientRectToPageRect` produces). */
  pdfRect?: PdfRect;
  /** True when the user clicked "Ask about this" to seed the composer draft. */
  pinnedForDraft?: boolean;
}

let currentSelection: ActiveReaderSelection | null = null;
let pinnedDraftSelection: ActiveReaderSelection | null = null;

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

/**
 * Preserve a snapshot of the active text/region selection when "Ask about this"
 * clears the live overlay to populate the composer draft, so `prepareCall` and
 * `read_figure` still receive the exact boxed coordinates when the user hits Enter (30.0).
 */
export function pinActiveReaderSelectionForDraft(sel: ActiveReaderSelection): void {
  if (!sel.text.trim() && sel.kind !== "region") return;
  pinnedDraftSelection = {
    ...sel,
    text: sel.text.trim().slice(0, 2_400),
    pinnedForDraft: true,
  };
}

export function consumePinnedDraftSelection(path: string | null): ActiveReaderSelection | null {
  if (!path || !pinnedDraftSelection || pinnedDraftSelection.path !== path) return null;
  const taken = pinnedDraftSelection;
  pinnedDraftSelection = null;
  return taken;
}

export function getActiveReaderSelection(path: string | null): ActiveReaderSelection | null {
  if (!path) return null;
  if (currentSelection && currentSelection.path === path) return currentSelection;
  if (pinnedDraftSelection && pinnedDraftSelection.path === path) return pinnedDraftSelection;
  return null;
}

export function clearActiveReaderSelection(onlyPath?: string): void {
  if (onlyPath === undefined || currentSelection?.path === onlyPath) {
    currentSelection = null;
  }
  if (onlyPath === undefined || pinnedDraftSelection?.path === onlyPath) {
    pinnedDraftSelection = null;
  }
}
