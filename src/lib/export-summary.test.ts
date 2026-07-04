import { describe, expect, it } from "vitest";
import { streamObject, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { exportSummarySchema, summaryObjectToMarkdown } from "./export-summary";

describe("export-summary", () => {
  it("renders structured summary as markdown", () => {
    const md = summaryObjectToMarkdown(
      {
        title: "Quarterly review",
        overview: "Revenue increased year over year.",
        keyPoints: ["Revenue up", "Costs stable"],
      },
      "report.pdf",
    );

    expect(md).toContain("# Quarterly review");
    expect(md).toContain("**Document:** report.pdf");
    expect(md).toContain("- Revenue up");
  });

  it("streams object output via mock model", async () => {
    const { partialObjectStream, object } = streamObject({
      model: new MockLanguageModelV4({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "text-1" },
              {
                type: "text-delta",
                id: "text-1",
                delta:
                  '{"title":"Doc summary","overview":"Short overview.","keyPoints":["Point A"]}',
              },
              { type: "text-end", id: "text-1" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                logprobs: undefined,
                usage: {
                  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
                  outputTokens: { total: 20, text: 20, reasoning: undefined },
                },
              },
            ],
          }),
        }),
      }),
      schema: exportSummarySchema,
      prompt: "Summarize",
    });

    const partials: unknown[] = [];
    for await (const partial of partialObjectStream) {
      partials.push(partial);
    }

    const final = await object;
    expect(final.title).toBe("Doc summary");
    expect(partials.length).toBeGreaterThan(0);
  });
});
