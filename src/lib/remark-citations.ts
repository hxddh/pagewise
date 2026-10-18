/**
 * Remark plugin: turn citation markers (`〔p12 "…"〕`, see `citations.ts`) in
 * assistant answers into links with a `pagewise-cite:` URL, which the
 * Markdown anchor renderer draws as a checked citation.
 *
 * Runs before `remarkPageRefs`, whose "page 12" links skip anything that is
 * already a link — so a marker is never linkified twice, and answers written
 * before 13.0, which have no markers, keep their page links exactly as they
 * were.
 */
import { citationRe, parseCitation, sentenceEndRe } from "./citations";
import { claimBefore } from "./answer-tables";

export const CITATION_SCHEME = "pagewise-cite:";

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
  [k: string]: unknown;
}

const SKIP = new Set(["link", "linkReference", "inlineCode", "code"]);

/** What a citation link carries, recovered from its URL by the renderer. */
export interface CitationLink {
  pages: number[];
  quote: string | null;
  /**
   * What the citation is evidence for — its sentence, or its table cell — so
   * the chip can read the check against it (15.0). Absent when the answer's
   * source was not available to the plugin.
   */
  claim?: string;
}

export function citationUrl(link: CitationLink): string {
  const data: Record<string, unknown> = { p: link.pages, q: link.quote };
  if (link.claim) data.c = link.claim;
  return `${CITATION_SCHEME}${encodeURIComponent(JSON.stringify(data))}`;
}

export function parseCitationUrl(url: string): CitationLink | null {
  if (!url.startsWith(CITATION_SCHEME)) return null;
  try {
    const raw = JSON.parse(decodeURIComponent(url.slice(CITATION_SCHEME.length))) as {
      p?: unknown;
      q?: unknown;
      c?: unknown;
    };
    const pages = Array.isArray(raw.p) ? raw.p.filter((n): n is number => Number.isInteger(n) && n >= 1) : [];
    if (pages.length === 0) return null;
    return {
      pages,
      quote: typeof raw.q === "string" && raw.q ? raw.q : null,
      ...(typeof raw.c === "string" && raw.c ? { claim: raw.c } : {}),
    };
  } catch {
    return null;
  }
}

/** The chip's visible text: the page, or the first and last of a range. */
export function citationLabel(pages: readonly number[]): string {
  return pages.length > 1 ? `${pages[0]}–${pages[pages.length - 1]}` : String(pages[0]);
}

/**
 * Where a marker is in the answer's source. A text node's value can differ
 * from the source it came from (escapes, entities), so the marker is found by
 * its own text from the node's starting offset rather than by adding offsets.
 */
function sourceIndex(source: string, from: number, marker: string): number {
  const at = source.indexOf(marker, Math.max(0, from));
  return at >= 0 ? at : source.indexOf(marker);
}

/**
 * The text before a marker, with the sentence the marker closes wrapped in a
 * `.cite-claim` span (24.0) — so a red chip's sentence can be marked as in
 * doubt (`.cite-claim:has(+ .cite-level-notFound)`, 04-chat.css). Whether it
 * is in doubt is known only when the check lands, long after this runs; the
 * span is always there and the stylesheet decides from the chip beside it.
 *
 * Only this text node is wrapped: a sentence with emphasis or a link before
 * the marker is marked from the last of those onward, not from its start.
 */
function claimNodes(before: string): MdNode[] {
  if (!before) return [];
  const stops = sentenceEndRe();
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = stops.exec(before)) !== null) {
    // A stop at the very end is the sentence's own full stop, not its start.
    if (m.index < before.length - 1) start = m.index + m[0].length;
  }
  const lead = before.slice(start).match(/^\s*/)![0].length;
  const head = before.slice(0, start + lead);
  const claim = before.slice(start + lead);
  if (!/\S/.test(claim)) return [{ type: "text", value: before }];
  const span: MdNode = {
    type: "citeClaim",
    data: { hName: "span", hProperties: { className: ["cite-claim"] } },
    children: [{ type: "text", value: claim }],
  };
  return head ? [{ type: "text", value: head }, span] : [span];
}

function splitTextNode(value: string, source: string, nodeStart: number): MdNode[] | null {
  const re = citationRe();
  let match: RegExpExecArray | null;
  let last = 0;
  const out: MdNode[] = [];
  while ((match = re.exec(value)) !== null) {
    const parsed = parseCitation(match[1]!);
    if (!parsed) continue;
    // The space a model leaves before a marker would sit between the sentence
    // and its citation mark; the mark belongs against the word.
    const before = value.slice(last, match.index).replace(/[ \t]+$/, "");
    out.push(...claimNodes(before));
    const at = source ? sourceIndex(source, nodeStart + match.index, match[0]) : -1;
    const claim = at >= 0 ? claimBefore(source, at) : "";
    out.push({
      type: "link",
      url: citationUrl(claim ? { ...parsed, claim } : parsed),
      children: [{ type: "text", value: citationLabel(parsed.pages) }],
    });
    last = match.index + match[0].length;
  }
  if (out.length === 0) return null;
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

function transform(node: MdNode, source: string): void {
  if (!Array.isArray(node.children)) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      const start = (child.position as { start?: { offset?: number } } | undefined)?.start?.offset ?? 0;
      const split = splitTextNode(child.value, source, start);
      if (split) {
        next.push(...split);
        continue;
      }
      next.push(child);
    } else {
      if (!SKIP.has(child.type)) transform(child, source);
      next.push(child);
    }
  }
  node.children = next;
}

export function remarkCitations() {
  return (tree: MdNode, file?: { value?: unknown }) => {
    transform(tree, typeof file?.value === "string" ? file.value : "");
  };
}
