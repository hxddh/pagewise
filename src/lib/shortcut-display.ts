/** Primary modifier label for keyboard hints (⌘ on Apple, Ctrl+ elsewhere). */
export function modKey(): string {
  if (typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform)) {
    return "⌘";
  }
  return "Ctrl+";
}

export function shortcut(keys: string): string {
  const mod = modKey();
  return keys.replace(/^⌘/, mod);
}
