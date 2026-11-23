import type { UIMessage } from "ai";

function isToolUIPart(
  part: UIMessage["parts"][number],
): part is UIMessage["parts"][number] & {
  toolCallId: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  toolName?: string;
} {
  return part.type === "dynamic-tool" || part.type.startsWith("tool-");
}

function getToolName(part: UIMessage["parts"][number] & { toolName?: string }): string {
  return part.type === "dynamic-tool" ? (part.toolName ?? "") : part.type.slice(5);
}
import {
  DOCUMENT_OUTLINE_TOOL,
  PRUNE_DOCUMENT_TOOLS,
  READ_PDF_PAGE_TOOL,
  READ_PDF_RANGE_TOOL,
  READ_SECTION_TOOL,
  SEARCH_IN_DOCUMENT_TOOL,
  type DocumentToolName,
} from "./document-tool-names";

/** Synthesized output for a tool call that never produced a real result. */
export const CANCELLED_OUTPUT = "[cancelled]";

/** Legacy suffix kept for idempotency across stored/migrated summaries. */
export const COMPACTED_SUFFIX = "— omitted from chat history]";

/** Max chars of tool outputs kept warm on the latest assistant turn for follow-ups. */
export const WARM_TURN_MAX_CHARS = 12_000;

export function isCompactedSummary(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.startsWith("[") &&
    (value.endsWith(COMPACTED_SUFFIX) || /— re-read [^\]]*to quote verbatim\]$/.test(value))
  );
}

/**
 * Replace bulky tool outputs in prior turns while keeping up to `warmMaxChars`
 * on the latest assistant turn so immediate follow-ups don't pay to re-read.
 */
export function pruneToolOutputsForHistory(
  messages: UIMessage[],
  warmMaxChars: number = WARM_TURN_MAX_CHARS,
): UIMessage[] {
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }

  let changed = false;

  const next = messages.map((msg, idx) => {
    if (msg.role !== "assistant") return msg;

    const warmIndices = new Set<number>();
    if (idx === lastAssistantIdx && warmMaxChars > 0) {
      let usedWarm = 0;
      for (let pi = msg.parts.length - 1; pi >= 0; pi -= 1) {
        const part = msg.parts[pi];
        if (!part || !isToolUIPart(part) || part.state !== "output-available") continue;
        const name = getToolName(part);
        if (!PRUNE_DOCUMENT_TOOLS.has(name as DocumentToolName)) continue;
        if (isCompactedSummary(part.output) || part.output === CANCELLED_OUTPUT) continue;
        const len = textLength(part.output);
        if (usedWarm + len <= warmMaxChars) {
          warmIndices.add(pi);
          usedWarm += len;
        }
      }
    }

    let msgChanged = false;
    const parts = msg.parts.map((part, pi) => {
      if (warmIndices.has(pi)) return part;
      if (!isToolUIPart(part) || part.state !== "output-available") return part;

      const name = getToolName(part);
      if (!PRUNE_DOCUMENT_TOOLS.has(name as DocumentToolName)) return part;

      const compact = compactToolOutput(name, part.input, part.output);
      if (compact === part.output) return part;

      msgChanged = true;
      changed = true;
      return { ...part, output: compact };
    });

    if (!msgChanged) return msg;
    return { ...msg, parts };
  });

  return changed ? next : messages;
}

/**
 * Strip or repair non-terminal tool parts so a Stop-mid-stream or a reload
 * can't leave dangling tool_use parts that break tool_use/tool_result pairing.
 */
export function sanitizeDanglingToolParts(messages: UIMessage[]): UIMessage[] {
  let changed = false;

  const next = messages.map((msg) => {
    if (msg.role !== "assistant") return msg;

    let msgChanged = false;
    const parts: typeof msg.parts = [];
    for (const part of msg.parts) {
      if (!isToolUIPart(part)) {
        parts.push(part);
        continue;
      }
      if (part.state === "input-streaming") {
        msgChanged = true;
        changed = true;
        continue;
      }
      if (part.state !== "input-available") {
        parts.push(part);
        continue;
      }

      msgChanged = true;
      changed = true;
      parts.push({
        ...part,
        state: "output-available",
        input: part.input ?? {},
        output: CANCELLED_OUTPUT,
      } as (typeof msg.parts)[number]);
    }

    if (!msgChanged) return msg;
    return { ...msg, parts };
  });

  return changed ? next : messages;
}

function extractRawText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const t = (output as { text?: unknown }).text;
    if (typeof t === "string") return t;
  }
  return "";
}

/** Deterministic ~175-char digest of headings, table headers, and key figures/clauses. */
export function extractPageDigest(raw: string, maxChars = 175): string {
  if (!raw) return "";
  const cleaned = raw
    .replace(/^--- Page \d+[^\n]*---\n?/gm, "")
    .replace(/^\[already returned[^\]]*\]$/gm, "")
    .trim();
  if (!cleaned || /^(.)\1{19,}$/.test(cleaned)) return "";

  const lines = cleaned
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0 && !/^(.)\1{19,}$/.test(l));
  if (lines.length === 0) return "";

  const picks: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    const t = s.slice(0, 90).trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    picks.push(t);
  };

  for (const l of lines) {
    const h = l.match(/^#{1,6}\s+(.+)/);
    if (h) add(h[1]!);
    if (picks.length >= 3) break;
  }
  for (const l of lines) {
    if (/^\|.+\|$/.test(l) && !/^\|[\s:|-]+\|$/.test(l)) {
      add(l);
      break;
    }
  }
  for (const l of lines) {
    if (/\d|[%$€£¥￥元万亿]|第[一二三四五六七八九十百\d]+[条章节]|Section\s+\d/i.test(l)) {
      add(l);
      if (picks.length >= 4) break;
    }
  }
  if (picks.length === 0) add(lines[0]!);

  const joined = picks.join(" · ");
  return joined.length <= maxChars ? joined : `${joined.slice(0, maxChars - 1).trimEnd()}…`;
}

