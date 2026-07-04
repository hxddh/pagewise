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

  return { id: m.id, role, parts: parts as UIMessage["parts"] };
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
