import { ToolStepBucket } from "./tool-steps-summary";

/**
 * What a document run is doing, as a plan rather than a step number.
 *
 * A run over a document has a shape that is known before it starts: find your
 * way around, locate the relevant passages, read them, then answer from what
 * you read. The step counter added in 7.0 says *how far*; it never said
 * *through what*. A reader watching "Step 7" has no way to tell whether that is
 * halfway or nearly done, and no way to tell a run that is progressing from one
 * that is going in circles.
 *
 * This derives the plan from what has actually happened rather than asking the
 * model to declare one — a declared plan is another billed generation, and one
 * the model is free to ignore.
 */

export type PlanPhaseId = "survey" | "locate" | "read" | "answer";

export interface PlanPhase {
  id: PlanPhaseId;
  /** Not started, running now, or finished. */
  state: "pending" | "active" | "done";
  /** Steps that belonged to this phase. */
  steps: number;
}

const ORDER: PlanPhaseId[] = ["survey", "locate", "read", "answer"];

function phaseOf(bucket: ToolStepBucket): PlanPhaseId {
  switch (bucket) {
    case "index":
      return "survey";
    case "search":
      return "locate";
    case "read":
      return "read";
    default:
      return "read";
  }
}

export interface RunPlanInput {
  /** Buckets of the tool steps taken so far, oldest first. */
  buckets: ToolStepBucket[];
  /** True while the run is still going. */
  running: boolean;
  /** True once answer text has started arriving. */
  answering: boolean;
}

/**
 * The phases a run passes through, with the one it is in marked.
 *
 * A phase with no steps still appears: "this run never searched" is worth
 * seeing. Phases are ordered by how a document is worked through, not by when
 * they first happened — a run that searches again after reading has not gone
 * backwards, it is still locating.
 */
export function runPlan({ buckets, running, answering }: RunPlanInput): PlanPhase[] {
  const counts = new Map<PlanPhaseId, number>();
  for (const bucket of buckets) {
    const id = phaseOf(bucket);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const lastId = buckets.length > 0 ? phaseOf(buckets[buckets.length - 1]!) : null;
  const activeId: PlanPhaseId | null = !running
    ? null
    : answering
      ? "answer"
      : (lastId ?? "survey");

  return ORDER.map((id) => {
    const steps = counts.get(id) ?? 0;
    if (id === "answer") {
      return {
        id,
        steps: 0,
        state: activeId === "answer" ? "active" : answering || !running ? "done" : "pending",
      };
    }
    if (activeId === id) return { id, steps, state: "active" as const };
    // Anything with work behind it is done; anything the run has moved past
    // without using is done too, not left hanging as "pending".
    const passed = activeId != null && ORDER.indexOf(id) < ORDER.indexOf(activeId);
    return { id, steps, state: steps > 0 || passed || !running ? "done" : "pending" };
  });
}
