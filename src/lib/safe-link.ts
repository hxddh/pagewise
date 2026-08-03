/** Schemes a link may use before the app will offer to open it. */
export const SAFE_LINK_SCHEMES = ["http:", "https:", "mailto:"];

export function schemeOf(url: string): string | null {
  try {
    return new URL(url, "app://local").protocol;
  } catch {
    return null;
  }
}

/**
 * Is this a link the app is willing to hand to the system browser?
 *
 * Everything else — `javascript:`, `file:`, `data:` — is refused outright.
 * These URLs come from documents and from model output, neither of which is
 * trusted input.
 */
export function isSafeLink(url: string): boolean {
  const scheme = schemeOf(url);
  return !!scheme && SAFE_LINK_SCHEMES.includes(scheme);
}

/** Shorten a URL for display without hiding which host it points at. */
export function displayUrl(url: string, max = 72): string {
  const trimmed = url.trim();
  if (trimmed.length <= max) return trimmed;
  // Keep the head — the scheme and host are what the reader needs to judge it.
  return `${trimmed.slice(0, max - 1)}…`;
}
