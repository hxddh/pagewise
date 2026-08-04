import { getMarks } from "./mark-store";
import type { LoadedDocument } from "./types";

/**
 * The reader's marks, appended to the export.
 *
 * Export is the only way marks leave PageWise. They are deliberately NOT
 * written back into the PDF: that needs a PDF writer and, worse, rewrites the
 * reader's original file — corrupting a contract costs more than portability
 * between readers is worth.
 */
function marksSection(path: string): string[] {
  const marks = getMarks(path);
  if (marks.length === 0) return [];
  const parts = ["## Marks", ""];
  for (const mark of marks) {
    parts.push(`- **p. ${mark.page}** — ${mark.text || "(no text)"}`);
    if (mark.note) parts.push(`  - ${mark.note}`);
  }
  parts.push("");
  return parts;
}

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

  parts.push(...marksSection(doc.path));

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
