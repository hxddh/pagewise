/**
 * A correction the reader types while the agent is still working.
 *
 * Before this, sending during a run stopped it and started a new one. The old
 * behaviour before *that* was to refuse the send outright, so stop-and-restart
 * was already an improvement — but its cost is real and its own comment
 * understated it: "page text stays in the local cache, so the new run picks
 * those pages up for free" is true of the vision scan and false of the tokens.
 * A discarded run's page reads go back into the new run's context at full price,
 * and on a twenty-step run over eight pages that is most of what was spent.
 *
 * So the note is handed to the run that is already going. It arrives as an extra
 * user message at the end of what the next step sees — after the last tool
 * result, which keeps every tool call paired with its result — and the model
 * reads it on its next turn of the loop. Nothing is stopped and nothing is
 * re-read.
 *
 * Queued per run generation. A note typed as one run ends must not leak into the
 * next one: the reader was correcting an answer they have now already got, and a
 * fresh question carries its own words.
 */

/** Longest note carried into a run. A correction is a sentence, not an essay. */
export const MAX_STEER_CHARS = 600;

/** How many corrections one run will carry. Beyond this the run is the problem. */
export const MAX_STEER_NOTES = 4;

interface Queued {
  generation: number;
  text: string;
}

let queue: Queued[] = [];
let currentGeneration = 0;

/**
 * The run a correction typed right now belongs to.
 *
 * The agent owns this number, not the UI: the composer has no way to know which
 * turn of the loop it is interrupting, and the hook that drives the chat keeps a
 * generation counter of its own that is not the same one. Called from
 * `prepareCall`, which is where a run begins.
 */
export function beginSteerRun(generation: number): void {
  currentGeneration = generation;
  // Notes from a finished run are not carried forward — see the module note.
  queue = queue.filter((q) => q.generation === generation);
}

export function currentSteerRun(): number {
  return currentGeneration;
}

/**
 * Queue a correction for the run identified by `generation`.
 *
 * Returns the text as it will be delivered, or null when there was nothing to
 * deliver — so a caller can tell whether to show it in the transcript.
 */
export function queueSteerNote(generation: number, text: string): string | null {
  const trimmed = text.trim().slice(0, MAX_STEER_CHARS);
  if (!trimmed) return null;
  if (queue.filter((q) => q.generation === generation).length >= MAX_STEER_NOTES) {
    return null;
  }
  queue.push({ generation, text: trimmed });
  return trimmed;
}

/**
 * Take everything queued for this run, leaving other runs' notes alone.
 *
 * Taking rather than reading: a note delivered twice would read to the model as
 * the reader saying it twice, and it is already in the messages from the step
 * that delivered it.
 */
export function takeSteerNotes(generation: number): string[] {
  const mine = queue.filter((q) => q.generation === generation).map((q) => q.text);
  if (mine.length > 0) queue = queue.filter((q) => q.generation !== generation);
  return mine;
}

/** Queue a correction for whichever run is going now. */
export function steerCurrentRun(text: string): string | null {
  return queueSteerNote(currentGeneration, text);
}

/** Anything still queued for this run, without taking it. */
export function hasSteerNotes(generation: number): boolean {
  return queue.some((q) => q.generation === generation);
}

/**
 * Corrections that never reached the model, and the queue emptied.
 *
 * A run can end before the step that would have carried a note — the reader
 * typed as the last answer was already being written. Dropping it silently would
 * lose words they typed, so the caller puts them back in the composer, the same
 * way a failed send restores its text.
 */
export function reclaimUndeliveredNotes(): string[] {
  const left = queue.map((q) => q.text);
  queue = [];
  return left;
}

/** Drop a run's notes — the run ended, or the reader stopped it. */
export function clearSteerNotes(generation?: number): void {
  queue = generation === undefined ? [] : queue.filter((q) => q.generation !== generation);
}

/**
 * How a correction is labelled to the model.
 *
 * Named as an interruption rather than dropped in bare, so the model treats it
 * as the reader changing the instruction mid-task instead of as one more thing
 * to answer at the end.
 */
export function steerMessageText(notes: readonly string[]): string {
  const body = notes.length === 1 ? notes[0]! : notes.map((n) => `- ${n}`).join("\n");
  return (
    "The reader interrupted while you were working and said:\n" +
    `${body}\n` +
    "Take this as a correction to what you were asked. Adjust what you do next; " +
    "do not restart from the beginning, and do not re-read pages you have already read."
  );
}

/** The message to append to a step's context, or null when nothing is queued. */
export function steerMessageFor(
  generation: number,
): { role: "user"; content: Array<{ type: "text"; text: string }> } | null {
  const notes = takeSteerNotes(generation);
  if (notes.length === 0) return null;
  return { role: "user", content: [{ type: "text", text: steerMessageText(notes) }] };
}

/**
 * A step's messages with the run's correction on the end, if there is one.
 *
 * The position is the whole safety argument. Providers validate that every tool
 * call is answered by a tool result, and a message inserted between them breaks
 * that — which is why `prepareStep`'s existing compaction only ever rewrites the
 * value inside a result and never adds or removes a message. Appending after the
 * last message adds nothing between a call and its result, because there is
 * nothing after the last message.
 *
 * Returns the same array when nothing is queued, so the caller can tell whether
 * to hand the SDK a replacement at all.
 */
export function withSteerMessage<M>(
  messages: readonly M[] | undefined,
  generation: number,
): readonly M[] | M[] {
  const steer = steerMessageFor(generation);
  if (!steer) return messages ?? [];
  return [...(messages ?? []), steer as unknown as M];
}
