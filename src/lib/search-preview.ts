/** Format search hits as a short progress preview (B4 interim context). */
export function formatSearchPreview(hits: unknown, maxHits = 2): string | null {
  if (!Array.isArray(hits) || hits.length === 0) return null;

  const bits = hits.slice(0, maxHits).map((hit) => {
    const row = hit as { page?: number; text?: string; snippet?: string };
    const page = row.page ?? "?";
    const raw = (row.text ?? row.snippet ?? "").replace(/\s+/g, " ").trim();
    const snippet = raw.slice(0, 48);
    return `p.${page}: ${snippet}${raw.length > 48 ? "…" : ""}`;
  });

  return `Matches on ${hits.length} page(s) — ${bits.join("; ")}`;
}
