const KEY = "pagewise.recentCommands";
const MAX = 5;

/** Best-effort localStorage write; swallows quota / privacy-restricted WebView errors. */
function safeSetItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore: storage may be full or disabled; hints are non-critical.
  }
}

export function recordCommand(id: string): void {
  const prev = loadRecentCommandIds();
  const next = [id, ...prev.filter((x) => x !== id)].slice(0, MAX);
  safeSetItem(KEY, JSON.stringify(next));
}

export function loadRecentCommandIds(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function hasSeenPaletteHint(): boolean {
  return safeGetItem("pagewise.hint.palette") === "1";
}

export function markPaletteHintSeen(): void {
  safeSetItem("pagewise.hint.palette", "1");
}

/*
 * The composer's keyboard line ("Enter to send · Shift+Enter for newline").
 *
 * It used to be permanent furniture under the input — a sentence explaining the
 * app on the surface the reader looks at most, at 11px and 3.96:1. It is worth
 * saying once. Once the reader has sent something, they know.
 */
export function hasSeenComposerHint(): boolean {
  return safeGetItem("pagewise.hint.composer") === "1";
}

export function markComposerHintSeen(): void {
  safeSetItem("pagewise.hint.composer", "1");
}
