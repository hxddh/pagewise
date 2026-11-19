import { PRUNE_DOCUMENT_TOOLS, type DocumentToolName } from "./document-tool-names";
import { compactToolOutput, isCompactedSummary } from "./prune-chat-history";

/** Default ceiling on uncompacted tool results inside one run. */
export const KEEP_RECENT_CHARS = 16_000;

/** Always keep at least this many, however large they are. */
export const KEEP_RECENT_MIN = 1;

/** Batch compaction target ratio so consecutive steps stay append-only (KV cache friendly). */
const HYSTERESIS_TARGET_RATIO = 0.65;

interface ToolCallPart {
  type: string;
  toolCallId?: unknown;
  toolName?: unknown;
  input?: unknown;
  output?: unknown;
}

interface ModelMessageLike {
  role: string;
  content: unknown;
}

function isToolResultPart(part: unknown): part is ToolCallPart {
  return (
    !!part &&
    typeof part === "object" &&
    (part as { type?: unknown }).type === "tool-result"
  );
}

function isToolCallPart(part: unknown): part is ToolCallPart {
  return (
    !!part && typeof part === "object" && (part as { type?: unknown }).type === "tool-call"
  );
}

function outputValue(output: unknown): unknown {
  if (output && typeof output === "object" && "value" in (output as object)) {
    return (output as { value: unknown }).value;
  }
  return output;
}

function sizeOf(value: unknown): number {
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function pagesFromRangeText(raw: string): number[] {
  const pages = new Set<number>();
  for (const m of raw.matchAll(/^--- Page (\d+)\b[^\n]*---\n(?!\[already returned)/gm)) {
    pages.add(Number(m[1]));
  }
  return [...pages];
}

/**
 * The pages whose full text a read result carries: ignores `alreadyRead` stubs
 * and `[already returned ...]` markers inside range results so `forgetDelivered`
 * never evicts a page whose real text is still live in an earlier kept result.
 */
export function pagesInResult(value: unknown): number[] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if ((value as { alreadyRead?: unknown }).alreadyRead === true) return [];
    const page = (value as { page?: unknown }).page;
    const text = (value as { text?: unknown }).text;
    if (typeof page === "number" && typeof text === "string") {
      if (text.length === 0 || text.startsWith("[already returned")) return [];
      return [page];
    }
    if (typeof text === "string") return pagesFromRangeText(text);
    return [];
  }
  if (typeof value === "string") return pagesFromRangeText(value);
  return [];
}

export function compactRunMessages<M extends ModelMessageLike>(
  messages: readonly M[] | undefined,
  keepChars: number = KEEP_RECENT_CHARS,
  onCompacted?: (pages: number[]) => void,
): readonly M[] | M[] {
  if (!messages || messages.length === 0) return messages ?? [];

  const inputById = new Map<string, unknown>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (isToolCallPart(part) && typeof part.toolCallId === "string") {
        inputById.set(part.toolCallId, part.input);
      }
    }
  }

  // Identify the latest tool-result step (one or more consecutive trailing `tool`
  // messages with no `assistant` message after the first of them) so 100% of
  // parallel tool results from the step that just finished stay uncompacted.
  let lastToolEnd = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "tool") {
      lastToolEnd = i;
      break;
    }
  }
  let latestStepStart = lastToolEnd;
  while (latestStepStart > 0 && messages[latestStepStart - 1]?.role === "tool") {
    latestStepStart -= 1;
  }

  const sites: Array<{ message: number; part: number; chars: number; compacted: boolean; latestStep: boolean }> = [];
  messages.forEach((message, mi) => {
    if (message.role !== "tool" || !Array.isArray(message.content)) return;
    const inLatestStep = lastToolEnd >= 0 && mi >= latestStepStart && mi <= lastToolEnd;
    message.content.forEach((part, pi) => {
      if (!isToolResultPart(part)) return;
      const name = typeof part.toolName === "string" ? part.toolName : "";
      if (!PRUNE_DOCUMENT_TOOLS.has(name as DocumentToolName)) return;
      const val = outputValue(part.output);
      const compacted = isCompactedSummary(val);
      sites.push({
        message: mi,
        part: pi,
        chars: compacted ? 0 : sizeOf(val),
        compacted,
        latestStep: inLatestStep,
      });
    });
  });

  if (sites.length === 0) return messages;

  const totalUncompacted = sites.reduce((sum, s) => sum + s.chars, 0);
  if (totalUncompacted <= keepChars) return messages;

  const targetChars = Math.max(1, Math.floor(keepChars * HYSTERESIS_TARGET_RATIO));
  let kept = 0;
  let keptChars = 0;
  const keepSite = new Set<number>();

  for (let i = sites.length - 1; i >= 0; i -= 1) {
    const s = sites[i]!;
    if (s.latestStep) {
      keepSite.add(i);
      kept += 1;
      keptChars += s.chars;
      continue;
    }
    if (s.compacted) continue;
    if (kept >= KEEP_RECENT_MIN && keptChars + s.chars > targetChars) break;
    keepSite.add(i);
    kept += 1;
    keptChars += s.chars;
  }

  const byMessage = new Map<number, Set<number>>();
  sites.forEach((site, idx) => {
    if (keepSite.has(idx) || site.compacted) return;
    let set = byMessage.get(site.message);
    if (!set) {
      set = new Set<number>();
      byMessage.set(site.message, set);
    }
    set.add(site.part);
  });

  if (byMessage.size === 0) return messages;

  let changed = false;
  const next = messages.map((message, mi) => {
    const parts = byMessage.get(mi);
    if (!parts || !Array.isArray(message.content)) return message;
    let messageChanged = false;
    const content = message.content.map((part, pi) => {
      if (!parts.has(pi) || !isToolResultPart(part)) return part;
      const value = outputValue(part.output);
      if (isCompactedSummary(value)) return part;
      const name = String(part.toolName);
      const id = typeof part.toolCallId === "string" ? part.toolCallId : "";
      const summary = compactToolOutput(name, inputById.get(id), value);
      if (summary === value) return part;
      const pages = pagesInResult(value);
      if (pages.length > 0) onCompacted?.(pages);
      messageChanged = true;
      changed = true;
      return { ...part, output: { type: "text", value: summary } };
    });
    if (!messageChanged) return message;
    return { ...message, content } as M;
  });

  return changed ? next : messages;
}
