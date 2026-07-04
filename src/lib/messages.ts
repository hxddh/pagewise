import type { UIMessage } from "ai";

export function lastAssistantSnippet(messages: UIMessage[], maxLen = 48): string | null {
  const last = [...messages].reverse().find((m) => m.role === "assistant");
  if (!last) return null;

  const text = last.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ")
    .trim();

  if (!text) return null;
  const chars = [...text];
  if (chars.length <= maxLen) return text;
  return `${chars.slice(0, maxLen).join("").trim()}…`;
}
