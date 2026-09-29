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
import { citationRe, parseCitation } from "./citations";

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
}

export function citationUrl(link: CitationLink): string {
  return `${CITATION_SCHEME}${encodeURIComponent(JSON.stringify({ p: link.pages, q: link.quote }))}`;
}

export function parseCitationUrl(url: string): CitationLink | null {
  if (!url.startsWith(CITATION_SCHEME)) return null;
  try {
    const raw = JSON.parse(decodeURIComponent(url.slice(CITATION_SCHEME.length))) as { p?: unknown; q?: unknown };
    const pages = Array.isArray(raw.p) ? raw.p.filter((n): n is number => Number.isInteger(n) && n >= 1) : [];
    if (pages.length === 0) return null;
    return { pages, quote: typeof raw.q === "string" && raw.q ? raw.q : null };
  } catch {
    return null;
  }
}

/** The chip's visible text: the page, or the first and last of a range. */
export function citationLabel(pages: readonly number[]): string {
  return pages.length > 1 ? `${pages[0]}–${pages[pages.length - 1]}` : String(pages[0]);
}

function splitTextNode(value: string): MdNode[] | null {
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
    if (before) out.push({ type: "text", value: before });
    out.push({
      type: "link",
      url: citationUrl(parsed),
      children: [{ type: "text", value: citationLabel(parsed.pages) }],
    });
    last = match.index + match[0].length;
  }
  if (out.length === 0) return null;
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

function transform(node: MdNode): void {
  if (!Array.isArray(node.children)) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      const split = splitTextNode(child.value);
      if (split) {
        next.push(...split);
        continue;
      }
      next.push(child);
    } else {
      if (!SKIP.has(child.type)) transform(child);
      next.push(child);
    }
  }
  node.children = next;
}

export function remarkCitations() {
  return (tree: MdNode) => {
    transform(tree);
  };
}
