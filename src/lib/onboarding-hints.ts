const KEY = "pagewise.recentCommands";
const MAX = 5;

export function recordCommand(id: string): void {
  const prev = loadRecentCommandIds();
  const next = [id, ...prev.filter((x) => x !== id)].slice(0, MAX);
  localStorage.setItem(KEY, JSON.stringify(next));
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

export function hasSeenCollapseHint(): boolean {
  return localStorage.getItem("pagewise.hint.collapse") === "1";
}

export function markCollapseHintSeen(): void {
  localStorage.setItem("pagewise.hint.collapse", "1");
}

export function hasSeenPaletteHint(): boolean {
  return localStorage.getItem("pagewise.hint.palette") === "1";
}

export function markPaletteHintSeen(): void {
  localStorage.setItem("pagewise.hint.palette", "1");
}
