import { citationRe, parseCitation, sentenceEndRe } from "./citations";
import { claimBefore, coCitationsBefore } from "./answer-tables";

export const CITATION_SCHEME = "pagewise-cite:";

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
  [k: string]: unknown;
}

const SKIP = new Set(["link", "linkReference", "inlineCode", "code", "citeClaim"]);

export interface CitationLink {
  pages: number[];
  quote: string | null;
  claim?: string;
  siblings?: Array<{ pages: number[]; quote: string }>;
}

export function citationUrl(link: CitationLink): string {
  const data: Record<string, unknown> = { p: link.pages, q: link.quote };
  if (link.claim) data.c = link.claim;
  if (link.siblings && link.siblings.length > 0) {
    data.s = link.siblings.map((s) => ({ p: s.pages, q: s.quote }));
  }
  return `${CITATION_SCHEME}${encodeURIComponent(JSON.stringify(data))}`;
}

export function parseCitationUrl(url: string): CitationLink | null {
  if (!url.startsWith(CITATION_SCHEME)) return null;
  try {
    const raw = JSON.parse(decodeURIComponent(url.slice(CITATION_SCHEME.length))) as {
      p?: unknown;
      q?: unknown;
      c?: unknown;
      s?: unknown;
    };
    const pages = Array.isArray(raw.p) ? raw.p.filter((n): n is number => Number.isInteger(n) && n >= 1) : [];
    if (pages.length === 0) return null;
    const siblings = Array.isArray(raw.s)
      ? raw.s
          .map((item) => {
            if (!item || typeof item !== "object") return null;
            const sPages = Array.isArray((item as { p?: unknown }).p)
              ? (item as { p: unknown[] }).p.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1)
              : [];
            const sQuote = (item as { q?: unknown }).q;
            return sPages.length > 0 && typeof sQuote === "string" && sQuote
              ? { pages: sPages, quote: sQuote }
              : null;
          })
          .filter((x): x is { pages: number[]; quote: string } => x !== null)
      : [];
    return {
      pages,
      quote: typeof raw.q === "string" && raw.q ? raw.q : null,
      ...(typeof raw.c === "string" && raw.c ? { claim: raw.c } : {}),
      ...(siblings.length > 0 ? { siblings } : {}),
    };
  } catch {
    return null;
  }
}

export function citationLabel(pages: readonly number[]): string {
  return pages.length > 1 ? `${pages[0]}–${pages[pages.length - 1]}` : String(pages[0]);
}

function sourceIndex(source: string, from: number, marker: string): number {
  const at = source.indexOf(marker, Math.max(0, from));
  return at >= 0 ? at : source.indexOf(marker);
}

interface MarkerPiece {
  kind: "marker";
  link: MdNode;
}
interface NodePiece {
  kind: "node";
  node: MdNode;
}
type Piece = MarkerPiece | NodePiece;

function tokenizeTextChild(value: string, source: string, nodeStart: number): Piece[] | null {
  const re = citationRe();
  let match: RegExpExecArray | null;
  let last = 0;
  const out: Piece[] = [];
  while ((match = re.exec(value)) !== null) {
    const parsed = parseCitation(match[1]!);
    if (!parsed) continue;
    const before = value.slice(last, match.index);
    if (before) out.push({ kind: "node", node: { type: "text", value: before } });
    const at = source ? sourceIndex(source, nodeStart + match.index, match[0]) : -1;
    const claim = at >= 0 ? claimBefore(source, at) : "";
    const siblings = at >= 0 && claim ? coCitationsBefore(source, at) : [];
    out.push({
      kind: "marker",
      link: {
        type: "link",
        url: citationUrl({
          ...parsed,
          ...(claim ? { claim } : {}),
          ...(siblings.length > 0 ? { siblings } : {}),
        }),
        children: [{ type: "text", value: citationLabel(parsed.pages) }],
      },
    });
    last = match.index + match[0].length;
  }
  if (out.length === 0) return null;
  if (last < value.length) out.push({ kind: "node", node: { type: "text", value: value.slice(last) } });
  return out;
}

function nodeHasVisibleText(node: MdNode): boolean {
  if (node.type === "text") return typeof node.value === "string" && /\S/.test(node.value);
  if (Array.isArray(node.children)) return node.children.some(nodeHasVisibleText);
  return node.type === "inlineCode" && typeof node.value === "string" && /\S/.test(node.value);
}

