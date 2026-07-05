import { describe, expect, it } from "vitest";
import { resolveIndexFailureReason } from "./vision-index";
import type { LlmSettings } from "./types";

const base: LlmSettings = {
  provider: "openrouter",
  apiKey: "sk-test",
  model: "google/gemini-2.5-flash-lite",
};

describe("resolveIndexFailureReason", () => {
  it("returns vision_failed when a vision model was tried and failed", () => {
    expect(
      resolveIndexFailureReason(base, true, true, false, false, false),
    ).toBe("vision_failed");
  });

  it("returns insufficient_text when vision and OCR both fail", () => {
    expect(
      resolveIndexFailureReason(base, true, true, true, false, false),
    ).toBe("insufficient_text");
  });

  it("returns vision_failed for auth errors even when OCR also fails", () => {
    expect(
      resolveIndexFailureReason(
        base,
        true,
        true,
        true,
        false,
        false,
        "Invalid API key",
      ),
    ).toBe("vision_failed");
  });

  it("returns need_vision when no vision model and no tesseract", () => {
    expect(
      resolveIndexFailureReason(
        { ...base, model: "deepseek-v4-flash" },
        false,
        false,
        true,
        false,
        false,
      ),
    ).toBe("need_vision");
  });
});
