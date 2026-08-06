import type { UIMessage } from "ai";

/**
 * What actually travels to the model, as opposed to what the reader can see.
 *
 * Two things were being paid for every turn that nobody was reading:
 *
 * 1. **Reasoning from earlier turns.** It is produced as billed output, stored
 *    with the message so its fold can be opened, and then — because
 *    `convertToModelMessages` faithfully turns a stored `reasoning` part back
 *    into reasoning content — sent again as input on every later turn. Ten
 *    turns in, each question pays for nine turns of old thinking. Providers do
 *    not need it: the answer that followed it is right there.
 *
 * 2. **Every turn, forever.** Tool outputs are already compacted between turns,
 *    but the questions and answers themselves grew without bound until a long
 *    session hit the model's context limit — which arrives as a failure rather
 *    than as a degradation.
 *
 * Both are trimmed on the way out only. The transcript on screen and on disk
 * keeps everything.
 */

/** Turns kept verbatim. Older ones survive as one line saying they existed. */
export const KEEP_RECENT_TURNS = 12;

/** A user turn and the assistant turn that answered it count as one turn. */
function turnBoundaries(messages: UIMessage[]): number[] {
  const starts: number[] = [];
  messages.forEach((message, i) => {
    if (message.role === "user") starts.push(i);
  });
  return starts;
}

export function stripReasoningParts<M extends UIMessage>(messages: M[]): M[] {
  let changed = false;
  const next = messages.map((message) => {
    if (message.role !== "assistant") return message;
    const parts = message.parts.filter((part) => part.type !== "reasoning");
    if (parts.length === message.parts.length) return message;
    changed = true;
    return { ...message, parts } as M;
  });
  return changed ? next : messages;
}

/**
 * Replace everything before the last `keep` turns with a single note.
 *
 * The note is assembled locally from the messages themselves — no model call to
 * summarize a conversation, which would be paying to save money.
 */
export function windowHistory<M extends UIMessage>(
  messages: M[],
  keep: number = KEEP_RECENT_TURNS,
): M[] {
  const starts = turnBoundaries(messages);
  if (starts.length <= keep) return messages;

  const cutIndex = starts[starts.length - keep]!;
  if (cutIndex <= 0) return messages;

  const droppedTurns = starts.length - keep;
  const questions: string[] = [];
  for (const start of starts.slice(0, droppedTurns)) {
    const text = firstText(messages[start]);
    if (text) questions.push(text.length > 60 ? `${text.slice(0, 60)}…` : text);
  }

  const note =
    `[Earlier in this conversation: ${droppedTurns} exchange` +
    `${droppedTurns === 1 ? "" : "s"}` +
    (questions.length > 0 ? ` about — ${questions.join("; ")}` : "") +
    ". Their full text is omitted here; ask the user if you need it.]";

  const summary = {
    id: `history-window-${cutIndex}`,
    role: "user",
    parts: [{ type: "text", text: note }],
  } as unknown as M;

  return [summary, ...messages.slice(cutIndex)];
}

function firstText(message: UIMessage | undefined): string {
  if (!message) return "";
  for (const part of message.parts) {
    if (part.type === "text" && part.text?.trim()) {
      return part.text.trim().replace(/\s+/g, " ");
    }
  }
  return "";
}

/** Everything above, in the order the send path wants it. */
export function prepareHistoryForModel<M extends UIMessage>(
  messages: M[],
  keep: number = KEEP_RECENT_TURNS,
): M[] {
  return windowHistory(stripReasoningParts(messages), keep);
}
