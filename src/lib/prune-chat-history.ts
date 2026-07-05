import { getToolName, isToolUIPart, type UIMessage } from "ai";

const PRUNE_TOOLS = new Set([
  "read_pdf_page",
  "read_pdf_range",
  "search_in_document",
  "get_document_index",
]);

/** Synthesized output for a tool call that never produced a real result. */
const CANCELLED_OUTPUT = "[cancelled]";

/** Replace bulky tool outputs in prior turns so follow-ups don't re-send full document text. */
export function pruneToolOutputsForHistory(messages: UIMessage[]): UIMessage[] {
  let changed = false;

  const next = messages.map((msg) => {
    if (msg.role !== "assistant") return msg;

    let msgChanged = false;
    const parts = msg.parts.map((part) => {
      if (!isToolUIPart(part) || part.state !== "output-available") return part;

      const name = getToolName(part);
      if (!PRUNE_TOOLS.has(name)) return part;

      const compact = compactToolOutput(name, part.input, part.output);
      if (compact === part.output) return part;

      msgChanged = true;
      changed = true;
      return { ...part, output: compact };
    });

    // Preserve identity for messages that were not actually modified so
    // downstream referential-equality checks (e.g. React memoization) hold.
    if (!msgChanged) return msg;
    return { ...msg, parts };
  });

  return changed ? next : messages;
}

/**
 * Strip or repair non-terminal tool parts (state `input-streaming` /
 * `input-available` with no matching output) by synthesizing a `[cancelled]`
 * output, so a Stop-mid-stream or a reload can't leave dangling tool_use parts
 * that break tool_use/tool_result pairing on the next request.
 */
export function sanitizeDanglingToolParts(messages: UIMessage[]): UIMessage[] {
  let changed = false;

  const next = messages.map((msg) => {
    if (msg.role !== "assistant") return msg;

    let msgChanged = false;
    const parts = msg.parts.map((part) => {
      if (!isToolUIPart(part)) return part;
      if (
        part.state !== "input-streaming" &&
        part.state !== "input-available"
      ) {
        return part;
      }

      msgChanged = true;
      changed = true;
      return {
        ...part,
        state: "output-available",
        input: part.input ?? {},
        output: CANCELLED_OUTPUT,
      } as (typeof msg.parts)[number];
    });

    if (!msgChanged) return msg;
    return { ...msg, parts };
  });

  return changed ? next : messages;
}

function compactToolOutput(
  name: string,
  input: unknown,
  output: unknown,
): string | Record<string, unknown> {
  const inp =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};

  if (name === "read_pdf_page" && typeof inp.page === "number") {
    const chars = textLength(output);
    return `[Read page ${inp.page}, ${chars} chars — omitted from chat history]`;
  }

  if (name === "read_pdf_range") {
    const start = inp.start;
    const end = inp.end;
    const range =
      typeof start === "number" && typeof end === "number"
        ? start === end
          ? `page ${start}`
          : `pages ${start}–${end}`
        : "page range";
    const chars = textLength(output);
    return `[Read ${range}, ${chars} chars — omitted from chat history]`;
  }

  if (name === "search_in_document") {
    const q = typeof inp.query === "string" ? inp.query : "query";
    const hits = Array.isArray(output) ? output.length : textLength(output);
    return `[Search "${q.slice(0, 40)}", ${hits} hits — omitted from chat history]`;
  }

  if (name === "get_document_index") {
    const chars = textLength(output);
    return `[Document index, ${chars} chars — omitted from chat history]`;
  }

  return output as string | Record<string, unknown>;
}

function textLength(output: unknown): number {
  if (typeof output === "string") return output.length;
  if (output && typeof output === "object") {
    const obj = output as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text.length;
    if (typeof obj.charCount === "number") return obj.charCount;
    // Fall back to a serialized size for object outputs lacking text/charCount
    // so we never mislabel real content as "0 chars".
    try {
      return JSON.stringify(output).length;
    } catch {
      return 0;
    }
  }
  return 0;
}
