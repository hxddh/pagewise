import { describe, expect, it } from "vitest";
import {
  computeGenerationSpeed,
  computeTimeToFirstTokenMs,
  computeTotalDurationMs,
  createUsageMetadataTracker,
  formatCompactTokenCount,
  formatDuration,
  formatGenerationSpeed,
  formatTokenCount,
  formatUsageSummaryLine,
} from "./message-metadata";

describe("message-metadata", () => {
  it("formats durations", () => {
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(420)).toBe("420ms");
    expect(formatDuration(1300)).toBe("1.3s");
  });

  it("formats token counts", () => {
    expect(formatTokenCount(undefined)).toBe("—");
    expect(formatTokenCount(2536)).toBe("2,536");
  });

  it("computes total duration with live clock", () => {
    const meta = { startedAt: 1000, finishedAt: 3000 };
    expect(computeTotalDurationMs(meta)).toBe(2000);
    expect(computeTotalDurationMs({ startedAt: 1000 }, 2500)).toBe(1500);
  });

  it("computes time to first token", () => {
    expect(
      computeTimeToFirstTokenMs({ startedAt: 1000, firstTokenAt: 2300 }),
    ).toBe(1300);
    expect(computeTimeToFirstTokenMs({ startedAt: 1000 })).toBeUndefined();
  });

  it("computes generation speed from output tokens", () => {
    const meta = {
      startedAt: 0,
      firstTokenAt: 1000,
      finishedAt: 2000,
      outputTokens: 472,
    };
    expect(computeGenerationSpeed(meta)).toBeCloseTo(472, 0);
    expect(formatGenerationSpeed(472)).toBe("472.0 T/s");
  });

  it("formats compact token counts", () => {
    expect(formatCompactTokenCount(850)).toBe("850");
    expect(formatCompactTokenCount(2500)).toBe("2.5k");
    expect(formatCompactTokenCount(25000)).toBe("25k");
  });

  it("formats usage summary with step count", () => {
    const line = formatUsageSummaryLine(
      {
        stepUsage: [
          { step: 0, inputTokens: 1000, outputTokens: 50 },
          { step: 1, inputTokens: 2000, outputTokens: 120 },
        ],
      },
      (key, vars) => `${key}:${JSON.stringify(vars)}`,
    );
    expect(line).toContain("usageSummaryWithSteps");
    expect(line).toContain('"steps":2');
  });

  it("emits live step totals on finish-step", () => {
    const tracker = createUsageMetadataTracker("gpt-test");
    const mid = tracker.messageMetadata({
      part: {
        type: "finish-step",
        usage: { inputTokens: 120, outputTokens: 15 },
      },
    });
    expect(mid?.inputTokens).toBe(120);
    expect(mid?.outputTokens).toBe(15);
    expect(mid?.stepUsage).toHaveLength(1);

    tracker.onStepEnd({
      stepNumber: 0,
      toolCalls: [{ toolName: "read_pdf_page" }],
    });

    const finish = tracker.messageMetadata({
      part: {
        type: "finish",
        totalUsage: { inputTokens: 120, outputTokens: 15, totalTokens: 135 },
      },
    });
    expect(finish?.stepUsage?.[0]?.toolNames).toEqual(["read_pdf_page"]);
  });

  it("collects per-step usage via onStepEnd", () => {
    const tracker = createUsageMetadataTracker("gpt-test");
    tracker.onStepEnd({
      stepNumber: 0,
      usage: { inputTokens: 100, outputTokens: 20 },
      toolCalls: [{ toolName: "search_in_document" }],
    });
    tracker.onStepEnd({
      stepNumber: 1,
      usage: { inputTokens: 200, outputTokens: 80 },
    });

    const finish = tracker.messageMetadata({
      part: {
        type: "finish",
        totalUsage: { inputTokens: 300, outputTokens: 100, totalTokens: 400 },
      },
    });

    expect(finish?.stepUsage).toHaveLength(2);
    expect(finish?.stepUsage?.[0]?.toolNames).toEqual(["search_in_document"]);
    expect(finish?.stepUsage?.[1]?.inputTokens).toBe(200);
  });
});
