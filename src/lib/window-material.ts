import { Effect, getCurrentWindow, type Color } from "@tauri-apps/api/window";
import type { ResolvedTheme } from "./preferences";

/**
 * The window's own background, so a launch is not a flash of the wrong colour.
 *
 * Tauri paints the window before the webview has drawn anything. Without this
 * that first frame is the platform default — a white rectangle for a dark app —
 * and a reader watching the window appear sees it flicker. It is also the
 * colour the material sits on.
 */
const WINDOW_BACKGROUND: Record<ResolvedTheme, string> = {
  dark: "#09090b",
  light: "#fafafa",
  paper: "#f6f2ea",
};

/**
 * The materials to ask for, in order.
 *
 * Tauri applies the first one the platform supports and ignores the rest, so
 * this is one list rather than a platform switch: `Sidebar` and
 * `UnderWindowBackground` are macOS vibrancy, `Mica` is Windows 11 (the light
 * and dark variants follow the system appearance).
 *
 * Linux has no equivalent, and this module does nothing there — the app's own
 * opaque surfaces are the design, not a fallback.
 */
const EFFECTS = [Effect.Sidebar, Effect.UnderWindowBackground, Effect.Mica, Effect.Tabbed];

/** Whether this platform can have a material at all. */
function platformSupportsMaterial(): boolean {
  if (typeof navigator === "undefined") return false;
  // The webview reports its own platform; there is no OS plugin in this build.
  return /Macintosh|Windows/.test(navigator.userAgent);
}

/**
 * Put the window on real material (18.0).
 *
 * Called at boot and on every theme change: the background colour is theme
 * dependent, and the CSS that lets the material through is gated on
 * `data-material`, which is only set when the effect actually took.
 *
 * Nothing here is load-bearing. Where the effect is unavailable — Linux, a
 * shell without the permission, a browser harness — the attribute is absent,
 * every surface keeps its opaque colour, and the app looks exactly as it did
 * before this module existed.
 */
export async function applyWindowMaterial(theme: ResolvedTheme): Promise<void> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  const win = getCurrentWindow();
  try {
    await win.setBackgroundColor(WINDOW_BACKGROUND[theme] as Color);
  } catch {
    // No permission or no support: the CSS background is already correct.
  }
  if (!platformSupportsMaterial()) return;
  try {
    await win.setEffects({ effects: EFFECTS });
    document.documentElement.dataset.material = "on";
  } catch {
    delete document.documentElement.dataset.material;
  }
}
