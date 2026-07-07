import { describe, expect, it, vi } from "vitest";
import { flushChat, type FlushChatDeps } from "./flush-chat";
import type { PageWiseUIMessage } from "../lib/message-metadata";

function msg(id: string): PageWiseUIMessage {
  return { id, role: "assistant", parts: [] } as PageWiseUIMessage;
}

function makeDeps(overrides: Partial<FlushChatDeps> = {}): {
  deps: FlushChatDeps;
  saveChat: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  clearAutosave: ReturnType<typeof vi.fn>;
} {
  const saveChat = vi.fn(async () => {});
  const stop = vi.fn();
  const clearAutosave = vi.fn();
  const deps: FlushChatDeps = {
    waitForStreamIdle: async () => {},
    stop,
    getPath: () => "/doc.pdf",
    getMessages: () => [msg("a")],
    clearAutosave,
    saveChat,
    ...overrides,
  };
  return { deps, saveChat, stop, clearAutosave };
}

describe("flushChat", () => {
  it("saves the current path and messages", async () => {
    const { deps, saveChat, stop, clearAutosave } = makeDeps();
    await flushChat(deps);
    expect(stop).toHaveBeenCalledOnce();
    expect(clearAutosave).toHaveBeenCalledOnce();
    expect(saveChat).toHaveBeenCalledWith("/doc.pdf", [msg("a")]);
  });

  it("reads messages AFTER stream idle, so the stream tail is not lost (M3)", async () => {
    let tail: PageWiseUIMessage[] = [msg("partial")];
    const { deps, saveChat } = makeDeps({
      // The stream finalizes during waitForStreamIdle, appending the tail.
      waitForStreamIdle: async () => {
        tail = [msg("partial"), msg("final-tail")];
      },
      getMessages: () => tail,
    });

    await flushChat(deps);

    expect(saveChat).toHaveBeenCalledWith("/doc.pdf", [
      msg("partial"),
      msg("final-tail"),
    ]);
  });

  it("does not save when there is no document", async () => {
    const { deps, saveChat, clearAutosave } = makeDeps({ getPath: () => undefined });
    await flushChat(deps);
    expect(saveChat).not.toHaveBeenCalled();
    expect(clearAutosave).not.toHaveBeenCalled();
  });

  it("does not save (or clobber) when the chat is empty during hydration", async () => {
    const { deps, saveChat } = makeDeps({ getMessages: () => [] });
    await flushChat(deps);
    expect(saveChat).not.toHaveBeenCalled();
  });

  it("awaits stream idle before stopping the stream", async () => {
    const order: string[] = [];
    const { deps } = makeDeps({
      waitForStreamIdle: async () => {
        order.push("idle");
      },
      stop: vi.fn(() => order.push("stop")),
      saveChat: vi.fn(async () => {
        order.push("save");
      }),
    });
    await flushChat(deps);
    expect(order).toEqual(["idle", "stop", "save"]);
  });
});
