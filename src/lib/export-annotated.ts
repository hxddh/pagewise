/**
 * The reader's evidence, written into a copy of the PDF (14.1).
 *
 * Two things are written, and only where they can be put on the page:
 *
 *   - **Findings whose wording was found on their page**, or that the reader
 *     confirmed and whose wording was found. Each becomes a highlight over
 *     the quoted words, with the claim as its note. A finding whose wording
 *     was not found has nowhere to go — and a highlight is a claim that the
 *     words are here, which is exactly what could not be shown.
 *   - **The reader's own marks**, with their notes: highlights over words,
 *     outlines around regions. Marks made on an earlier version of the file
 *     are left out; their rectangles belong to a page that has changed.
 *
 * Placement is re-derived, never stored (see `finding-anchors.ts`), so what is
 * written is where the words are in the file as it is now.
 */
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { allowPath } from "./fs-access";
import { placeFinding, type FindingPlacement } from "./finding-anchors";
import type { Finding } from "./finding-store";
import type { Trust } from "./finding-trust";
import type { Mark } from "./mark-store";
import type { PdfRect } from "./types";

export interface AnnotationOut {
  kind: "highlight" | "square";
  id: string;
  page: number;
  rects: PdfRect[];
  /** "pdf": absolute, bottom-left (located text). "view": offset from the visible box, top-left (marks). */
  frame: "pdf" | "view";
  contents: string;
  author: string;
  subject: string;
  color: [number, number, number];
}

export interface AnnotationLabels {
  /** The author written on findings. */
  assistant: string;
  /** The author written on the reader's marks and kept answers. */
  reader: string;
  finding: string;
  mark: string;
  /** Appended to a finding's claim: how it was checked. */
  foundOnPage: (page: number) => string;
  confirmed: string;
}

/** The assistant's violet and a highlighter's yellow, as the app draws them. */
const FINDING_COLOR: [number, number, number] = [0.62, 0.45, 0.98];
const MARK_COLOR: [number, number, number] = [1, 0.84, 0.25];

/** Trust states whose wording is on the page, and so can be highlighted. */
const WRITABLE: ReadonlySet<Trust> = new Set(["located", "confirmed"]);

export function findingAnnotations(
  entries: ReadonlyArray<{ finding: Finding; trust: Trust }>,
  placements: ReadonlyMap<string, FindingPlacement>,
  labels: AnnotationLabels,
): AnnotationOut[] {
  const out: AnnotationOut[] = [];
  for (const { finding, trust } of entries) {
    if (!WRITABLE.has(trust)) continue;
    const placement = placements.get(finding.id);
    if (placement?.status !== "located") continue;
    const { page, rects } = placement.anchor;
    const how = trust === "confirmed" ? labels.confirmed : labels.foundOnPage(page);
    out.push({
      kind: "highlight",
      id: `f-${finding.id}`,
      page,
      rects,
      frame: "pdf",
      contents: `${finding.claim}\n\n${how}`,
      author: finding.author === "reader" ? labels.reader : labels.assistant,
      subject: labels.finding,
      color: FINDING_COLOR,
    });
  }
  return out;
}

export function markAnnotations(marks: readonly Mark[], stamp: string, labels: AnnotationLabels): AnnotationOut[] {
  return marks
    // A mark made on an earlier version of the file is drawn on a page that
    // may have changed under it. An empty stamp never makes anything stale.
    .filter((m) => !stamp || !m.stamp || m.stamp === stamp)
    .filter((m) => m.rects.length > 0)
    .map((m) => ({
      kind: m.kind === "region" ? ("square" as const) : ("highlight" as const),
      id: `m-${m.id}`,
      page: m.page,
      rects: m.rects,
      frame: "view" as const,
      contents: m.note,
      author: labels.reader,
      subject: labels.mark,
      color: MARK_COLOR,
    }));
}

/** Everything writable for this document, placements resolved against the file as it is. */
export async function evidenceAnnotations(
  path: string,
  stamp: string,
  entries: ReadonlyArray<{ finding: Finding; trust: Trust }>,
  marks: readonly Mark[],
  labels: AnnotationLabels,
): Promise<AnnotationOut[]> {
  const placements = new Map<string, FindingPlacement>();
  await Promise.all(
    entries
      .filter((e) => WRITABLE.has(e.trust))
      .map(async ({ finding }) => {
        placements.set(finding.id, await placeFinding(path, finding).catch(() => ({ status: "unreadable" as const })));
      }),
  );
  return [...findingAnnotations(entries, placements, labels), ...markAnnotations(marks, stamp, labels)];
}

/**
 * Ask where to save, and write the annotated copy there. Resolves to the
 * number written, or null when the reader cancelled.
 */
export async function saveAnnotatedPdf(
  path: string,
  annotations: readonly AnnotationOut[],
  defaultName: string,
  filterName: string,
): Promise<number | null> {
  const out = await save({ defaultPath: defaultName, filters: [{ name: filterName, extensions: ["pdf"] }] });
  if (!out) return null;
  // The chosen file may not exist yet; authorize its directory, as the
  // Markdown exports do (`save-markdown.ts`).
  const parent = out.replace(/[/\\][^/\\]*$/, "");
  if (parent && parent !== out) await allowPath(parent);
  return invoke<number>("export_annotated_pdf", { path, outPath: out, annotations });
}
