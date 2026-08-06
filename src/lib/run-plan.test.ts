import { describe, expect, it } from "vitest";
import { runPlan } from "./run-plan";

const phase = (plan: ReturnType<typeof runPlan>, id: string) =>
  plan.find((p) => p.id === id)!;

describe("runPlan", () => {
  it("shows the whole shape before anything has happened", () => {
    const plan = runPlan({ buckets: [], running: true, answering: false });
    expect(plan.map((p) => p.id)).toEqual(["survey", "locate", "read", "answer"]);
    // A run that has not searched yet still shows that it will be able to.
    expect(phase(plan, "locate").state).toBe("pending");
  });

  it("marks the phase the run is actually in", () => {
    const plan = runPlan({ buckets: ["index", "search"], running: true, answering: false });
    expect(phase(plan, "survey").state).toBe("done");
    expect(phase(plan, "locate").state).toBe("active");
    expect(phase(plan, "read").state).toBe("pending");
  });

  it("counts the steps each phase took", () => {
    const plan = runPlan({
      buckets: ["index", "search", "read", "read", "read"],
      running: true,
      answering: false,
    });
    expect(phase(plan, "read").steps).toBe(3);
    expect(phase(plan, "survey").steps).toBe(1);
  });

  it("searching again after reading is still locating, not going backwards", () => {
    const plan = runPlan({
      buckets: ["search", "read", "search"],
      running: true,
      answering: false,
    });
    expect(phase(plan, "locate").state).toBe("active");
    expect(phase(plan, "read").state).toBe("done");
  });

  it("moves to answering when text starts arriving", () => {
    const plan = runPlan({ buckets: ["search", "read"], running: true, answering: true });
    expect(phase(plan, "answer").state).toBe("active");
    expect(phase(plan, "read").state).toBe("done");
  });

  it("a finished run has nothing still active", () => {
    const plan = runPlan({ buckets: ["search", "read"], running: false, answering: true });
    expect(plan.every((p) => p.state === "done")).toBe(true);
  });

  it("a run that answered with no tools at all is still coherent", () => {
    const plan = runPlan({ buckets: [], running: true, answering: true });
    expect(phase(plan, "answer").state).toBe("active");
    expect(phase(plan, "survey").state).toBe("done");
  });
});
