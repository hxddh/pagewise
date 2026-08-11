import { describe, expect, it } from "vitest";
import { AGENT_TIMEOUT, CONNECTION_TEST_TIMEOUT_MS } from "./agent-timeouts";

/**
 * These are numbers, so most assertions about them would be tautologies — a
 * test that reads `firstChunkMs` back and compares it to 90_000 says only that
 * the file was read. What is worth holding is the reasoning that produced them,
 * which is entirely about the relationships between them.
 */

describe("agent timeout policy", () => {
  it("allows longer to start answering than to continue", () => {
    // The two waits mean different things. Before the first chunk the model may
    // be thinking through a long prompt; after it, the same silence is a
    // dropped connection. Reversing these would kill slow-starting reasoning
    // models while tolerating dead sockets — exactly backwards.
    expect(AGENT_TIMEOUT.firstChunkMs).toBeGreaterThan(AGENT_TIMEOUT.chunkMs);
  });

  it("leaves room for a full-length run inside the total", () => {
    // A whole-document run is capped at 30 steps, and a step that has to scan a
    // page spends up to a minute in vision. A total that could expire mid-run
    // would abort work that was making progress and charge the reader for the
    // whole context again on the retry.
    const worstCaseRunMs = 30 * AGENT_TIMEOUT.toolMs;
    expect(AGENT_TIMEOUT.totalMs).toBeGreaterThan(worstCaseRunMs);
  });

  it("gives a tool longer than the vision deadline it may be waiting on", () => {
    // A read that has to index its page first goes to the vision model, which
    // bounds itself at 60s (index-queue.ts). If the tool ceiling were below
    // that, this timeout would fire first and the vision path's own error —
    // the one that says indexing failed — would never be produced.
    const VISION_DEADLINE_MS = 60_000;
    expect(AGENT_TIMEOUT.toolMs).toBeGreaterThan(VISION_DEADLINE_MS);
  });

  it("bounds a health check far below a run", () => {
    // A run may legitimately take twenty minutes. A probe that has not answered
    // in thirty seconds has answered.
    expect(CONNECTION_TEST_TIMEOUT_MS).toBeLessThan(AGENT_TIMEOUT.totalMs / 10);
  });
});
