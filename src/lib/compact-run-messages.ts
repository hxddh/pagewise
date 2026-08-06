import { PRUNE_DOCUMENT_TOOLS, type DocumentToolName } from "./document-tool-names";
import { compactToolOutput, COMPACTED_SUFFIX } from "./prune-chat-history";

/**
 * Shorten tool results the model has already moved past, within one run.
 *
 * A tool loop re-sends every earlier tool result on every step. Between turns
 * that was already handled — a finished turn keeps `[Read page 12, 5,800 chars]`
 * instead of the page — but inside a run every page read stayed at full size
 * for all remaining steps. Twenty steps over six-thousand-character pages is
 * ~1.26 million characters of input across the run, and about 1.2 million of
 * them are the same pages sent again.
 *
 * The most recent results are left alone: those are what the model is working
 * from right now. Older ones become the same one-line summary used between
 * turns, and the page text behind them is still in the local cache — if the
 * model needs a page again, re-reading it costs a tool call and no tokens
 * beyond the page itself.
 *
 * Only the output value of a tool result is replaced. Nothing is added or
 * removed, so tool-call/tool-result pairing is untouched.
 */

/**
 * How much recent tool output is left at full size.
 *
 * This used to be a count of four results, which treated a six-page range and
 * a half-page read as equally expensive — four full pages is 24,000 characters
 * carried on every remaining step. A budget measures what it actually costs.
 * Sized to hold two full-length page reads and their envelopes, so an ordinary
 * two-step read is never shortened while it is still being reasoned over.
 */
export const KEEP_RECENT_CHARS = 16_000;

/** Always keep at least this many, however large they are. */
export const KEEP_RECENT_MIN = 1;

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

/** Unwrap the `{ type: "json" | "text", value }` envelope a model tool result uses. */
function outputValue(output: unknown): unknown {
  if (output && typeof output === "object" && "value" in (output as object)) {
    return (output as { value: unknown }).value;
  }
  return output;
}

function alreadyCompacted(value: unknown): boolean {
  return typeof value === "string" && value.endsWith(COMPACTED_SUFFIX);
}

function sizeOf(value: unknown): number {
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

export function compactRunMessages<M extends ModelMessageLike>(
  messages: readonly M[] | undefined,
  keepChars: number = KEEP_RECENT_CHARS,
): readonly M[] | M[] {
  if (!messages || messages.length === 0) return messages ?? [];

  // Tool inputs live on the assistant's tool-call part; the summary needs them
  // to say which page was read.
  const inputById = new Map<string, unknown>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (isToolCallPart(part) && typeof part.toolCallId === "string") {
        inputById.set(part.toolCallId, part.input);
      }
    }
  }

  // Locate every prunable tool result in order, so the newest can be spared.
  const sites: Array<{ message: number; part: number }> = [];
  messages.forEach((message, mi) => {
    if (message.role !== "tool" || !Array.isArray(message.content)) return;
    message.content.forEach((part, pi) => {
      if (!isToolResultPart(part)) return;
      const name = typeof part.toolName === "string" ? part.toolName : "";
      if (!PRUNE_DOCUMENT_TOOLS.has(name as DocumentToolName)) return;
      sites.push({ message: mi, part: pi });
    });
  });

  // Walk back from the newest result, keeping whole results until the budget
  // is spent. The newest is always kept, however large it is.
  let kept = 0;
  let keptChars = 0;
  for (let i = sites.length - 1; i >= 0; i--) {
    const site = sites[i]!;
    const message = messages[site.message]!;
    const part = Array.isArray(message.content) ? message.content[site.part] : undefined;
    const chars = sizeOf(outputValue((part as ToolCallPart | undefined)?.output));
    if (kept >= KEEP_RECENT_MIN && keptChars + chars > keepChars) break;
    kept += 1;
    keptChars += chars;
  }

  const cutoff = sites.length - kept;
  if (cutoff <= 0) return messages;

  const byMessage = new Map<number, number[]>();
  for (const site of sites.slice(0, cutoff)) {
    const list = byMessage.get(site.message) ?? [];
    list.push(site.part);
    byMessage.set(site.message, list);
  }

  let changed = false;
  const next = messages.map((message, mi) => {
    const parts = byMessage.get(mi);
    if (!parts || !Array.isArray(message.content)) return message;
    let messageChanged = false;
    const content = message.content.map((part, pi) => {
      if (!parts.includes(pi) || !isToolResultPart(part)) return part;
      const value = outputValue(part.output);
      if (alreadyCompacted(value)) return part;
      const name = String(part.toolName);
      const id = typeof part.toolCallId === "string" ? part.toolCallId : "";
      const summary = compactToolOutput(name, inputById.get(id), value);
      if (summary === value) return part;
      messageChanged = true;
      changed = true;
      return { ...part, output: { type: "text", value: summary } };
    });
    if (!messageChanged) return message;
    return { ...message, content } as M;
  });

  return changed ? next : messages;
}
