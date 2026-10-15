// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
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
