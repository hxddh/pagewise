import type { UIMessage } from "ai";
import { isToolUIPart } from "ai";

function messageText(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

export function chatToMarkdown(messages: UIMessage[], docName?: string): string {
  const lines: string[] = ["# PageWise Chat Export", ""];

  if (docName) {
    lines.push(`**Document:** ${docName}`, "");
  }

  lines.push(`**Exported:** ${new Date().toLocaleString()}`, "", "---", "");

  for (const m of messages) {
    const role = m.role === "user" ? "You" : "Assistant";
    const body = messageText(m);
    if (!body && m.role === "assistant") {
      const tools = m.parts.filter((p) => isToolUIPart(p)).length;
      if (tools > 0) {
        lines.push(`## ${role}`, "", `_${tools} tool step(s)_`, "");
        continue;
      }
    }
    if (!body) continue;
    lines.push(`## ${role}`, "", body, "");
  }

  return lines.join("\n").trim() + "\n";
}

export function summaryToMarkdown(messages: UIMessage[], docName?: string): string {
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const summary = lastAssistant ? messageText(lastAssistant) : "";

  const lines: string[] = ["# PageWise Summary", ""];

  if (docName) {
    lines.push(`**Document:** ${docName}`, "");
  }

  lines.push(`**Generated:** ${new Date().toLocaleString()}`, "", "---", "");

  if (summary) {
    lines.push(summary, "");
  } else {
    lines.push("_No assistant response to export._", "");
  }

  return lines.join("\n").trim() + "\n";
}
