/**
 * Which of the page sidebar's three panels is showing.
 *
 * Pulled out of `PreviewPane` because it was wrong there and nothing could say
 * so. The Pages tab was selected on `!showOutline`, which is also true while
 * the Marks tab is open — so two tabs in one tablist carried
 * `aria-selected="true"` and both drew as selected. It survived because
 * "selected" was a faint wash; the moment the app was given one filled
 * treatment for the idea, it was the first thing on screen.
 *
 * Three booleans derived independently from one state variable will always be
 * able to disagree. Derived together, in a function that returns all three,
 * they cannot — and `exactly one is true` is then something a test can assert
 * for every input rather than something a reader has to check by eye.
 */
export type SidebarTab = "pages" | "outline" | "marks";

export interface SidebarTabState {
  showPages: boolean;
  showOutline: boolean;
  showMarks: boolean;
}

/**
 * `hasOutline` is false for a document with no bookmarks and no headings the
 * extractor could recover. Its tab is disabled in that case, and asking for it
 * anyway falls back to Pages rather than showing an empty panel — the same
 * fallback the panel below the tabs already made.
 */
export function sidebarTabState(tab: SidebarTab, hasOutline: boolean): SidebarTabState {
  const showOutline = tab === "outline" && hasOutline;
  const showMarks = tab === "marks";
  return { showPages: !showOutline && !showMarks, showOutline, showMarks };
}
