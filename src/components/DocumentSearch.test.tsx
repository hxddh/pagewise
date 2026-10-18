// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UIMessage } from "ai";

vi.mock("../i18n", () => ({
  useI18n: () => ({ t: (k: string) => k, locale: "en" }),
}));

const { DocumentSearch } = await import("./DocumentSearch");
const { SearchScopeProvider } = await import("./SearchScope");
const { docCache } = await import("../lib/doc-cache");
const { OPEN_DOC_SEARCH_EVENT } = await import("../lib/events");
import type { LoadedDocument } from "../lib/types";

const doc = {
  path: "/docs/report.pdf",
  name: "report.pdf",
  kind: "pdf",
  totalPages: 3,
  stamp: "s1",
  pages: [
    { page: 1, text: "alpha beta gamma — a sentence about the risk section", source: "native" },
    { page: 2, text: "a second page of ordinary prose, long enough to be indexed", source: "native" },
  ],
} as LoadedDocument;

const messages = [
  {
    id: "m1",
    role: "user",
    parts: [{ type: "text", text: "what does the alpha section say about risk?" }],
  },
  {
    id: "m2",
    role: "assistant",
    parts: [{ type: "text", text: "The beta paragraph repeats it." }],
  },
] as UIMessage[];

function setup() {
  const onJumpToPage = vi.fn();
  const gotoMessage = vi.fn();
  const view = render(
    <SearchScopeProvider value={{ messages, gotoMessage }}>
      <DocumentSearch doc={doc} onJumpToPage={onJumpToPage} />
    </SearchScopeProvider>,
  );
  return { view, onJumpToPage, gotoMessage };
}

async function openAndSearch(query: string) {
  const { view, onJumpToPage, gotoMessage } = setup();
  window.dispatchEvent(new CustomEvent(OPEN_DOC_SEARCH_EVENT));
  const input = await view.findByPlaceholderText("preview.searchPlaceholder");
  fireEvent.change(input, { target: { value: query } });
  return { view, onJumpToPage, gotoMessage };
}

afterEach(() => {
  cleanup();
  docCache.remove(doc.path);
});

describe("DocumentSearch — one search, two sections (⌘F)", () => {
  it("returns document hits and conversation matches from one query", async () => {
    docCache.set(doc);
    const { view } = await openAndSearch("alpha");

    await vi.waitFor(() => expect(view.getByText("preview.searchDocHeading")).toBeTruthy());
    expect(view.getByText("preview.searchConversationHeading")).toBeTruthy();
    // One document hit (page 1) and one conversation match (the question).
    expect(view.getByText("preview.pageHit")).toBeTruthy();
  });

  it("jumps to the page from the document half", async () => {
    docCache.set(doc);
    const { view, onJumpToPage } = await openAndSearch("risk");

    await vi.waitFor(() => expect(view.getByText("preview.searchDocHeading")).toBeTruthy());
    const hit = await view.findByRole("button", { name: /preview\.pageHit/ });
    fireEvent.click(hit);
    expect(onJumpToPage).toHaveBeenCalledWith(1, "risk");
  });

  it("points the conversation half at the turn", async () => {
    docCache.set(doc);
    const { view, gotoMessage } = await openAndSearch("repeats");

    await vi.waitFor(() => expect(view.getByText("preview.searchConversationHeading")).toBeTruthy());
    const row = await view.findByRole("button", { name: /repeats/ });
    fireEvent.click(row);
    expect(gotoMessage).toHaveBeenCalledWith("m2");
  });

  it("says no matches for the conversation when the document has none either", async () => {
    docCache.set(doc);
    const { view } = await openAndSearch("zebra");

    await vi.waitFor(() => expect(view.getByText("preview.searchDocHeading")).toBeTruthy());
    expect(view.getAllByText("preview.noMatches")).toHaveLength(2);
  });
});

describe("opened with words to look for (24.0)", () => {
  it("opens holding the query a red citation chip sent", async () => {
    docCache.set(doc);
    const { view } = setup();
    const { requestOpenDocSearch } = await import("../lib/events");
    requestOpenDocSearch("alpha beta");
    const input = (await view.findByPlaceholderText("preview.searchPlaceholder")) as HTMLInputElement;
    expect(input.value).toBe("alpha beta");
    await vi.waitFor(() => expect(view.getByText("preview.pageHit")).toBeTruthy());
  });
});
