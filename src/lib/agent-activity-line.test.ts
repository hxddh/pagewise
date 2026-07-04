import { describe, expect, it } from "vitest";
import { formatAgentActivityLine } from "./agent-activity-line";
import type { UIMessage } from "ai";

const t = (key: string, vars?: Record<string, string | number>) => {
  if (key === "agent.stepProgress") {
    return `Step ${vars?.step}/${vars?.max} — ${vars?.action}`;
  }
  if (key === "agent.elapsedSeconds") return `${vars?.seconds}s`;
  return key;
};

describe("formatAgentActivityLine", () => {
  it("shows step 1 on the first step", () => {
    const messages: UIMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "文中有哪些日期？" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [],
        metadata: { startedAt: Date.now() - 500 },
      },
    ];
    const line = formatAgentActivityLine({
      messages,
      busy: true,
      activity: "Searching document…",
      nowMs: Date.now(),
      t,
    });
    expect(line).toContain("Step 1/6");
    expect(line).toContain("Searching document…");
    expect(line).toMatch(/0s/);
  });
});
