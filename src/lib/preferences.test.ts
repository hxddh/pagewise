import { describe, expect, it } from "vitest";
import {
  AGENT_SCAN_PAGE_CHOICES,
  AUTO_INDEX_PAGE_CHOICES,
  DEFAULT_PREFERENCES,
  sanitizePreferences,
} from "./preferences";

const AUTO_MAX = AUTO_INDEX_PAGE_CHOICES[AUTO_INDEX_PAGE_CHOICES.length - 1]!;
const AGENT_MAX = AGENT_SCAN_PAGE_CHOICES[AGENT_SCAN_PAGE_CHOICES.length - 1]!;

describe("sanitizePreferences — scan budgets", () => {
  it("falls back to the defaults for missing or non-numeric values", () => {
    expect(sanitizePreferences({}).autoIndexPages).toBe(DEFAULT_PREFERENCES.autoIndexPages);
    expect(sanitizePreferences({}).agentScanPages).toBe(DEFAULT_PREFERENCES.agentScanPages);
    const garbage = sanitizePreferences({ autoIndexPages: "50", agentScanPages: null });
    expect(garbage.autoIndexPages).toBe(DEFAULT_PREFERENCES.autoIndexPages);
    expect(garbage.agentScanPages).toBe(DEFAULT_PREFERENCES.agentScanPages);
  });

  it("keeps 0, which means the corresponding scanning is off", () => {
    const off = sanitizePreferences({ autoIndexPages: 0, agentScanPages: 0 });
    expect(off.autoIndexPages).toBe(0);
    expect(off.agentScanPages).toBe(0);
  });

  it("clamps out-of-range values instead of letting them become billed calls", () => {
    const wild = sanitizePreferences({ autoIndexPages: 99_999, agentScanPages: 99_999 });
    expect(wild.autoIndexPages).toBe(AUTO_MAX);
    expect(wild.agentScanPages).toBe(AGENT_MAX);

    const negative = sanitizePreferences({ autoIndexPages: -5, agentScanPages: -1 });
    expect(negative.autoIndexPages).toBe(0);
    expect(negative.agentScanPages).toBe(0);
  });

  it("rejects NaN/Infinity, which would otherwise defeat every comparison", () => {
    const broken = sanitizePreferences({
      autoIndexPages: Number.NaN,
      agentScanPages: Number.POSITIVE_INFINITY,
    });
    expect(broken.autoIndexPages).toBe(DEFAULT_PREFERENCES.autoIndexPages);
    expect(broken.agentScanPages).toBe(DEFAULT_PREFERENCES.agentScanPages);
  });

  it("floors fractional values to whole pages", () => {
    expect(sanitizePreferences({ autoIndexPages: 20.9 }).autoIndexPages).toBe(20);
    expect(sanitizePreferences({ agentScanPages: 10.7 }).agentScanPages).toBe(10);
  });

  it("keeps the agent allowance independent of the automatic sweep budget", () => {
    // The whole point of two controls: turning the unprompted sweep off must
    // not silently also govern (or be governed by) assistant-triggered scans.
    const mixed = sanitizePreferences({ autoIndexPages: 0, agentScanPages: 20 });
    expect(mixed.autoIndexPages).toBe(0);
    expect(mixed.agentScanPages).toBe(20);
  });
});
