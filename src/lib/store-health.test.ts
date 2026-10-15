import { afterEach, describe, expect, it } from "vitest";
import { __resetStoreHealthForTests, reportStoreProblem, subscribeStoreProblem } from "./store-health";

afterEach(() => __resetStoreHealthForTests());

describe("store problems are said again when they happen again (22.0)", () => {
  it("repeats a full record for a later refusal, not for a burst", () => {
    const seen: string[] = [];
    subscribeStoreProblem((r) => seen.push(r.problem));
    reportStoreProblem("findings.json", "full", 1_000);
    reportStoreProblem("findings.json", "full", 2_000);
    reportStoreProblem("findings.json", "full", 40_000);
    expect(seen).toEqual(["full", "full"]);
  });

  it("says a later version's file once", () => {
    const seen: string[] = [];
    subscribeStoreProblem((r) => seen.push(r.problem));
    reportStoreProblem("marks.json", "newer", 1_000);
    reportStoreProblem("marks.json", "newer", 100_000);
    expect(seen).toEqual(["newer"]);
  });
});
