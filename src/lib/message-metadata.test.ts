import { describe, expect, it } from "vitest";
import {
  computeGenerationSpeed,
  computeTimeToFirstTokenMs,
  computeTotalDurationMs,
  createUsageMetadataTracker,
  formatDuration,
  formatGenerationSpeed,
  formatTokenCount,
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
