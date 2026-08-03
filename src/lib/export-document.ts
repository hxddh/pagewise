import type { LoadedDocument } from "./types";

/**
 * Render a loaded document as one Markdown file.
 *
 * Page text is already Markdown — headings, lists and tables intact — so this
 * is a join, not a conversion. Page markers are HTML comments: invisible when
 * rendered, but enough to trace a passage back to the page it came from.
 */
export function documentToMarkdown(doc: LoadedDocument): string {
  const parts: string[] = [];
  const heading = doc.title?.trim() || doc.name;
  parts.push(`# ${heading}`, "");
  if (doc.title?.trim() && doc.title.trim() !== doc.name) {
    parts.push(`**Source:** ${doc.name}`, "");
  }

  for (const page of [...doc.pages].sort((a, b) => a.page - b.page)) {
    const text = page.text.trim();
    if (!text) continue;
    parts.push(`<!-- page ${page.page} -->`, "", text, "");
  }

  return parts.join("\n").trimEnd() + "\n";
}

/** Pages that would contribute nothing to an export — nothing was read from them. */
export function emptyExportPages(doc: LoadedDocument): number[] {
  return doc.pages.filter((p) => !p.text.trim()).map((p) => p.page);
}
