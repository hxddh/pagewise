// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TextItemRect } from "../lib/types";

/** What `page_text_items` answers per page. */
let pages: Record<number, TextItemRect[]> = {};
vi.mock("../lib/pdf", () => ({ pageTextItems: async (_p: string, page: number) => pages[page] ?? [] }));
vi.mock("../lib/ocr/ocr-service", () => ({ ocrEnabled: () => false, ocrPage: async () => null }));
vi.mock("../i18n", () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, string>) =>
      vars ? `${key}(${Object.values(vars).join(",")})` : key,
  }),
}));
vi.mock("../hooks/useToast", () => ({ useToast: () => ({ showToast: () => undefined }) }));

import { MessageAssistantFooter } from "./MessageAssistantFooter";
import { CitationContext } from "./CitationChip";
import { clearCitationChecks } from "../lib/citation-check";
import { clearFindingAnchors } from "../lib/finding-anchors";
import { clearReviews } from "../lib/claim-review";
import type { PageWiseUIMessage } from "../lib/message-metadata";
import { __resetFindingStoreForTests, getFindings, removeFinding } from "../lib/finding-store";
import { useMemoryStoreBackend } from "../lib/store-testkit";
import { useRecordBridge, type RecordBridge } from "../pages/chat/useRecordBridge";
import type { LoadedDocument } from "../lib/types";

const PATH = "/docs/contract.pdf";
const run = (text: string, y = 700): TextItemRect => ({ text, rect: { x: 72, y, width: 400, height: 12 } });
const MD = '质保期为 36 个月〔p3 "最终验收合格之日起三十六个月"〕。乙方负责维修。';

const message = (text: string): PageWiseUIMessage =>
  ({ id: "a1", role: "assistant", parts: [{ type: "text", text }] }) as PageWiseUIMessage;

const view = (text: string, live: boolean) =>
  render(
    <CitationContext.Provider value={{ path: PATH, totalPages: 10, onReveal: () => {} }}>
      <MessageAssistantFooter message={message(text)} live={live} />
    </CitationContext.Provider>,
  );

beforeEach(() => {
  pages = {};
  clearFindingAnchors();
  clearCitationChecks();
  clearReviews();
});
afterEach(cleanup);

/**
 * The line under an answer, counting sentences (20.0).
 *
 * Until 20.0 it was suppressed while the answer streamed (`!live`), so the
 * reader saw the checking happen nowhere: the chips were already running as
 * each marker closed, and the line appeared only at the end. And the counts
 * were citations, not sentences, so a sentence with no marker was in no count
 * at all.
 */
describe("the sentence tally under an answer", () => {
  it("shows the verification tally while the answer is still streaming", async () => {
    pages[3] = [run("质保期为最终验收合格之日起三十六个月。")];
    const view0 = view(MD, true);
    const tally = await waitFor(() => {
      const el = view0.container.querySelector(".citation-tally");
      if (!el) throw new Error("no tally while live");
      return el;
    });
    // One sentence verified, one with no marker at all: the denominator is the
    // answer's sentences, and the unmarked one has a word of its own.
    await waitFor(() => expect(tally.textContent).toContain("cite.tallyLevel.verified(1)"));
    expect(tally.textContent).toContain("cite.tallyLevel.unchecked(1)");
    expect(tally.textContent).not.toContain("cite.tallyChecking");
  });

  it("counts a sentence whose check is still running, and stops when it lands", async () => {
    const view0 = view(MD, true);
    const tally = await waitFor(() => {
      const el = view0.container.querySelector(".citation-tally");
      if (!el) throw new Error("no tally while live");
      return el;
    });
    // No page text is mocked: the check ends `unreadable`, which is "look at
    // the page" — never `pending` once it has run.
    await waitFor(() => expect(tally.textContent).toContain("cite.tallyLevel.check(1)"));
    expect(tally.textContent).not.toContain("cite.tallyChecking");
  });

  it("keeps the denominator at the answer's sentences, not its citations", async () => {
    pages[3] = [run("质保期为最终验收合格之日起三十六个月。")];
    const twoCitations = '质保期为 36 个月〔p3 "最终验收合格之日起三十六个月"〕。乙方负责维修〔p3 "最终验收合格之日起三十六个月"〕。';
    const view0 = view(twoCitations, true);
    const tally = await waitFor(() => {
      const el = view0.container.querySelector(".citation-tally");
      if (!el) throw new Error("no tally while live");
      return el;
    });
    await waitFor(() => expect(tally.textContent).toContain("cite.tallyLevel.verified(2)"));
    expect(tally.textContent).not.toContain("cite.tallyLevel.unchecked");
  });
});

/**
 * A red chip's next step is the model review (22.0): words not found on a
 * page that has text are sent with that page's text. A page the document
 * does not have has nothing to send.
 */
describe("the review offered under an answer", () => {
  const offered = async (md: string) => {
    // A finished answer: its footer shows once it has a start time.
    const done = { ...message(md), metadata: { startedAt: 1, finishedAt: 2 } } as PageWiseUIMessage;
    const v = render(
      <CitationContext.Provider value={{ path: PATH, totalPages: 10, onReveal: () => {} }}>
        <MessageAssistantFooter message={done} live={false} />
      </CitationContext.Provider>,
    );
    const more = await waitFor(() => {
      const el = v.container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]');
      if (!el) throw new Error("no menu");
      return el;
    });
    // Give the chips' checks a moment to land.
    await waitFor(() => expect(v.container.querySelector(".cite-pending")).toBeNull());
    fireEvent.click(more);
    return [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent ?? "");
  };

  it("counts a citation whose words are not on its page", async () => {
    pages[3] = [run("质保期为最终验收合格之日起二十四个月。")];
    const items = await offered(MD);
    expect(items.some((t) => t.includes("cite.reviewAction(1,1)"))).toBe(true);
  });

  it("offers nothing for a page the document does not have", async () => {
    const items = await offered('质保期为 36 个月〔p30 "最终验收合格之日起三十六个月"〕。');
    expect(items.some((t) => t.includes("cite.reviewAction"))).toBe(false);
  });
});

