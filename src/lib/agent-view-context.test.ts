import { describe, expect, it, beforeEach } from "vitest";
import {
  rollbackLastAgentMessage,
  beginAgentMessage,
  consumePendingAgentContext,
  clearAgentMessageContext,
} from "./agent-view-context";

describe("agent-view-context", () => {
  beforeEach(() => {
    clearAgentMessageContext();
  });
  it("rollbackLastAgentMessage removes the last pending context", () => {
    beginAgentMessage({
      path: "/a.pdf",
      docName: "a",
      viewingPage: 1,
      totalPages: 1,
      userText: "first",
      includeViewingPage: true,
    });
    beginAgentMessage({
      path: "/b.pdf",
      docName: "b",
      viewingPage: 2,
      totalPages: 2,
      userText: "second",
      includeViewingPage: true,
    });
    rollbackLastAgentMessage();
    expect(consumePendingAgentContext()?.path).toBe("/a.pdf");
    consumePendingAgentContext();
    expect(consumePendingAgentContext()).toBeNull();
  });
});
