import type { UIMessage } from "ai";

/** Coerce persisted / legacy chat rows into valid UIMessage shape. */
export function normalizeUIMessage(raw: unknown): UIMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const role = m.role;
  if (role !== "user" && role !== "assistant" && role !== "system") return null;
  if (typeof m.id !== "string" || !m.id) return null;

  let parts = m.parts;
  if (!Array.isArray(parts)) {
    if (typeof m.content === "string") {
      parts = [{ type: "text", text: m.content }];
    } else {
      parts = [];
    }
  }

  const metadata = m.metadata;
  return {
    id: m.id,
    role,
    parts: parts as UIMessage["parts"],
    ...(metadata != null && typeof metadata === "object" ? { metadata } : {}),
  };
}

export function normalizeUIMessages(raw: unknown): UIMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: UIMessage[] = [];
  for (const item of raw) {
    const msg = normalizeUIMessage(item);
    if (msg) out.push(msg);
  }
  return out;
}

/** Last message in the thread, if any. */
export function getLastMessage(messages: UIMessage[]): UIMessage | undefined {
  return messages.length > 0 ? messages[messages.length - 1] : undefined;
}

/** True while a user turn was sent but the assistant row is not in messages yet. */
export function isAwaitingAssistantReply(
  messages: UIMessage[],
  busy: boolean,
): boolean {
  if (!busy) return false;
  return getLastMessage(messages)?.role === "user";
}

/**
 * The assistant message currently being streamed, if any.
 * Avoids mistaking the previous turn's assistant message during a new run.
 */
export function getInFlightAssistantMessage(
  messages: UIMessage[],
  busy: boolean,
): UIMessage | undefined {
  if (!busy) return undefined;
  const last = getLastMessage(messages);
  if (!last || last.role !== "assistant") return undefined;
  return last;
}

export function hasSubstantialAssistantText(
  message: UIMessage | undefined,
  minChars = 8,
): boolean {
  if (!message) return false;
  return message.parts.some((p) => {
    if (p.type !== "text" && p.type !== "reasoning") return false;
    return (p.text?.trim().length ?? 0) >= minChars;
  });
}

/** True when the assistant is visibly streaming answer text (not reasoning-only). */
export function hasSubstantialAnswerText(
  message: UIMessage | undefined,
  minChars = 8,
): boolean {
  if (!message) return false;
  return message.parts.some((p) => {
    if (p.type !== "text") return false;
    return (p.text?.trim().length ?? 0) >= minChars;
  });
}

/** Find the last message matching predicate without allocating a reversed copy. */
export function findLastMessage(
  messages: UIMessage[],
  predicate: (m: UIMessage) => boolean,
): UIMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && predicate(m)) return m;
  }
  return undefined;
}

export function extractUserText(message: UIMessage): string {
  const parts: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text" && part.text?.trim()) parts.push(part.text.trim());
  }
  return parts.join("\n");
}

export function extractAssistantText(message: UIMessage): string {
  const parts: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text" && part.text?.trim()) parts.push(part.text.trim());
    else if (part.type === "reasoning" && part.text?.trim()) parts.push(part.text.trim());
  }
  return parts.join("\n\n").trim();
}

export function extractToolExcerpts(message: UIMessage, max = 6000): string {
  const chunks: string[] = [];
  for (const part of message.parts) {
    if (part.type.startsWith("tool-") && "output" in part && part.output) {
      const out =
        typeof part.output === "string" ? part.output : JSON.stringify(part.output);
      if (out.trim()) chunks.push(out.trim().slice(0, 1200));
    }
  }
  return chunks.join("\n---\n").slice(0, max);
}
