import { describe, expect, it } from "vitest";
import { getIndexUsageSnapshot, resetIndexUsageTracker } from "./usage-tracker";
import { imageBytesToDataUrl } from "./vision-api";

describe("imageBytesToDataUrl", () => {
  it("prefixes JPEG bytes with a data URL scheme", () => {
    const url = imageBytesToDataUrl(new Uint8Array([0xff, 0xd8, 0xff, 0xdb]));
    expect(url.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(url.includes("/9j/")).toBe(true);
  });
});

describe("generateVisionText usage", () => {
  it("records token usage from chat completion responses", async () => {
    resetIndexUsageTracker();
    const { generateVisionText } = await import("./vision-api");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "OK" } }],
          usage: { prompt_tokens: 42, completion_tokens: 7 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    try {
      const text = await generateVisionText(
        { provider: "openrouter", apiKey: "sk-test", model: "google/gemini-2.5-flash-lite" },
        "test",
        new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
        { attributeUsage: true },
      );
      expect(text).toBe("OK");
      expect(getIndexUsageSnapshot()).toEqual({ inputTokens: 42, outputTokens: 7 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does NOT record usage when attributeUsage is not set (background/prefetch)", async () => {
    resetIndexUsageTracker();
    const { generateVisionText } = await import("./vision-api");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "OK" } }],
          usage: { prompt_tokens: 42, completion_tokens: 7 },
        }),
        { status: 200 },
      )) as typeof fetch;
    try {
      await generateVisionText(
        { provider: "openrouter", apiKey: "sk-test", model: "google/gemini-2.5-flash-lite" },
        "test",
        new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      );
      // Default (no attribution): a background sweep / probe must not pollute the
      // per-send index-usage total.
      expect(getIndexUsageSnapshot()).toEqual({ inputTokens: 0, outputTokens: 0 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
