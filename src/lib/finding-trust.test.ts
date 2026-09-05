import { describe, expect, it } from "vitest";
import { trustOf, TRUST_DOUBTFUL, TRUST_KNOWN, type TrustContext } from "./finding-trust";
import type { Finding } from "./finding-store";

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: "f1",
  pages: [2],
  claim: "The trial ran eight weeks.",
  evidence: "…eight weeks…",
  createdAt: 1,
  stamp: "s1",
  ...over,
});

const ctx = (over: Partial<TrustContext> = {}): TrustContext => ({
  stamp: "s1",
  totalPages: 10,
  all: [],
  placement: null,
  ...over,
});

const anchor = { page: 2, rects: [], bounds: { x: 0, y: 0, width: 1, height: 1 } };

/**
 * One trust state, read by the panel, the model context and the export.
 *
 * The 11.0 review found the same defect three times because there were four
 * signals and no rule. These are the rule.
 */
describe("trustOf", () => {
  it("is retracted when struck, superseded, or citing a page past the end", () => {
    expect(trustOf(finding({ struck: true }), ctx())).toBe("retracted");
    const old = finding();
    const revision = finding({ id: "f2", supersedes: "f1" });
    expect(trustOf(old, ctx({ all: [old, revision] }))).toBe("retracted");
    expect(trustOf(finding({ pages: [999] }), ctx({ totalPages: 3 }))).toBe("retracted");
    // No page count known: cannot be out of range.
    expect(trustOf(finding({ pages: [999] }), ctx({ totalPages: 0 }))).not.toBe("retracted");
  });

  it("is stale when the file changed, whatever the page says", () => {
    const located = { status: "located" as const, anchor };
    expect(trustOf(finding(), ctx({ stamp: "s2", placement: located }))).toBe("stale");
    // No stamp to compare against is not a claim of staleness.
    expect(trustOf(finding(), ctx({ stamp: "", placement: located }))).toBe("located");
  });

  it("follows the page when the file is the one the claim was written on", () => {
    expect(trustOf(finding(), ctx({ placement: { status: "located", anchor } }))).toBe("located");
    expect(trustOf(finding(), ctx({ placement: { status: "absent" } }))).toBe("unlocated");
    expect(trustOf(finding(), ctx({ placement: { status: "unreadable" } }))).toBe("unreadable");
    expect(trustOf(finding(), ctx({ placement: { status: "uncheckable" } }))).toBe("unverified");
    // Not looked yet is not a verdict either way.
    expect(trustOf(finding(), ctx({ placement: null }))).toBe("unverified");
  });

  it("lets the reader's word settle it — on this version of the file", () => {
    const confirmed = finding({ confirmedAt: 5 });
    expect(trustOf(confirmed, ctx({ placement: { status: "absent" } }))).toBe("confirmed");
    // Confirmed before the file changed: the reader has not seen this version.
    expect(trustOf(confirmed, ctx({ stamp: "s2" }))).toBe("stale");
    // Unless there is no stamp to say the file changed.
    expect(trustOf(confirmed, ctx({ stamp: "" }))).toBe("confirmed");
  });

  it("splits every state into known, doubtful, or neither", () => {
    for (const t of ["confirmed", "located", "unverified"] as const) {
      expect(TRUST_KNOWN.has(t)).toBe(true);
      expect(TRUST_DOUBTFUL.has(t)).toBe(false);
    }
    for (const t of ["unlocated", "unreadable", "stale"] as const) {
      expect(TRUST_DOUBTFUL.has(t)).toBe(true);
      expect(TRUST_KNOWN.has(t)).toBe(false);
    }
    expect(TRUST_KNOWN.has("retracted")).toBe(false);
    expect(TRUST_DOUBTFUL.has("retracted")).toBe(false);
  });
});
