import type { RegionText } from "../../lib/types";

/** Longest snapshot stored on a mark, matching the selection quote cap. */
const MAX_SNAPSHOT = 500;

/**
 * `[Image: Im2]`, `[Image: X4]` — the extractor's own marker for a picture it
 * found and could not read.
 */
const IMAGE_PLACEHOLDER = /\[Image:[^\]]*\]/g;

/**
 * The words a boxed region actually contains.
 *
 * Not the extractor's output as-is. Measured on a scanned page,
 * `extract_region` returns `"[Image: X4]"` rather than an empty string — store
 * that and the reader, who boxed a photograph, sees `[Image: X4]` in the
 * sidebar as though those were the words on the page. A region with nothing
 * readable in it gets an empty snapshot, which is honest: the rectangle is what
 * locates the mark, and the text was only ever there for the reader.
 *
 * A table is kept verbatim — it is the one thing worth quoting exactly, and
 * reflowing it would merge neighbouring numbers.
 */
export function regionSnapshot(region: RegionText): string {
  const table = region.table?.trim();
  if (table) return truncate(table);
  const text = region.text.replace(IMAGE_PLACEHOLDER, " ").replace(/\s+/g, " ").trim();
  return truncate(text);
}

function truncate(text: string): string {
  return text.length > MAX_SNAPSHOT ? `${text.slice(0, MAX_SNAPSHOT)}…` : text;
}
