import { getToolName, isToolUIPart, type UIMessage } from "ai";

const PRUNE_TOOLS = new Set(["read_pdf_page", "read_pdf_range"]);

/** Replace bulky tool outputs in prior turns so follow-ups don't re-send full document text. */
export function pruneToolOutputsForHistory(messages: UIMessage[]): UIMessage[] {
  let changed = false;

  const next = messages.map((msg) => {
    if (msg.role !== "assistant") return msg;

    const parts = msg.parts.map((part) => {
      if (!isToolUIPart(part) || part.state !== "output-available") return part;

      const name = getToolName(part);
      if (!PRUNE_TOOLS.has(name)) return part;

      const compact = compactToolOutput(name, part.input, part.output);
      if (compact === part.output) return part;

      changed = true;
      return { ...part, output: compact };
    });

    if (parts === msg.parts) return msg;
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

  return output as string | Record<string, unknown>;
}

function textLength(output: unknown): number {
  if (typeof output === "string") return output.length;
  if (output && typeof output === "object") {
    if ("text" in output && typeof (output as { text: unknown }).text === "string") {
      return (output as { text: string }).text.length;
    }
    if ("charCount" in output && typeof (output as { charCount: unknown }).charCount === "number") {
      return (output as { charCount: number }).charCount;
    }
  }
  return 0;
}
