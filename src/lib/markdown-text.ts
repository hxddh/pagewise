/**
 * Markdown → plain text.
 *
 * Page text is Markdown now, which is what makes tables and headings survive
 * into the model's context. Search is the one consumer that must not see it:
 * a query for `1,284` should match a table cell, and a snippet reading
 * `|营业收入|1,284|1,141|` is worse than the row it came from.
 *
 * This is deliberately a display/search normalizer, not a Markdown parser —
 * it strips the syntax we emit and leaves everything else alone.
 */

/** Table row → cells joined by spaces; delimiter rows (`|---|`) disappear. */
function flattenTableRow(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  const cells = trimmed.slice(1, trimmed.endsWith("|") ? -1 : undefined).split("|");
  // `|---|---|` carries no content.
  if (cells.every((c) => /^\s*:?-+:?\s*$/.test(c))) return "";
  return cells.map((c) => c.trim()).join(" ");
}

export function markdownToPlainText(markdown: string): string {
  const out: string[] = [];
  for (const line of markdown.split("\n")) {
    const table = flattenTableRow(line);
    if (table !== null) {
      if (table) out.push(table);
      continue;
    }
    out.push(
      line
        // Heading markers, list bullets and blockquote markers.
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s{0,3}[-*+]\s+/, "")
        .replace(/^\s{0,3}>\s?/, "")
        // Inline emphasis and code.
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/(^|\W)\*(\S(?:.*?\S)?)\*(?=\W|$)/g, "$1$2")
        .replace(/`([^`]*)`/g, "$1")
        // Underline runs, which the extractor emits as HTML.
        .replace(/<\/?u>/g, "")
        // [label](url) → label
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"),
    );
  }
  return out.join("\n");
}
