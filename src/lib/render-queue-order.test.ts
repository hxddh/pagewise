import { describe, expect, it } from "vitest";
import { insertionIndex, type PrioritisedItem, type RenderPriority } from "./render-queue-order";

interface Item extends PrioritisedItem {
  id: string;
}

function enqueue(queue: Item[], id: string, priority: RenderPriority): Item[] {
  const next = [...queue];
  next.splice(insertionIndex(next, priority), 0, { id, priority });
  return next;
}

const ids = (queue: readonly Item[]) => queue.map((q) => q.id);

describe("render queue order", () => {
  it("runs the newest visible page first", () => {
    // Scrolling from 1 to 3: page 3 is where the reader is now.
    let q: Item[] = [];
    q = enqueue(q, "p1", "high");
    q = enqueue(q, "p2", "high");
    q = enqueue(q, "p3", "high");
    expect(ids(q)).toEqual(["p3", "p2", "p1"]);
  });

  it("orders the same way whether or not thumbnails are queued", () => {
    // This is the bug: with a thumb in the queue, a new high went *behind* the
    // highs already there, so the page just scrolled to waited for the pages
    // scrolled past. Without a thumb, it went to the front. Same request.
    const withThumb = enqueue(
      enqueue(enqueue([], "p1", "high"), "t1", "thumb"),
      "p2",
      "high",
    );
    const withoutThumb = enqueue(enqueue([], "p1", "high"), "p2", "high");

    expect(ids(withThumb).filter((id) => id.startsWith("p"))).toEqual(
      ids(withoutThumb),
    );
    expect(ids(withThumb)[0]).toBe("p2");
  });

  it("keeps every high-priority render ahead of thumbnails and prefetch", () => {
    let q: Item[] = [];
    q = enqueue(q, "t1", "thumb");
    q = enqueue(q, "l1", "low");
    q = enqueue(q, "p1", "high");
    const firstNonHigh = q.findIndex((i) => i.priority !== "high");
    const lastHigh = q.map((i) => i.priority).lastIndexOf("high");
    expect(lastHigh).toBeLessThan(firstNonHigh);
  });

  it("leaves background work in the order it arrived", () => {
    let q: Item[] = [];
    q = enqueue(q, "t1", "thumb");
    q = enqueue(q, "t2", "thumb");
    q = enqueue(q, "l1", "low");
    expect(ids(q)).toEqual(["t1", "t2", "l1"]);
  });

  it("places the first item at the front whatever it is", () => {
    expect(insertionIndex([], "high")).toBe(0);
    expect(insertionIndex([], "thumb")).toBe(0);
  });
});
