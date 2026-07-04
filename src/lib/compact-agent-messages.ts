import type { ModelMessage } from "@ai-sdk/provider-utils";

const HEAVY_TOOLS = new Set([
  "read_pdf_page",
  "read_pdf_range",
  "search_in_document",
  "get_document_index",
]);
const STALE_TOOL_SNIPPET_CHARS = 360;
const OMIT_SUFFIX = "… [omitted from earlier step]";

function truncateText(text: string): string {
  if (text.length <= STALE_TOOL_SNIPPET_CHARS) return text;
  return `${text.slice(0, STALE_TOOL_SNIPPET_CHARS)}${OMIT_SUFFIX}`;
}

function isToolResultOutput(
  output: unknown,
): output is { type: string; value: unknown } {
  return (
    output != null &&
    typeof output === "object" &&
    "type" in output &&
    "value" in output &&
    typeof (output as { type: unknown }).type === "string"
  );
}

function compactJsonValue(value: unknown): unknown {
  if (typeof value === "string") return truncateText(value);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.text === "string") {
      const text = truncateText(obj.text);
      if (text === obj.text) return value;
      return { ...obj, text, truncated: true };
    }
    try {
      const json = JSON.stringify(value);
      if (json.length <= STALE_TOOL_SNIPPET_CHARS) return value;
      return {
        truncated: true,
        preview: `${json.slice(0, STALE_TOOL_SNIPPET_CHARS)}${OMIT_SUFFIX}`,
      };
    } catch {
      return value;
    }
  }
  return value;
}

/** Shrink a tool-result output while preserving the AI SDK ToolResultOutput envelope. */
function compactToolOutput(output: unknown): unknown {
  if (isToolResultOutput(output)) {
    switch (output.type) {
      case "text":
      case "error-text":
        if (typeof output.value === "string") {
          const value = truncateText(output.value);
          if (value === output.value) return output;
          return { ...output, value };
        }
        return output;
      case "json": {
        const value = compactJsonValue(output.value);
        if (value === output.value) return output;
        return { type: "json", value };
      }
      default:
        return output;
    }
  }

  if (typeof output === "string") {
    return { type: "text", value: truncateText(output) };
  }

  if (output && typeof output === "object") {
    const compacted = compactJsonValue(output);
    return { type: "json", value: compacted };
  }

  return output;
}

function shouldCompactToolResult(toolName: string): boolean {
  return HEAVY_TOOLS.has(toolName);
}

/** Shrink heavy tool outputs in older messages so multi-step runs send less context. */
export function compactStaleToolResults(
  messages: ModelMessage[],
  keepRecentMessages = 1,
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
        content: truncateText(message.content),
      };
    }

    if (!Array.isArray(message.content)) return message;

    let partChanged = false;
    const content = message.content.map((part) => {
      if (part.type === "tool-result" && shouldCompactToolResult(part.toolName)) {
        const compact = compactToolOutput(part.output);
        if (compact !== part.output) {
          partChanged = true;
          return { ...part, output: compact };
        }
      }
      return part;
    });

    if (!partChanged) return message;
    changed = true;
    return { ...message, content };
  });

  return changed ? (next as ModelMessage[]) : messages;
}
