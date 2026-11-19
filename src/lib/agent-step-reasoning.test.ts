import { describe, expect, it } from "vitest";
import { stepReasoning } from "./agent";

/**
 * Which step of a run gets the reasoning effort it was configured with.
 *
 * The rule this replaced restored full effort only at `stepNumber >=
 * runMaxSteps - 1`, and its comment called that "the step that writes the
 * answer". It is not. A run ends when the model decides it has enough — step
 * three or four of a permitted twenty — so the step ceiling is reached only
 * when the run is being cut off.
 *
 * Measured against a real request before the change: a four-step run sent
 * `reasoning_effort: "low"` on all four, the answering step included, while
 * the run was configured for `medium`. Full effort was spent only in the one
 * situation where the model is being stopped mid-thought.
 *
 * No test could see that, because it is about which value a runtime callback
 * hands to a step. Extracting the rule is what makes it checkable at all.
 */
describe("reasoning effort per step", () => {
  it("is mechanical only while there is nothing to reason over", () => {
    // Step one is always "go find something".
    expect(stepReasoning("medium", false)).toBe("low");
  });

  it("is the run's own effort once anything has been read", () => {
    // From here any step might be the one that answers, and prepareStep cannot
    // know which — so it must not be the cheap one.
    expect(stepReasoning("medium", true)).toBe("medium");
    expect(stepReasoning("high", true)).toBe("high");
  });

  it("stays absent when the run asked for no reasoning at all", () => {
    expect(stepReasoning(undefined, false)).toBeUndefined();
    expect(stepReasoning(undefined, true)).toBeUndefined();
  });

  it("keeps low effort on search/outline-only and truncated range sweep steps", () => {
    expect(
      stepReasoning("medium", [{ toolCalls: [{ toolName: "document_outline" }] }]),
    ).toBe("low");
    expect(
      stepReasoning("medium", [
        {
          toolCalls: [{ toolName: "read_pdf_range" }],
          toolResults: [{ toolName: "read_pdf_range", output: { truncated: true } }],
        },
      ]),
    ).toBe("low");
    expect(
      stepReasoning("medium", [
        {
          toolCalls: [{ toolName: "read_pdf_page" }],
          toolResults: [{ toolName: "read_pdf_page", output: { truncated: false } }],
        },
      ]),
    ).toBe("medium");
  });
});
