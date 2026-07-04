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
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen).trim()}…`;
}
