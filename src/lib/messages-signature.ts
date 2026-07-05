import { getToolName, isToolUIPart, type UIMessage } from "ai";
import type { PageWiseUIMessage } from "./message-metadata";

function toolOutputSig(output: unknown): string {
  if (typeof output === "string") {
    return `s${output.length}:${output.slice(0, 48)}`;
  }
  if (output && typeof output === "object") {
    try {
      const json = JSON.stringify(output);
      return `o${json.length}:${json.slice(0, 48)}`;
    } catch {
      return "o?";
    }
  }
  return "o0";
}

function metadataSig(message: UIMessage): string {
  const meta = (message as PageWiseUIMessage).metadata;
  if (!meta || typeof meta !== "object") return "";
  try {
    const json = JSON.stringify(meta);
    return `m${json.length}:${json.slice(0, 80)}`;
  } catch {
    return "m?";
  }
}

/** Stable signature for persistence dirty-checking (content-aware). */
export function messagesSignature(messages: UIMessage[]): string {
  let sig = `${messages.length}:`;
  for (const m of messages) {
    sig += `${m.id}#${m.role}#${metadataSig(m)}#`;
    if (!Array.isArray(m.parts)) {
      sig += "0;";
      continue;
    }
    sig += `${m.parts.length}:`;
    for (const part of m.parts) {
      if (part.type === "text" && "text" in part) {
        const text = typeof part.text === "string" ? part.text : "";
        sig += `t${text.length}:${text.slice(0, 64)};`;
      } else if (isToolUIPart(part)) {
        const name = getToolName(part);
        const out =
          part.state === "output-available" || part.state === "output-error"
            ? toolOutputSig(part.output)
            : "";
        sig += `u${name}#${part.state}${out};`;
      } else {
        sig += `${part.type};`;
      }
    }
    sig += ";";
  }
  return sig;
}
