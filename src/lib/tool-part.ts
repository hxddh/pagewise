import type { DynamicToolUIPart, ToolUIPart, UIMessage } from "ai";

type AnyUIPart = UIMessage["parts"][number];

/**
 * Pure zero-SDK equivalent of `ai`'s `isToolUIPart` so cold-boot modules
 * (`read-pages`, `export-markdown`, `tool-steps-summary`) never pull the
 * 500 KB `ai` + 390 KB `zod` bundles into the initial entry chunk (28.0).
 */
export function isToolUIPart(
  part: AnyUIPart | { type: string },
): part is ToolUIPart | DynamicToolUIPart {
  return part.type === "dynamic-tool" || part.type.startsWith("tool-");
}

export function getToolName(part: ToolUIPart | DynamicToolUIPart | { type: string; toolName?: string }): string {
  if (part.type === "dynamic-tool") {
    return typeof (part as { toolName?: unknown }).toolName === "string"
      ? ((part as { toolName: string }).toolName)
      : "";
  }
  return part.type.startsWith("tool-") ? part.type.slice(5) : part.type;
}
