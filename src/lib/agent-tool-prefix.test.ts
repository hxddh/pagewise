import { fingerprintTools } from "ai";
import { describe, expect, it } from "vitest";
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
  document_outline: "DlydP-BxnDOX9g_NB1vj33IsxTYjnKDe61WkVN9dIG4",
  read_figure: "DZZNzFvpUbnTr3Gh6SSU1Nvdp82Xrg1cZAAYzFTe7dk",
  read_pdf_page: "3EC4JoI0hwaqAI2wZxkIE9HE1oDBCE80dGJH2y1ffdU",
  read_pdf_range: "TPzE6nqoYaLTzghpOJbN3V0cLUIzvp7ylyRH98enf1c",
  read_section: "LhN3IP2pTRh09c35zhg3ieDGZBX2dAncguJkApacZYs",
  search_in_document: "QTyUOwi1RfJ0tnrjjE3A82806M6iRRzVsHH2L9gQQ7c",
};

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
});
