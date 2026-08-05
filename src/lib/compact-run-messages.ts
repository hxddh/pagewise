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

/** Results left at full size — what the current step is reasoning over. */
export const KEEP_RECENT_TOOL_RESULTS = 4;

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

export function compactRunMessages<M extends ModelMessageLike>(
  messages: readonly M[] | undefined,
  keepRecent: number = KEEP_RECENT_TOOL_RESULTS,
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

  const cutoff = sites.length - Math.max(0, keepRecent);
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
