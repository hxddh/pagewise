import { describe, expect, it } from "vitest";
import { claimFromAnswer } from "./keep-answer";

const long = (n: number) => "word ".repeat(n).trim();

/**
 * What a kept answer looks like in the record.
 *
 * The reader keeps an answer because they judged it worth keeping; the entry
 * they see later has to be readable enough to judge again. A claim severed
 * mid-word reads as corruption, not as a summary.
 */
describe("keeping an answer as a claim", () => {
  it("leaves a short answer exactly as it was", () => {
    expect(claimFromAnswer("The trial ran eight weeks.")).toBe("The trial ran eight weeks.");
  });

  it("collapses the whitespace an answer's markdown leaves behind", () => {
    expect(claimFromAnswer("One.\n\nTwo.\n")).toBe("One. Two.");
  });

  it("keeps whole sentences when it has to cut", () => {
    const text = `${"A".repeat(300)}. ${"B".repeat(300)}. ${"C".repeat(300)}.`;
    const out = claimFromAnswer(text, 500);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out.endsWith("."), "a cut must land on a sentence end").toBe(true);
    expect(out).not.toContain("B".repeat(10));
  });

  it("splits a Chinese answer too", () => {
    // "." alone would never split this, and the app ships in two languages.
    const text = `${"甲".repeat(300)}。${"乙".repeat(300)}。`;
    const out = claimFromAnswer(text, 400);
    expect(out.endsWith("。")).toBe(true);
    expect(out).not.toContain("乙");
  });

  it("falls back to whole words when no sentence fits", () => {
    const out = claimFromAnswer(long(400), 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith("…"), "a word-level cut must say it was cut").toBe(true);
    expect(out).not.toMatch(/\bwor…$/);
  });
});
