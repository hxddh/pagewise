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
export interface ExportDocOptions {
  /** Whether `documentToMarkdown` includes the `## Marks` section (default true; pass false when marks were already emitted earlier in a combined report). */
  includeMarks?: boolean;
  locale?: "en" | "zh-CN";
}

export function marksSection(path: string, locale: "en" | "zh-CN" = "en"): string[] {
  const marks = getMarks(path);
  if (marks.length === 0) return [];
  const zh = locale === "zh-CN";
  const parts = [zh ? "## 批注" : "## Marks", ""];
  for (const mark of marks) {
    const pageLabel = zh ? `**第 ${mark.page} 页**` : `**p. ${mark.page}**`;
    const body = mark.text || (zh ? "（无文字）" : "(no text)");
    parts.push(`- ${pageLabel} — ${body}`);
    if (mark.note) parts.push(`  - ${mark.note}`);
  }
  parts.push("");
  return parts;
}

export function documentToMarkdown(doc: LoadedDocument, options?: ExportDocOptions): string {
  const zh = options?.locale === "zh-CN";
  const parts: string[] = [];
  const heading = doc.title?.trim() || doc.name;
  parts.push(`# ${heading}`, "");
  if (doc.title?.trim() && doc.title.trim() !== doc.name) {
    parts.push(`${zh ? "**来源：**" : "**Source:**"} ${doc.name}`, "");
  }

  if (options?.includeMarks !== false) {
    parts.push(...marksSection(doc.path, options?.locale));
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

export function marksToMarkdown(doc: LoadedDocument, locale: "en" | "zh-CN" = "en"): string {
  const section = marksSection(doc.path, locale);
  if (section.length === 0) return "";
  const heading = doc.title?.trim() || doc.name;
  const suffix = locale === "zh-CN" ? "批注" : "marks";
  return [`# ${heading} — ${suffix}`, "", ...section].join("\n").trimEnd() + "\n";
}
