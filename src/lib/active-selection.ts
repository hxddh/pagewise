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
let activeRunSelection: ActiveReaderSelection | null = null;

export function setActiveReaderSelection(sel: ActiveReaderSelection | null): void {
  if (!sel || (!sel.text.trim() && sel.kind !== "region")) {
    currentSelection = null;
    return;
  }
  if (pinnedDraftSelection?.path === sel.path) {
    pinnedDraftSelection = null;
  }
  currentSelection = {
    ...sel,
    text: sel.text.trim().slice(0, 2_400),
  };
}

/**
 * Preserve a one-shot snapshot of the active text/region selection when "Ask about this"
 * clears the live overlay to populate the composer draft. Transferred into run-scoped
 * state when that question is sent and retired once the question finishes (30.0).
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

/** Live selection currently visible on screen (never returns an unconsumed draft pin). */
export function getActiveReaderSelection(path: string | null): ActiveReaderSelection | null {
  if (!path) return null;
  if (currentSelection && currentSelection.path === path) return currentSelection;
  return null;
}

/** Live selection or the run-scoped selection captured for the active question (`read_figure`). */
export function getRunOrActiveReaderSelection(path: string | null): ActiveReaderSelection | null {
  if (!path) return null;
  if (currentSelection && currentSelection.path === path) return currentSelection;
  if (activeRunSelection && activeRunSelection.path === path) return activeRunSelection;
  return null;
}

export function setRunReaderSelection(sel: ActiveReaderSelection | null): void {
  activeRunSelection = sel;
}

export function clearRunReaderSelection(onlyPath?: string): void {
  if (onlyPath === undefined || activeRunSelection?.path === onlyPath) {
    activeRunSelection = null;
  }
}

/**
 * Resolve the selection belonging to a newly submitted question on `path` while viewing
 * `viewingPage`: prefers a live selection on `viewingPage`, else consumes the one-shot
 * pinned draft selection (`pinnedDraftSelection = null`) into `activeRunSelection`.
 */
export function takeReaderSelectionForTurn(
  path: string | null,
  viewingPage: number,
): ActiveReaderSelection | null {
  if (!path) {
    activeRunSelection = null;
    return null;
  }
  const live = getActiveReaderSelection(path);
  if (live && (viewingPage <= 0 || live.page === viewingPage)) {
    if (pinnedDraftSelection?.path === path) pinnedDraftSelection = null;
    activeRunSelection = live;
    return live;
  }
  const pinned = consumePinnedDraftSelection(path);
  activeRunSelection = pinned;
  return pinned;
}

export function clearActiveReaderSelection(onlyPath?: string): void {
  if (onlyPath === undefined || currentSelection?.path === onlyPath) {
    currentSelection = null;
  }
  if (onlyPath === undefined || pinnedDraftSelection?.path === onlyPath) {
    pinnedDraftSelection = null;
  }
  if (onlyPath === undefined || activeRunSelection?.path === onlyPath) {
    activeRunSelection = null;
  }
}
