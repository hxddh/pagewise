import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// fileURLToPath, not `.pathname` — see scripts/css-hygiene.test.mjs for the two
// Windows release builds that idiom cost.
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * The field prepareCall carries the model messages on.
 *
 * `appendContextToLastUserMessage` builds the per-send hint — the active
 * document, the page the reader is viewing, the whole-document instructions,
 * and since 9.1 the record of what earlier questions established. agent.ts
 * appended it to `rest.messages`, which is `undefined`: prepareCall receives
 * the messages under `prompt`. So the hint was built every turn and thrown
 * away, and `messages: undefined` was returned, for as long as the code had
 * existed. Nothing failed. "This page" questions were resolving from the
 * user's own wording.
 *
 * Its own eight tests all passed and all were correct — they pass an array in
 * and assert on the array out, and that part always worked. The loss was one
 * layer above where they stop, in the name of the field the result is assigned
 * to, which no test of the function itself can reach. Found by dumping the
 * request body the provider actually receives.
 *
 * Asserted here rather than beside that function for a mechanical reason: this
 * reads a source file, and `src/` is type-checked with the browser tsconfig,
 * where `node:fs` has no types. `npm run build` catches that; `vitest` does
 * not, which is how the first version of this check reached CI.
 */
describe("the per-send hint's carrier", () => {
  const source = readFileSync(join(ROOT, "src/lib/agent.ts"), "utf8");

  it("is `prompt`, and agent.ts appends to that one", () => {
    const call = source.slice(source.indexOf("appendContextToLastUserMessage("));
    expect(
      call.slice(0, 200),
      "the hint must be appended to `rest.prompt` — `rest.messages` is undefined here",
    ).toContain("rest.prompt");
  });

  it("returns the appended copy as `prompt`, or it is discarded", () => {
    expect(source).toMatch(/\n\s*prompt: appendContextToLastUserMessage\(/);
    expect(
      source,
      "assigning it to `messages` puts it on a field the SDK does not read",
    ).not.toMatch(/\n\s*messages: appendContextToLastUserMessage\(/);
  });
});
