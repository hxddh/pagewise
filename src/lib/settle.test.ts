import { describe, expect, it } from "vitest";
import { createSettler } from "./settle";

/** A hand-driven clock, so these tests assert ordering rather than wall time. */
function fakeClock() {
  let next = 1;
  const pending = new Map<number, () => void>();
  return {
    schedule(fn: () => void, _ms: number) {
      const handle = next++;
      pending.set(handle, fn);
      return handle;
    },
    clear(handle: number) {
      pending.delete(handle);
    },
    /** Fire everything still scheduled. */
    run() {
      const due = [...pending.entries()];
      pending.clear();
      for (const [, fn] of due) fn();
    },
    get pendingCount() {
      return pending.size;
    },
  };
}

describe("createSettler", () => {
  it("reports a value that stops changing", () => {
    const clock = fakeClock();
    const seen: number[] = [];
    const settler = createSettler(500, (v: number) => seen.push(v), clock.schedule, clock.clear);

    settler.push(7);
    expect(seen).toEqual([]);
    clock.run();
    expect(seen).toEqual([7]);
  });

  it("reports only the last of a burst — the pages scrolled past cost nothing", () => {
    const clock = fakeClock();
    const seen: number[] = [];
    const settler = createSettler(500, (v: number) => seen.push(v), clock.schedule, clock.clear);

    for (let page = 1; page <= 200; page++) settler.push(page);
    clock.run();

    expect(seen).toEqual([200]);
  });

  it("does not re-report a value it already reported", () => {
    const clock = fakeClock();
    const seen: number[] = [];
    const settler = createSettler(500, (v: number) => seen.push(v), clock.schedule, clock.clear);

    settler.push(3);
    clock.run();
    settler.push(3);
    expect(clock.pendingCount).toBe(0);
    clock.run();

    expect(seen).toEqual([3]);
  });

  it("reports again when the value leaves and comes back", () => {
    const clock = fakeClock();
    const seen: number[] = [];
    const settler = createSettler(500, (v: number) => seen.push(v), clock.schedule, clock.clear);

    settler.push(3);
    clock.run();
    settler.push(4);
    clock.run();
    settler.push(3);
    clock.run();

    expect(seen).toEqual([3, 4, 3]);
  });

  it("scrolling back to where you started before it settles reports nothing new", () => {
    const clock = fakeClock();
    const seen: number[] = [];
    const settler = createSettler(500, (v: number) => seen.push(v), clock.schedule, clock.clear);

    settler.push(10);
    clock.run();
    settler.push(11);
    settler.push(12);
    settler.push(10);
    clock.run();

    expect(seen).toEqual([10]);
  });

  it("cancel drops a pending report", () => {
    const clock = fakeClock();
    const seen: number[] = [];
    const settler = createSettler(500, (v: number) => seen.push(v), clock.schedule, clock.clear);

    settler.push(1);
    settler.cancel();
    clock.run();

    expect(seen).toEqual([]);
    expect(clock.pendingCount).toBe(0);
  });

  it("keeps waiting while the value is still moving", () => {
    const clock = fakeClock();
    const seen: number[] = [];
    const settler = createSettler(500, (v: number) => seen.push(v), clock.schedule, clock.clear);

    settler.push(1);
    settler.push(2);
    // The first timer was cleared, so only the latest is outstanding.
    expect(clock.pendingCount).toBe(1);
    clock.run();

    expect(seen).toEqual([2]);
  });
});
