/**
 * The notes already written on the document.
 *
 * A PDF that reached you through other people carries their highlights, their
 * sticky notes, their questions in the margin. PageWise could not see any of
 * it: the reader's own marks were a first-class feature from 6.2 and the ones
 * already in the file were invisible, to the reader and to the assistant both.
 * For a reading agent that is a whole category of context missing — someone has
 * already told you which sentence matters and why, and the answer comes back as
 * though nobody had.
 *
 * pdf.js hands them over from `getAnnotations`, typed `Array<any>`. Everything
 * below about their shape was measured against a real annotated PDF rather than
 * read off a type, because there is no type. Three of those measurements are
 * not what you would assume:
 *
 *   - `contentsObj` and `titleObj` are `{ str, dir }`, not strings.
 *   - `quadPoints` and `color` come back as objects with numeric keys, not
 *     arrays. `Array.isArray` is false and `.map` is undefined on them.
 *   - `overlaidText` gives the text a highlight COVERS. A highlight's meaning is
 *     the sentence under it, and pdf.js has already done that join — no
 *     geometry needed.
 *
 * `rect` is bottom-left origin, the same convention as links and text runs, so
 * it goes through `pdfRectToBox` — NOT the top-left conversion the reader's own
 * marks need. 9.2.3 is what that distinction costs when it is got wrong.
 */
import type { PdfRect } from "./types";

/** Kept per document. A file with a thousand comments is a review, not a read. */
export const MAX_ANNOTATIONS = 200;

/** Longest comment kept whole. Past this it is an essay, not a margin note. */
const MAX_CONTENTS = 600;
/** Longest quoted span of the text a highlight covers. */
const MAX_OVERLAID = 300;

export interface DocAnnotation {
  /** 1-based. */
  page: number;
  /** pdf.js's own id, so a re-read of the same file addresses the same note. */
  id: string;
  /** `Highlight`, `Text`, `Square`, `StrikeOut`, … as the PDF names it. */
  subtype: string;
  /** What was written. Empty for a mark that carries no comment. */
  contents: string;
  /** Who wrote it, when the file says. */
  author: string;
  /** The text a highlight covers, when the document could tell us. */
  quoted: string;
  /** Where it sits, bottom-left origin — `pdfRectToBox`, not the mark path. */
  rect: PdfRect;
}

/** pdf.js returns `{str, dir}` here, not a string. */
function strOf(value: unknown): string {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (value && typeof value === "object" && "str" in value) {
    const str = (value as { str?: unknown }).str;
    return typeof str === "string" ? str.replace(/\s+/g, " ").trim() : "";
  }
  return "";
}

/**
 * `rect` arrives as `[x1, y1, x2, y2]` — two corners, in either order.
 *
 * Normalized rather than assumed: a PDF is free to write the corners the other
 * way round, and a negative width draws nothing at all.
 */
function rectOf(value: unknown): PdfRect | null {
  const n = numbersOf(value);
  if (n.length < 4) return null;
  const [x1, y1, x2, y2] = n as [number, number, number, number];
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);
  if (!(width > 0 && height > 0)) return null;
  return { x, y, width, height };
}

/**
 * Numbers out of either an array or the numeric-keyed object pdf.js may return.
 *
 * Measured: `quadPoints` came back as `{0: 38, 1: 734, …}`. `Array.isArray` is
 * false on that and `.map` is undefined, so the obvious code reads nothing and
 * says so nowhere.
 */
function numbersOf(value: unknown): number[] {
  if (Array.isArray(value)) return value.filter((v): v is number => typeof v === "number");
  if (value && typeof value === "object") {
    const out: number[] = [];
    for (let i = 0; ; i += 1) {
      const v = (value as Record<number, unknown>)[i];
      if (typeof v !== "number") break;
      out.push(v);
    }
    return out;
  }
  return [];
}

/**
 * The annotations on one page worth carrying, in the order the file lists them.
 *
 * WHAT IS DROPPED, and why: a mark with no comment and no text under it says
 * nothing that can be read back. A `Link` is already handled as a link, and a
 * `Popup` is the container an existing note is displayed in rather than a note
 * of its own — carrying either would double-count.
 */
export function readableAnnotations(raw: readonly unknown[], page: number): DocAnnotation[] {
  const out: DocAnnotation[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    const subtype = typeof a.subtype === "string" ? a.subtype : "";
    if (!subtype || subtype === "Link" || subtype === "Popup" || subtype === "Widget") continue;

    const contents = strOf(a.contentsObj).slice(0, MAX_CONTENTS);
    const quoted = strOf(a.overlaidText).slice(0, MAX_OVERLAID);
    // Nothing written and nothing underlined: a coloured box that means
    // something only to whoever drew it.
    if (!contents && !quoted) continue;

    const rect = rectOf(a.rect);
    if (!rect) continue;

    out.push({
      page,
      id: typeof a.id === "string" ? a.id : `${page}:${out.length}`,
      subtype,
      contents,
      author: strOf(a.titleObj).slice(0, 80),
      quoted,
      rect,
    });
  }
  return out;
}

/**
 * The document's notes, rendered for the model.
 *
 * Bounded like everything else that rides on a request: a heavily reviewed PDF
 * can carry hundreds of comments, and sending them all would cost more than the
 * pages the question is about.
 *
 * Each line leads with the page, so a note is never separated from where it
 * was written — the same shape the reading record uses, for the same reason.
 */
export function describeAnnotations(
  annotations: readonly DocAnnotation[],
  budget = 1_500,
): { lines: string[]; omitted: number } {
  const lines: string[] = [];
  let used = 0;
  for (const a of annotations) {
    const who = a.author ? ` (${a.author})` : "";
    const on = a.quoted ? ` on "${a.quoted.slice(0, 120)}"` : "";
    const said = a.contents ? `: ${a.contents}` : "";
    const line = `- p${a.page}${who}${on}${said}`;
    if (used + line.length + 1 > budget) break;
    used += line.length + 1;
    lines.push(line);
  }
  return { lines, omitted: annotations.length - lines.length };
}
