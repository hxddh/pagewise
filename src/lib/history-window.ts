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

/**
 * How many turns the window slides by when it moves.
 *
 * It used to slide by one, which quietly cost more than the windowing saved.
 * The note sits at the very front of the messages, so its text is part of every
 * provider's cache prefix — and a note that names the number of dropped turns
 * and quotes them changes on every single turn once windowing starts. From that
 * turn on, each question was a full cache miss on the whole conversation: the
 * twelve kept turns were re-bought at full price every time, where an unwindowed
 * conversation would have read almost all of them from the cache.
 *
 * Moving in steps makes the prefix byte-identical for `WINDOW_STEP` turns at a
 * time, so one turn in four pays the miss instead of all four. The kept-turn
 * count therefore floats between `keep` and `keep + WINDOW_STEP - 1`, which is
 * the price of the cache staying warm.
 */
export const WINDOW_STEP = 4;

/**
 * Questions from dropped turns quoted in the note.
 *
 * Every dropped question used to be quoted, at up to 60 characters each, in a
 * line describing itself as a summary — so the note grew without bound exactly
 * as the conversation it was compacting did. A hundred turns in it was several
 * thousand characters of uncacheable prefix.
 */
const NOTE_QUESTIONS = 6;

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
  const next: M[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") {
      next.push(message);
      continue;
    }
    const parts = message.parts.filter((part) => part.type !== "reasoning");
    if (parts.length === message.parts.length) {
      next.push(message);
      continue;
    }
    changed = true;
    // A reply that was only reasoning — a run stopped while it was still
    // thinking — becomes an empty message once the reasoning goes. Providers
    // reject those, and the send path's empty-message guard already ran before
    // this point, so the message has to go with it.
    if (parts.length === 0) continue;
    next.push({ ...message, parts } as M);
  }
  return changed ? next : messages;
}

/**
 * Replace everything before the last `keep` turns with a single note.
 *
 * The note is assembled locally from the messages themselves — no model call to
 * summarize a conversation, which would be paying to save money.
 */
/**
 * How many turns to drop, given how many there are.
 *
 * Quantized to `step` so the answer — and therefore the cut point, the note and
 * the whole cached prefix — stays put for `step` turns at a time. Pure, so the
 * stability can be asserted without building a conversation.
 */
export function droppedTurnCount(
  total: number,
  keep: number = KEEP_RECENT_TURNS,
  step: number = WINDOW_STEP,
): number {
  if (step < 1) return Math.max(0, total - keep);
  if (total <= keep) return 0;
  return Math.floor((total - keep) / step) * step;
}

export function windowHistory<M extends UIMessage>(
  messages: M[],
  keep: number = KEEP_RECENT_TURNS,
  step: number = WINDOW_STEP,
): M[] {
  const starts = turnBoundaries(messages);
  const droppedTurns = droppedTurnCount(starts.length, keep, step);
  if (droppedTurns === 0) return messages;

  const cutIndex = starts[droppedTurns]!;
  if (cutIndex <= 0) return messages;

  // The most recent of the dropped questions: the ones a follow-up is likeliest
  // to be reaching back to. Older ones are counted, not quoted.
  const questions: string[] = [];
  for (const start of starts.slice(0, droppedTurns).slice(-NOTE_QUESTIONS)) {
    const text = firstText(messages[start]);
    if (text) questions.push(text.length > 60 ? `${text.slice(0, 60)}…` : text);
  }

  const note =
    `[Earlier in this conversation: ${droppedTurns} exchange` +
    `${droppedTurns === 1 ? "" : "s"}` +
    (questions.length > 0
      ? `, the most recent about — ${questions.join("; ")}`
      : "") +
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
  step: number = WINDOW_STEP,
): M[] {
  return windowHistory(stripReasoningParts(messages), keep, step);
}
