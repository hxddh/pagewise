import { getToolName, isToolUIPart, type UIMessage } from "ai";

/** Stable signature for persistence dirty-checking (content-aware). */
export function messagesSignature(messages: UIMessage[]): string {
  let sig = `${messages.length}:`;
  for (const m of messages) {
    sig += `${m.id}#${m.role}#`;
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
        sig += `u${name}#${part.state};`;
      } else {
        sig += `${part.type};`;
      }
    }
    sig += ";";
  }
  return sig;
}
