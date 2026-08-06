// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { moveConversationFocus, nextMessageId } from "./conversation-nav";

const IDS = ["a", "b", "c"];

describe("nextMessageId", () => {
  it("starts from the newest message when nothing is focused", () => {
    expect(nextMessageId(IDS, null, "prev")).toBe("c");
    // Downward from nowhere has no meaning — the reader is already at the end.
    expect(nextMessageId(IDS, null, "next")).toBeNull();
  });

  it("steps one message at a time in both directions", () => {
    expect(nextMessageId(IDS, "c", "prev")).toBe("b");
    expect(nextMessageId(IDS, "b", "prev")).toBe("a");
    expect(nextMessageId(IDS, "a", "next")).toBe("b");
  });

  it("stops at the ends instead of wrapping", () => {
    // Wrapping would send Alt+Up at the top of a long conversation straight to
    // the newest message, which reads as losing your place.
    expect(nextMessageId(IDS, "a", "prev")).toBeNull();
    expect(nextMessageId(IDS, "c", "next")).toBeNull();
  });

  it("recovers when the focused message is gone", () => {
    // A cleared chat, or an edited turn that dropped the rows after it.
    expect(nextMessageId(IDS, "deleted", "prev")).toBe("c");
    expect(nextMessageId([], "a", "prev")).toBeNull();
    expect(nextMessageId([], null, "next")).toBeNull();
  });
});

describe("moveConversationFocus", () => {
  function build(count: number): HTMLElement {
    const list = document.createElement("div");
    for (let i = 0; i < count; i++) {
      const row = document.createElement("div");
      row.dataset.messageId = `m${i}`;
      row.tabIndex = -1;
      list.appendChild(row);
    }
    document.body.replaceChildren(list);
    return list;
  }

  function focusedId(): string | undefined {
    return (document.activeElement as HTMLElement | null)?.dataset?.messageId;
  }

  it("moves focus to the newest message, then upward", () => {
    const list = build(3);
    expect(moveConversationFocus(list, "prev")).toBe(true);
    expect(focusedId()).toBe("m2");
    moveConversationFocus(list, "prev");
    expect(focusedId()).toBe("m1");
  });

  it("comes back down again", () => {
    const list = build(3);
    moveConversationFocus(list, "prev");
    moveConversationFocus(list, "prev");
    moveConversationFocus(list, "next");
    expect(focusedId()).toBe("m2");
  });

  it("reports that it did nothing at the ends, so the key stays unconsumed", () => {
    const list = build(2);
    moveConversationFocus(list, "prev");
    moveConversationFocus(list, "prev");
    expect(focusedId()).toBe("m0");
    expect(moveConversationFocus(list, "prev")).toBe(false);
    expect(focusedId()).toBe("m0");
  });

  it("does nothing in an empty conversation", () => {
    expect(moveConversationFocus(build(0), "prev")).toBe(false);
  });

  it("finds the row from focus inside a message, not only on it", () => {
    // Focus is usually on something within the turn — a link, the copy button.
    const list = build(3);
    const inner = document.createElement("button");
    list.children[2]!.appendChild(inner);
    inner.focus();
    moveConversationFocus(list, "prev");
    expect(focusedId()).toBe("m1");
  });
});
