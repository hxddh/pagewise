import { beforeEach, describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import {
  __resetSessionStoreForTests,
  loadActiveMessages,
  saveActiveSession,
  switchThread,
} from "./chat-sessions";
import { resolveOutgoingBeforeDocSwitch } from "./chat-doc-snapshot";
import { messagesSignature } from "./messages-signature";

const user = (id: string, text: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

describe("chat persistence integration", () => {
  beforeEach(() => {
    __resetSessionStoreForTests({ version: 2, byPath: {} });
  });

  it("doc switch save keeps prior active thread when touchActive is false", async () => {
    await saveActiveSession("/a.pdf", "a.pdf", "default", [user("1", "one")]);
    await saveActiveSession("/a.pdf", "a.pdf", "second", [user("2", "two")]);
    await switchThread("/a.pdf", "default");

    const pending = resolveOutgoingBeforeDocSwitch({
      prevPath: "/a.pdf",
      pathChanged: true,
      currentMessages: [],
      currentSignature: "",
      loadedSignature: "loaded-b",
      cache: new Map([
        [
          "/a.pdf",
          {
            path: "/a.pdf",
            messages: [user("1", "cached"), user("3", "extra")],
            signature: "sig-a",
            sessionId: "second",
            docName: "a.pdf",
          },
        ],
      ]),
      currentSessionId: "default",
      currentDocName: "b.pdf",
    });

    expect(pending?.saveSessionId).toBe("second");
    await saveActiveSession(
      pending!.savePath,
      pending!.saveName,
      pending!.saveSessionId,
      pending!.outgoing,
      { touchActive: false },
    );

    const loaded = await loadActiveMessages("/a.pdf");
    expect(loaded.sessionId).toBe("default");
    expect(
      loaded.threads.find((t) => t.id === "second")?.messages,
    ).toHaveLength(2);
  });

  it("autosave signature tracks pruned outgoing shape", () => {
    const messages = [user("1", "hello")];
    const sig = messagesSignature(messages);
    expect(sig).toBe(messagesSignature([...messages]));
  });
});
