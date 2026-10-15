import { describe, expect, it } from "vitest";
import { citationLevel, countLevels, recordLevel } from "./trust-level";

describe("three levels for the reader (16.0)", () => {
  it("maps every citation status", () => {
    expect(citationLevel("located")).toBe("verified");
    for (const s of ["mismatch", "unconfirmed", "unreadable"] as const) expect(citationLevel(s)).toBe("check");
    for (const s of ["unlocated", "outOfRange"] as const) expect(citationLevel(s)).toBe("notFound");
    // A quote too short to check is a state of its own (20.0), but makes no
    // claim either way — the same level as a page-only citation.
    for (const s of ["unchecked", "tooShort", "pending"] as const) expect(citationLevel(s)).toBe("none");
  });

  it("lets a contradicting review lower a citation, never raise it", () => {
    expect(citationLevel("located", "contradicts")).toBe("notFound");
    expect(citationLevel("mismatch", "supports")).toBe("check");
    expect(citationLevel("located", "supports")).toBe("verified");
    expect(citationLevel("outOfRange", "supports")).toBe("notFound");
    expect(citationLevel("unconfirmed", "supports")).toBe("check");
    expect(citationLevel("unchecked", "contradicts")).toBe("none");
    expect(citationLevel("tooShort", "contradicts")).toBe("none");
  });

  it("maps every record trust", () => {
    expect(recordLevel("confirmed")).toBe("verified");
    expect(recordLevel("stale")).toBe("check");
    expect(recordLevel("retracted")).toBe("notFound");
    expect(recordLevel("unverified")).toBe("none");
  });

  it("counts", () => {
    expect(countLevels(["verified", "verified", "check", "none"])).toEqual({ verified: 2, check: 1, notFound: 0, none: 1 });
  });

  it("reads words not found, on a page the model says supports the sentence, as check — never verified (22.0)", () => {
    expect(citationLevel("unlocated", "supports")).toBe("check");
    expect(citationLevel("unlocated", "insufficient")).toBe("notFound");
    expect(citationLevel("unlocated", "contradicts")).toBe("notFound");
  });
});
