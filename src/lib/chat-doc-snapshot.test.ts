import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { resolveOutgoingBeforeDocSwitch } from "./chat-doc-snapshot";

const user = (id: string, text: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

describe("resolveOutgoingBeforeDocSwitch", () => {
  it("uses cached messages when chatId recreation cleared in-memory state", () => {
    const cache = new Map([
      [
        "/docs/a.pdf",
        {
          path: "/docs/a.pdf",
          messages: [user("u1", "hello")],
          signature: "sig-a",
          sessionId: "thread-1",
          docName: "a.pdf",
        },
      ],
    ]);

    const result = resolveOutgoingBeforeDocSwitch({
      prevPath: "/docs/a.pdf",
      pathChanged: true,
      currentMessages: [],
      currentSignature: "",
      loadedSignature: "loaded-a",
      cache,
      currentSessionId: "default",
      currentDocName: "b.pdf",
    });

    expect(result?.outgoing).toHaveLength(1);
    expect(result?.savePath).toBe("/docs/a.pdf");
    expect(result?.saveSessionId).toBe("thread-1");
  });

  it("returns null when nothing changed", () => {
    const result = resolveOutgoingBeforeDocSwitch({
      prevPath: "/docs/a.pdf",
      pathChanged: false,
      currentMessages: [user("u1", "hello")],
      currentSignature: "same",
      loadedSignature: "same",
      cache: new Map(),
      currentSessionId: "default",
      currentDocName: "a.pdf",
    });
    expect(result).toBeNull();
  });
});
