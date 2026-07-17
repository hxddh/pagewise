export interface SearchPreview {
  /** Number of distinct pages with at least one match (hits are per-match). */
  pages: number;
  /** Short "p.N: snippet" fragments for the first few hits. */
  snippets: string;
  /** English fallback line (progress UI prefers the i18n key + params). */
  message: string;
}

/** Format search hits as a short progress preview (B4 interim context). */
export function formatSearchPreview(hits: unknown, maxHits = 2): SearchPreview | null {
  if (!Array.isArray(hits) || hits.length === 0) return null;

  const bits = hits.slice(0, maxHits).map((hit) => {
    const row = hit as { page?: number; text?: string; snippet?: string };
    const page = row.page ?? "?";
    const raw = (row.text ?? row.snippet ?? "").replace(/\s+/g, " ").trim();
    const snippet = raw.slice(0, 48);
    return `p.${page}: ${snippet}${raw.length > 48 ? "…" : ""}`;
  });

  const pages = new Set(
    hits.map((hit) => (hit as { page?: number }).page ?? "?"),
  ).size;
  const snippets = bits.join("; ");

  return { pages, snippets, message: `Matches on ${pages} page(s) — ${snippets}` };
}
