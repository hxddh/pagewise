import type { ModelMessage } from "@ai-sdk/provider-utils";

const READ_TOOLS = new Set(["read_pdf_page", "read_pdf_range"]);
const STALE_TOOL_SNIPPET_CHARS = 480;

function compactToolOutput(output: unknown): unknown {
  if (typeof output === "string") {
    if (output.length <= STALE_TOOL_SNIPPET_CHARS) return output;
    return `${output.slice(0, STALE_TOOL_SNIPPET_CHARS)}… [omitted from earlier step]`;
  }
  if (output && typeof output === "object") {
    const obj = output as Record<string, unknown>;
    if (typeof obj.text === "string" && obj.text.length > STALE_TOOL_SNIPPET_CHARS) {
      return {
        ...obj,
        text: `${obj.text.slice(0, STALE_TOOL_SNIPPET_CHARS)}… [omitted from earlier step]`,
        truncated: true,
      };
    }
    try {
      const json = JSON.stringify(output);
      if (json.length <= STALE_TOOL_SNIPPET_CHARS) return output;
      return `${json.slice(0, STALE_TOOL_SNIPPET_CHARS)}… [omitted from earlier step]`;
    } catch {
      return output;
    }
  }
  return output;
}

/** Shrink read-tool outputs in older messages so multi-step runs send less context. */
export function compactStaleToolResults(
  messages: ModelMessage[],
  keepRecentMessages = 2,
): ModelMessage[] {
  const threshold = Math.max(0, messages.length - keepRecentMessages);
  let changed = false;

  const next = messages.map((message, index) => {
    if (index >= threshold) return message;
    if (message.role !== "assistant" && message.role !== "tool") return message;

    if (typeof message.content === "string") {
      if (message.role === "tool" || message.content.length <= STALE_TOOL_SNIPPET_CHARS) {
        return message;
      }
      changed = true;
      return {
        ...message,
        content: `${message.content.slice(0, STALE_TOOL_SNIPPET_CHARS)}… [omitted from earlier step]`,
      };
    }

    if (!Array.isArray(message.content)) return message;

    let partChanged = false;
    const content = message.content.map((part) => {
      if (part.type === "tool-result" && READ_TOOLS.has(part.toolName)) {
        const compact = compactToolOutput(part.output);
        if (compact !== part.output) {
          partChanged = true;
          return { ...part, output: compact };
        }
      }
      if (part.type === "tool-call" && READ_TOOLS.has(part.toolName)) {
        return part;
      }
      return part;
    });

    if (!partChanged) return message;
    changed = true;
    return { ...message, content };
  });

  return changed ? (next as ModelMessage[]) : messages;
}