function formatActualPages(pages: readonly number[]): string | null {
  if (pages.length === 0) return null;
  const first = pages[0]!;
  const last = pages[pages.length - 1]!;
  return first === last ? `page ${first}` : `pages ${first}–${last}`;
}

export function compactToolOutput(
  name: string,
  input: unknown,
  output: unknown,
): string | Record<string, unknown> {
  if (isCompactedSummary(output)) return output as string;
  if (output === CANCELLED_OUTPUT) return output;

  if (
    output &&
    typeof output === "object" &&
    (output as { budgetExceeded?: unknown }).budgetExceeded === true
  ) {
    return output as Record<string, unknown>;
  }

  const inp =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};

  if (name === READ_PDF_PAGE_TOOL) {
    const outObj =
      output && typeof output === "object"
        ? (output as { page?: unknown; pages?: unknown })
        : null;
    const raw = extractRawText(output);
    const digest = extractPageDigest(raw);
    const digestPart = digest ? `: ${digest}` : "";
    if (outObj && Array.isArray(outObj.pages)) {
      const pagesList = outObj.pages.filter((p): p is number => typeof p === "number");
      if (pagesList.length > 1) {
        const chars = textLength(output);
        return `[Read pages ${pagesList.join(", ")}, ${chars} chars${digestPart} — re-read with read_pdf_page to quote verbatim]`;
      }
      if (pagesList.length === 1) {
        const single = pagesList[0]!;
        const chars = textLength(output);
        return `[Read page ${single}, ${chars} chars${digestPart} — re-read page ${single} to quote verbatim]`;
      }
    }
    const resolvedPage =
      outObj && typeof outObj.page === "number"
        ? outObj.page
        : typeof inp.page === "number"
          ? inp.page
          : undefined;
    if (resolvedPage !== undefined) {
      const chars = textLength(output);
      return `[Read page ${resolvedPage}, ${chars} chars${digestPart} — re-read page ${resolvedPage} to quote verbatim]`;
    }
  }

  if (name === READ_PDF_RANGE_TOOL) {
    const start = inp.start;
    const end = inp.end;
    const raw = extractRawText(output);
    const headerPages = [
      ...new Set(
        [...raw.matchAll(/^--- Page (\d+)\b/gm)].map((m) => Number(m[1])),
      ),
    ];
    const startPage =
      output && typeof output === "object" && typeof (output as { startPage?: unknown }).startPage === "number"
        ? ((output as { startPage: number }).startPage)
        : undefined;
    const endPage =
      output && typeof output === "object" && typeof (output as { endPage?: unknown }).endPage === "number"
        ? ((output as { endPage: number }).endPage)
        : undefined;
    const actualPages =
      headerPages.length > 0
        ? headerPages
        : startPage !== undefined && endPage !== undefined
          ? [startPage, endPage]
          : [];
    const actualLabel = formatActualPages(actualPages);
    const requestedLabel =
      typeof start === "number" && typeof end === "number"
        ? start === end
          ? `page ${start}`
          : `pages ${start}–${end}`
        : "page range";
    const range = actualLabel ?? requestedLabel;
    const actualEnd = actualPages.length > 0 ? actualPages[actualPages.length - 1]! : undefined;
    const wasTruncated =
      (output && typeof output === "object" && (output as { truncated?: unknown }).truncated === true) ||
      (typeof end === "number" && actualEnd !== undefined && actualEnd < end);
    const truncNote =
      wasTruncated && typeof start === "number" && typeof end === "number" && actualEnd !== undefined && actualEnd < end
        ? ` (truncated from ${start}–${end})`
        : "";
    const chars = textLength(output);
    const digest = extractPageDigest(raw);
    const digestPart = digest ? `: ${digest}` : "";
    return `[Read ${range}${truncNote}, ${chars} chars${digestPart} — re-read to quote verbatim]`;
  }

  if (name === SEARCH_IN_DOCUMENT_TOOL) {
    const q = typeof inp.query === "string" ? inp.query : "query";
    const hitList = Array.isArray(output)
      ? output
      : output && typeof output === "object" && Array.isArray((output as { hits?: unknown }).hits)
        ? (output as { hits: unknown[] }).hits
        : null;
    const hits = hitList ? hitList.length : textLength(output);
    return `[Search "${q.slice(0, 40)}", ${hits} hits ${COMPACTED_SUFFIX}`;
  }

  if (name === READ_SECTION_TOOL) {
    const title = typeof inp.title === "string" ? inp.title : "section";
    const raw = extractRawText(output);
    const chars = textLength(output);
    const digest = extractPageDigest(raw);
    const digestPart = digest ? `: ${digest}` : "";
    return `[Read section "${title.slice(0, 60)}", ${chars} chars${digestPart} — re-read to quote verbatim]`;
  }

  if (name === DOCUMENT_OUTLINE_TOOL) {
    const chars = textLength(output);
    return `[Document index, ${chars} chars ${COMPACTED_SUFFIX}`;
  }

  return output as string | Record<string, unknown>;
}

function textLength(output: unknown): number {
  if (typeof output === "string") return output.length;
  if (output && typeof output === "object") {
    const obj = output as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text.length;
    if (typeof obj.charCount === "number") return obj.charCount;
    try {
      return JSON.stringify(output).length;
    } catch {
      return 0;
    }
  }
  return 0;
}
