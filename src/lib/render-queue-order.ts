/**
 * Where a newly requested page render goes in the queue.
 *
 * Extracted from `enqueueRender` because the two branches it had disagreed with
 * each other. A high-priority request was inserted *before* the first non-high
 * item — which puts it behind every high already queued — unless the queue
 * happened to contain no low or thumb work at all, in which case it went to the
 * very front, ahead of them.
 *
 * Same request, two orderings, decided by something unrelated to it. And the
 * mixed case is the ordinary one: thumbnails are queued whenever the sidebar is
 * open, so scrolling quickly with it open rendered the page you landed on
 * *after* every page you had already scrolled past.
 *
 * The rule now: a high-priority render is what the reader is looking at right
 * now, so it goes to the front — ahead of older high work too. An earlier high
 * request is, by construction, for a page the viewport has since left; if it is
 * still wanted, its epoch keeps it alive and it runs next.
 */

export type RenderPriority = "high" | "low" | "thumb";

export interface PrioritisedItem {
  priority: RenderPriority;
}

/**
 * The index a new item should be spliced into, given the current queue.
 *
 * Pure so the ordering can be asserted without a PDF, a canvas or a worker.
 */
export function insertionIndex<T extends PrioritisedItem>(
  queue: readonly T[],
  priority: RenderPriority,
): number {
  // Newest viewport work first.
  if (priority === "high") return 0;
  // Everything else keeps its arrival order behind the high work.
  return queue.length;
}