describe("the line under an answer after the page is read again (21.1.2)", () => {
  it("counts again with the words now on the page", async () => {
    const { ocrTextReplaced } = await import("../lib/ocr/ocr-events");
    const { act } = await import("@testing-library/react");
    pages[3] = [run("质保期为最终验收合格之日起三十六个月。")];
    const v = view(MD, true);
    const tally = await waitFor(() => {
      const el = v.container.querySelector(".citation-tally");
      if (!el) throw new Error("no tally");
      return el;
    });
    await waitFor(() => expect(tally.textContent).toContain("cite.tallyLevel.verified(1)"));
    // The scan was read again with other models: the quoted words are gone.
    pages[3] = [run("质保期为最终验收合格之日起二十四个月。")];
    act(() => ocrTextReplaced(PATH));
    await waitFor(() => expect(tally.textContent).not.toContain("cite.tallyLevel.verified(1)"));
  });
});

/**
 * Keep remembers through a tab switch (24.0). "Kept" was the button's own
 * state, so turning to the record and back unmounted it, the answer offered
 * Keep again, and a second press wrote a second identical entry. Kept or not
 * is read from the record now, and the record refuses the copy.
 */
describe("keeping an answer, after turning away and back", () => {
  const backend = useMemoryStoreBackend();
  const doc = { path: PATH, name: "contract.pdf", kind: "pdf", pages: [], totalPages: 10, stamp: "s1" } as LoadedDocument;
  const readPage = (page: number) =>
    ({ type: "tool-read_pdf_page", toolCallId: `r${page}`, state: "output-available", input: { page }, output: {} }) as never;
  const settled = (text: string): PageWiseUIMessage =>
    ({
      id: "a1",
      role: "assistant",
      parts: [readPage(3), { type: "text", text }],
      metadata: { startedAt: 1, finishedAt: 2 },
    }) as PageWiseUIMessage;

  let bridge: RecordBridge | null = null;
  // The footer as the transcript mounts it: Keep wired to the record bridge.
  function Transcript({ text }: { text: string }) {
    const record = useRecordBridge({ doc, messages: [], setTab: () => undefined });
    bridge = record;
    return (
      <CitationContext.Provider value={{ path: PATH, totalPages: 10, onReveal: () => {} }}>
        <MessageAssistantFooter
          message={settled(text)}
          onKeep={record.keepClaim}
          onKeepVerified={record.keepVerified}
        />
      </CitationContext.Provider>
    );
  }
  const keepButton = (root: HTMLElement) => {
    const el = [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      /record\.(keep|kept)Short/.test(b.textContent ?? ""),
    );
    if (!el) throw new Error("no keep button");
    return el;
  };

  beforeEach(() => {
    backend.reset();
    __resetFindingStoreForTests();
    bridge = null;
  });

  it("still has one entry when the whole answer is kept again", async () => {
    const text = "乙方负责维修，质保期内免费。";
    const first = render(<Transcript text={text} />);
    fireEvent.click(keepButton(first.container));
    expect(getFindings(PATH)).toHaveLength(1);
    await waitFor(() => expect(keepButton(first.container).disabled).toBe(true));

    // Turn to the record and back: the footer is unmounted and mounted anew.
    first.unmount();
    const again = render(<Transcript text={text} />);
    const button = keepButton(again.container);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-label")).toBe("record.kept");
    fireEvent.click(button);
    // And had anything got past the button, the record refuses the copy.
    act(() => bridge!.keepClaim(getFindings(PATH)[0]!.claim, [3], { body: text, messageId: "a1" }));
    expect(getFindings(PATH)).toHaveLength(1);
  });

  it("still has one entry per sentence when the verified sentences are kept again", async () => {
    pages[3] = [run("质保期为最终验收合格之日起三十六个月。")];
    const first = render(<Transcript text={MD} />);
    await waitFor(() => expect(keepButton(first.container).getAttribute("aria-label")).toBe("cite.keepVerified(1)"));
    fireEvent.click(keepButton(first.container));
    expect(getFindings(PATH)).toHaveLength(1);

    first.unmount();
    const again = render(<Transcript text={MD} />);
    await waitFor(() => expect(keepButton(again.container).getAttribute("aria-label")).toBe("cite.keptVerified(1)"));
    expect(keepButton(again.container).disabled).toBe(true);
    const [kept] = getFindings(PATH);
    act(() => bridge!.keepVerified([{ claim: kept!.claim, page: 3, quote: kept!.evidence }], "a1"));
    expect(getFindings(PATH)).toHaveLength(1);
  });

  it("offers Keep again once the entry is removed from the record", async () => {
    const text = "乙方负责维修，质保期内免费。";
    const v = render(<Transcript text={text} />);
    fireEvent.click(keepButton(v.container));
    await waitFor(() => expect(keepButton(v.container).disabled).toBe(true));
    act(() => removeFinding(PATH, getFindings(PATH)[0]!.id));
    await waitFor(() => expect(keepButton(v.container).disabled).toBe(false));
  });
});