function splitAtLastSentenceBoundary(text: string): { head: string; tail: string } | null {
  const stops = sentenceEndRe();
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = stops.exec(text)) !== null) {
    if (m.index < text.length - 1) start = m.index + m[0].length;
  }
  if (start === 0) return null;
  const lead = text.slice(start).match(/^\s*/)![0].length;
  return { head: text.slice(0, start + lead), tail: text.slice(start + lead) };
}

function wrapClaimSpan(nodes: MdNode[]): MdNode[] {
  if (nodes.length === 0) return [];
  const trimmed = [...nodes];
  if (trimmed[0]?.type === "text" && typeof trimmed[0].value === "string") {
    const lead = trimmed[0].value.match(/^\s+/)?.[0] ?? "";
    if (lead.length > 0) {
      const rest = trimmed[0].value.slice(lead.length);
      if (!rest) {
        trimmed.shift();
        const wrapped = wrapClaimSpan(trimmed);
        return [{ type: "text", value: lead }, ...wrapped];
      }
      trimmed[0] = { ...trimmed[0], value: rest };
      return [
        { type: "text", value: lead },
        ...wrapClaimSpan(trimmed),
      ];
    }
  }
  const last = trimmed[trimmed.length - 1];
  if (last?.type === "text" && typeof last.value === "string") {
    const stripped = last.value.replace(/[ \t]+$/, "");
    if (!stripped) trimmed.pop();
    else if (stripped !== last.value) trimmed[trimmed.length - 1] = { ...last, value: stripped };
  }
  if (!trimmed.some(nodeHasVisibleText)) return nodes;
  return [
    {
      type: "citeClaim",
      data: { hName: "span", hProperties: { className: ["cite-claim"] } },
      children: trimmed,
    },
  ];
}

function transformInlineChildren(children: MdNode[], source: string): MdNode[] {
  const pieces: Piece[] = [];
  let sawMarker = false;
  for (const child of children) {
    if (child.type === "text" && typeof child.value === "string") {
      const start = (child.position as { start?: { offset?: number } } | undefined)?.start?.offset ?? 0;
      const split = tokenizeTextChild(child.value, source, start);
      if (split) {
        sawMarker = true;
        pieces.push(...split);
        continue;
      }
      pieces.push({ kind: "node", node: child });
    } else {
      if (!SKIP.has(child.type)) transform(child, source);
      pieces.push({ kind: "node", node: child });
    }
  }
  if (!sawMarker) return children;

  const out: MdNode[] = [];
  let sentenceBuf: MdNode[] = [];
  let i = 0;
  while (i < pieces.length) {
    const p = pieces[i]!;
    if (p.kind === "node") {
      const n = p.node;
      if (n.type === "text" && typeof n.value === "string") {
        const split = splitAtLastSentenceBoundary(n.value);
        if (split) {
          out.push(...sentenceBuf, { type: "text", value: split.head });
          sentenceBuf = split.tail ? [{ type: "text", value: split.tail }] : [];
          i += 1;
          continue;
        }
      }
      if (n.type === "break") {
        out.push(...sentenceBuf, n);
        sentenceBuf = [];
        i += 1;
        continue;
      }
      sentenceBuf.push(n);
      i += 1;
      continue;
    }

    // Group consecutive markers (and whitespace-only text between them) so
    // `claim〔p2 "a"〕 〔p3 "b"〕` wraps `claim` once and keeps all chips adjacent.
    const markerLinks: MdNode[] = [p.link];
    let j = i + 1;
    while (j < pieces.length) {
      const next = pieces[j]!;
      if (next.kind === "marker") {
        markerLinks.push(next.link);
        j += 1;
        continue;
      }
      if (
        next.node.type === "text" &&
        typeof next.node.value === "string" &&
        /^[ \t]+$/.test(next.node.value) &&
        pieces[j + 1]?.kind === "marker"
      ) {
        j += 1;
        continue;
      }
      break;
    }

    out.push(...wrapClaimSpan(sentenceBuf), ...markerLinks);
    sentenceBuf = [];
    i = j;
  }
  out.push(...sentenceBuf);
  return out;
}

function transform(node: MdNode, source: string): void {
  if (!Array.isArray(node.children)) return;
  node.children = transformInlineChildren(node.children, source);
}

export function remarkCitations() {
  return (tree: MdNode, file?: { value?: unknown }) => {
    transform(tree, typeof file?.value === "string" ? file.value : "");
  };
}
