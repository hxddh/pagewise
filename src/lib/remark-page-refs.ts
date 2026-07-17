/**
 * Remark plugin: turn page references in assistant answers ("page 5", "pp. 12-14",
 * "第 5 页", "第 12–14 页") into links with a `pagewise-page:<n>` URL, so the
 * Markdown anchor renderer can make them clickable and jump the preview. For a
 * range, the link targets the first page. Pure mdast transform — no deps beyond
 * a manual tree walk so it stays lightweight.
 */

export const PAGE_REF_SCHEME = "pagewise-page:";

// Group 1 = English page number; group 2 = Chinese page number.
// "page"/"pages" need a word boundary (else "webpage 5"/"step 5" match), and the
// p./pp. abbreviations require the dot (else any word ending in p before a
// number — "MVP 2024", "top 10" — becomes a bogus page link).
const PAGE_REF_RE =
  /\b(?:pages?|pp?\.)\s*(\d{1,5})(?:\s*[-–—~]\s*\d{1,5})?|第\s*(\d{1,5})\s*(?:[-–—~至到]\s*\d{1,5}\s*)?页/gi;

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
  [k: string]: unknown;
}

/** Nodes whose text must not be linkified (already a link, or code). */
const SKIP = new Set(["link", "linkReference", "inlineCode", "code"]);

function splitTextNode(value: string): MdNode[] | null {
  PAGE_REF_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let last = 0;
  const out: MdNode[] = [];
  while ((match = PAGE_REF_RE.exec(value)) !== null) {
    const pageStr = match[1] ?? match[2];
    const page = pageStr ? parseInt(pageStr, 10) : NaN;
    if (!Number.isFinite(page) || page < 1) continue;
    if (match.index > last) out.push({ type: "text", value: value.slice(last, match.index) });
    out.push({
      type: "link",
      url: `${PAGE_REF_SCHEME}${page}`,
      children: [{ type: "text", value: match[0] }],
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

export function remarkPageRefs() {
  return (tree: MdNode) => {
    transform(tree);
  };
}
