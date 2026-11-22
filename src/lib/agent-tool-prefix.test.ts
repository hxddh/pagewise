import { asSchema, fingerprintTools } from "ai";
import { describe, expect, it } from "vitest";
import { SYSTEM_INSTRUCTIONS } from "./agent";
import { createDocumentTools } from "./agent-tools";
import { newReadBudget } from "./agent-tools/reading";

/**
 * The tool block is the expensive half of the cached prefix, and it is silent.
 *
 * Every request puts the tool definitions ahead of the messages, so their bytes
 * are the first thing a provider caches and the first thing that invalidates
 * when they change. The prefix was measured at ~1,269 tokens, 736 of them these
 * six descriptions and schemas. Editing one word of a description is a normal,
 * harmless-looking change that costs a full re-read of the prefix on the next
 * question from every reader with a warm cache — and nothing anywhere says so.
 *
 * 7.1 already learned the same lesson from the other direction: dropping
 * `document_outline` from activeTools mid-run saved ~150 tokens a step and lost
 * the entire prefix for the rest of the run. That was caught by measurement
 * after the fact. This catches it before the commit.
 *
 * `fingerprintTools` digests exactly the server-controlled fields that go into
 * the request — description, resolved input schema, title — so a digest change
 * means the cached prefix changed, and an unchanged digest means it did not.
 * Refactoring a tool's implementation does not move these; editing its prose
 * does, which is the point.
 *
 * When one of these fails: if the change was deliberate, update the digest in
 * the same commit and say in the message what moved and why it was worth a
 * cache miss. If it was not, you have found an accidental cost.
 */

/**
 * The digest of each tool's prompt-visible definition.
 *
 * Written out here rather than kept in a snapshot file on purpose. The last two
 * releases were broken on Windows by a check that read a file — one on CRLF,
 * one on a path separator — and a literal in the test source has no encoding,
 * no line endings and no path to get wrong.
 */
const PROMPT_PREFIX_DIGESTS: Record<string, string> = {
  document_outline: "xU7wy5t-7njCbASQRrJz1IY7-dFM1aKn95duDRb9Jhw",
  // 29.0: `fullPage` fallback on `read_figure` (for vector/TikZ diagrams with
  // no bitmap XObject), `pages` batch array on `read_pdf_page` (up to 8
  // non-contiguous pages in one step), `start` continuation on `read_section`,
  // and `queries` multi-term synonym batch + PDF annotation search on
  // `search_in_document`. All four fit inside the existing 9,000B prefix gate.
  read_figure: "kvoVL-BPrNMEUr0_AFDQYcNUyQP2e1Mr5QKlJLBuOx8",
  read_pdf_page: "7pXUH2ItI5RvAIhe_SecRg-lu6ggQnKVPe9E9azozcI",
  read_pdf_range: "w2KcnFiiBpChZYJS3uBBFQlSyLkpsDX3T3r22RgGEYA",
  read_section: "AIKv3RqjdKA0E6w5h1tAU1g0EcmN3VeIcSE4L9-t-m8",
  search_in_document: "t6dkIeWrq_ckI5vg7gT3YTmD9a1LULHlY6qxHi7ZhXQ",
  // 9.0's two writers. Added deliberately, and they are not free: measured by
  // description + resolved input schema + name, they are 1,298 characters
  // against the six readers' 4,698 — 27.6%, or about +203 tokens on the 736
  // measured for the readers, taking the whole prefix from ~1,269 to ~1,472.
  //
  // That is a byte-proportional estimate, not a token count: there is no
  // tokenizer in this environment and two earlier token estimates in this
  // project were wrong precisely because they were asserted without one.
  //
  // The trade is deliberately lopsided in the wrong direction at 9.0: this cost
  // is paid on every request by every reader, while the saving it enables only
  // lands in 9.1, and only for documents whose pages get revisited. It is why
  // both descriptions are the shortest in this file, and why the acceptance
  // test for 9.1 is behavioural — the second run must not re-read the first
  // run's pages — rather than a token comparison nothing here can make.
  note_finding: "2N6GzR1YApBzSNp6e3seNzza2SPg9RcHZaxFlUYYoPM",
  revise_finding: "VHOxaiaEHpaMmwIn2o6lKHrCLQcMl7V_tXH5EMJKF44",
};

/**
 * The fixed prefix as the provider reads it, in UTF-8 bytes: the system
 * message text plus each tool's `{type: "function", function: {name,
 * description, parameters}}` entry, exactly as the OpenAI chat model converts
 * them (`@ai-sdk/openai`'s `prepareChatTools`).
 *
 * Built here rather than by calling the provider: the point is to measure what
 * leaves the app, and a helper that shares the conversion code would not notice
 * the conversion changing. `asSchema(...).jsonSchema` is the same conversion the
 * SDK's `prepareTools` uses, so the schema bytes match the wire.
 */
async function promptPrefixBytes(): Promise<{ total: number; system: number; tools: number }> {
  const tools = createDocumentTools(newReadBudget());
  const wire = await Promise.all(
    Object.entries(tools).map(async ([name, entry]) => {
      const tool = entry as { description?: string; inputSchema?: unknown };
      return {
        type: "function",
        function: {
          name,
          description: tool.description,
          parameters: await asSchema(tool.inputSchema as never).jsonSchema,
        },
      };
    }),
  );
  const encoder = new TextEncoder();
  const system = encoder.encode(SYSTEM_INSTRUCTIONS).length;
  const toolBytes = encoder.encode(JSON.stringify(wire)).length;
  return { total: system + toolBytes, system, tools: toolBytes };
}

describe("prompt cache prefix", () => {
  it("has not changed the tool definitions the provider caches", async () => {
    const tools = createDocumentTools(newReadBudget());
    const digests = await fingerprintTools(tools as never);

    expect(
      digests,
      "A tool's description, title or input schema changed. That is the cached " +
        "prefix, so every reader with a warm cache pays for it again on their " +
        "next question. If it was deliberate, update the digests here in the " +
        "same commit. (An `ai` upgrade can also move these — check the diff is " +
        "the whole tool set before assuming that is what happened.)",
    ).toEqual(PROMPT_PREFIX_DIGESTS);
  });

  // There was a second test here asserting the tool names matched the map's
  // keys, on the theory that a seventh tool could otherwise arrive unnoticed.
  // Removing a key to simulate that failed both tests, not one: `toEqual` on
  // the whole record already compares key sets, so the extra test guarded
  // nothing and only looked like coverage.

  /**
   * The prefix is paid on every step of every run — a twenty-step run re-sends
   * it twenty times — and it was 11,132 bytes (about 2,650–3,180 tokens) when
   * this budget was set. 18.0 trimmed it to fit 9,000; this is the line that
   * keeps it there. When this fails, trim the prose (a rule reworded is worth
   * more than a rule dropped) rather than raising the number.
   */
  it("keeps the fixed prefix inside its byte budget", async () => {
    const { total, system, tools } = await promptPrefixBytes();
    expect(
      total,
      `The fixed prefix is ${total} bytes: system prompt ${system}B + eight ` +
        `tool definitions ${tools}B. The budget is 9,000B — it is re-sent on ` +
        `every step of every run. Trim the prose (keep every rule's meaning) ` +
        `rather than raising this number.`,
    ).toBeLessThanOrEqual(9_000);
  });
});
