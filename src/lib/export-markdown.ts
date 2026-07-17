import type { UIMessage } from "ai";
import { isToolUIPart } from "ai";
import { stripDsmlToolMarkup } from "./agent-loop-guards";
import { findLastMessage } from "./messages-utils";

function messageText(message: UIMessage): string {
  const raw = message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  // Assistant text can carry leaked DSML tool markup that the chat UI strips
  // at render time — exports must strip it too.
  return (message.role === "assistant" ? stripDsmlToolMarkup(raw) : raw).trim();
}

function hasFilePart(message: UIMessage): boolean {
  return message.parts.some((p) => p.type === "file");
}

/** Web-search citations (source-url parts) attached to a message. */
function sourceUrls(message: UIMessage): Array<{ url: string; title?: string }> {
  const out: Array<{ url: string; title?: string }> = [];
  for (const p of message.parts) {
    if (p.type !== "source-url") continue;
    const src = p as { url?: unknown; title?: unknown };
    if (typeof src.url === "string" && src.url) {
      out.push({
        url: src.url,
        ...(typeof src.title === "string" && src.title ? { title: src.title } : {}),
      });
    }
  }
  return out;
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
    // A user turn whose text was reduced to a placeholder still sent an image
    // (page screenshot) — represent it instead of silently dropping the turn.
    if (!body && m.role === "user" && hasFilePart(m)) {
      lines.push(`## ${role}`, "", "_(image attachment)_", "");
      continue;
    }
    if (!body) continue;
    lines.push(`## ${role}`, "", body, "");

    const sources = sourceUrls(m);
    if (sources.length > 0) {
      lines.push("**Sources:**", "");
      for (const s of sources) {
        lines.push(`- [${s.title ?? s.url}](${s.url})`);
      }
      lines.push("");
    }
  }

  return lines.join("\n").trim() + "\n";
}

export function summaryToMarkdown(messages: UIMessage[], docName?: string): string {
  const lastAssistant = findLastMessage(messages, (m) => m.role === "assistant");
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
