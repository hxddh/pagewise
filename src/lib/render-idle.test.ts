import { describe, expect, it } from "vitest";
import { createRenderIdleGate } from "./render-idle";

describe("the render idle gate", () => {
  it("opens immediately when nothing is held", async () => {
    const gate = createRenderIdleGate();
    let opened = false;
    void gate.whenIdle().then(() => {
      opened = true;
    });
    await Promise.resolve();
    expect(opened).toBe(true);
  });

  it("holds detached work until the last reader-facing render is done", async () => {
    const gate = createRenderIdleGate();
    const order: string[] = [];
    gate.hold();
    gate.hold();
    void gate.whenIdle().then(() => order.push("ocr"));
    gate.release();
    await Promise.resolve();
    expect(order).toEqual([]);
    gate.release();
    await Promise.resolve();
    expect(order).toEqual(["ocr"]);
  });

  it("opens once for every waiter, and re-closes for the next hold", async () => {
    const gate = createRenderIdleGate();
    const order: string[] = [];
    gate.hold();
    void gate.whenIdle().then(() => order.push("first"));
    void gate.whenIdle().then(() => order.push("second"));
    gate.release();
    await Promise.resolve();
    expect(order).toEqual(["first", "second"]);

    // A later hold is a new reader-facing render; a new ask waits for it.
    gate.hold();
    let third = false;
    void gate.whenIdle().then(() => {
      third = true;
    });
    await Promise.resolve();
    expect(third).toBe(false);
    gate.release();
    await Promise.resolve();
    expect(third).toBe(true);
  });

  it("does not go negative on a stray release", async () => {
    const gate = createRenderIdleGate();
    gate.release();
    let opened = false;
    void gate.whenIdle().then(() => {
      opened = true;
    });
    await Promise.resolve();
    expect(opened).toBe(true);
  });
});
