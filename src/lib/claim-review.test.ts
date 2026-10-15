import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ prompt: string }> = [];
/** What the fake model answers for a prompt; the default says each item's verdict by its sentence. */
let answer: (prompt: string) => { reviews: { item: number; verdict: string; reason: string }[] } = (prompt) => {
  const items = [...prompt.matchAll(/^Citation (\d+)$/gm)].map((m) => Number(m[1]));
  const sentences = [...prompt.matchAll(/The sentence to check:\n"""\n([\s\S]*?)\n"""/g)].map((m) => m[1] ?? "");
  return {
    reviews: items.map((item, i) => ({
      item,
      verdict: sentences[i]?.includes("24 个月") ? "contradicts" : "supports",
      reason: "原文：三十六个月",
    })),
  };
};
vi.mock("ai", () => ({
  generateObject: vi.fn(async (opts: { prompt: string }) => {
    calls.push(opts);
    return { object: answer(opts.prompt), usage: { inputTokens: 10, outputTokens: 5 } };
  }),
}));
vi.mock("./settings", () => ({ loadSettings: async () => ({ provider: "openai", model: "m", apiKey: "k" }) }));
vi.mock("./llm", () => ({ resolveModel: () => "model", assertApiKeyForAgent: () => undefined }));

import {
  __resetClaimReviewsForTests,
  cachedReview,
  clearReviews,
  loadReviews,
  passageFingerprint,
  REVIEW_BATCH,
  reviewAll,
  reviewBasis,
  reviewClaim,
  reviewPrompt,
  subscribeReviews,
  type ReviewItem,
} from "./claim-review";
import { useMemoryStoreBackend } from "./store-testkit";

const store = useMemoryStoreBackend();
/** The passage `item` sends, as the check would find it. */
const BASIS = { page: 3, passage: "质保期为最终验收合格之日起三十六个月" };
const defaultAnswer = answer;

beforeEach(() => {
  calls.length = 0;
  answer = defaultAnswer;
  store.reset();
  __resetClaimReviewsForTests();
});

const item = (claim: string, quote = "三十六个月"): ReviewItem => ({
  claim,
  quote,
  passage: "质保期为最终验收合格之日起三十六个月",
  page: 3,
});

describe("reviewClaim", () => {
  it("asks once per sentence and quote, and keeps the verdict", async () => {
    let told = 0;
    const off = subscribeReviews(() => (told += 1));
    const r = await reviewClaim("/a.pdf", "质保期为 24 个月", "三十六个月", "质保期为最终验收合格之日起三十六个月", 3);
    expect(r).toEqual({ verdict: "contradicts", reason: "原文：三十六个月" });
    await reviewClaim("/a.pdf", "质保期为 24 个月", "三十六个月", "质保期为最终验收合格之日起三十六个月", 3);
    expect(calls).toHaveLength(1);
    expect(cachedReview("/a.pdf", "质保期为 24 个月", "三十六个月", BASIS)?.verdict).toBe("contradicts");
    expect(told).toBeGreaterThan(0);
    off();
  });

  it("forgets a document's reviews when it closes", async () => {
    await reviewClaim("/a.pdf", "质保期为 36 个月", "三十六个月", "质保期为最终验收合格之日起三十六个月", 3);
    clearReviews("/a.pdf");
    expect(cachedReview("/a.pdf", "质保期为 36 个月", "三十六个月", BASIS)).toBeNull();
  });
});

describe("reviewPrompt", () => {
  it("gives each passage, quote and sentence, numbered, and decides only from the passage", () => {
    const p = reviewPrompt([item("质保期为 24 个月"), { ...item("付款"), page: 5 }]);
    expect(p).toContain("Decide each one only from its own passage");
    expect(p).toContain("Citation 1\nPassage (page 3)");
    expect(p).toContain("Citation 2\nPassage (page 5)");
    expect(p).toContain("质保期为最终验收合格之日起三十六个月");
    expect(p).toContain("质保期为 24 个月");
  });
});

describe("one call reviews many citations (21.0)", () => {
  it("asks about eight citations in one call", async () => {
    const items = Array.from({ length: 8 }, (_, i) => item(`第 ${i + 1} 条，质保期为 36 个月`));
    const outcome = await reviewAll("/a.pdf", items, new AbortController().signal);
    expect(calls).toHaveLength(1);
    expect(outcome).toEqual({ counts: { supports: 8, contradicts: 0, insufficient: 0 }, failed: 0, cancelled: false });
  });

  it("splits a longer list into batches", async () => {
    const items = Array.from({ length: REVIEW_BATCH * 2 + 1 }, (_, i) => item(`claim ${i}`));
    await reviewAll("/a.pdf", items, new AbortController().signal);
    expect(calls).toHaveLength(3);
  });

  it("does not ask again about a citation already reviewed", async () => {
    await reviewAll("/a.pdf", [item("a")], new AbortController().signal);
    const outcome = await reviewAll("/a.pdf", [item("a"), item("b")], new AbortController().signal);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt).not.toContain('"""\na\n"""');
    expect(outcome.counts.supports).toBe(2);
  });

  it("keeps the items it got when the answer leaves one out or answers one twice", async () => {
    answer = () => ({
      reviews: [
        { item: 1, verdict: "supports", reason: "r1" },
        { item: 3, verdict: "insufficient", reason: "r3a" },
        { item: 3, verdict: "supports", reason: "r3b" },
      ],
    });
    const outcome = await reviewAll("/a.pdf", [item("a"), item("b"), item("c")], new AbortController().signal);
    expect(outcome.failed).toBe(2);
    expect(cachedReview("/a.pdf", "a", "三十六个月", BASIS)?.reason).toBe("r1");
    expect(cachedReview("/a.pdf", "b", "三十六个月", BASIS)).toBeNull();
    expect(cachedReview("/a.pdf", "c", "三十六个月", BASIS), "two answers for one item are neither").toBeNull();
  });
});

describe("B12: a review stops when its document closes (16.0)", () => {
  it("makes no further call once aborted", async () => {
    const controller = new AbortController();
    const asked: number[] = [];
    const ask = async (chunk: readonly ReviewItem[]) => {
      asked.push(chunk.length);
      controller.abort();
      return chunk.map(() => ({ verdict: "supports" as const, reason: "r" }));
    };
    const items = Array.from({ length: REVIEW_BATCH * 3 }, (_, i) => item(`claim ${i}`));
    const outcome = await reviewAll("/a.pdf", items, controller.signal, ask);
    expect(asked).toEqual([REVIEW_BATCH]);
    expect(outcome.cancelled).toBe(true);
    expect(cachedReview("/a.pdf", "claim 0", "三十六个月", BASIS), "not kept for a closed document").toBeNull();
  });
});

describe("a review survives reopening the document (21.0)", () => {
  it("is read back for the same file", async () => {
    await loadReviews("/a.pdf", "stamp-1");
    await reviewAll("/a.pdf", [item("质保期为 24 个月")], new AbortController().signal);
    clearReviews("/a.pdf");
    __resetClaimReviewsForTests(); // memory gone, as after a restart; the disk stays

    await loadReviews("/a.pdf", "stamp-1");
    expect(cachedReview("/a.pdf", "质保期为 24 个月", "三十六个月", BASIS)).toEqual({
      verdict: "contradicts",
      reason: "原文：三十六个月",
    });
    expect(calls).toHaveLength(1);
  });

  it("is not read back for a changed file", async () => {
    await loadReviews("/a.pdf", "stamp-1");
    await reviewAll("/a.pdf", [item("a")], new AbortController().signal);
    __resetClaimReviewsForTests();

    await loadReviews("/a.pdf", "stamp-2");
    expect(cachedReview("/a.pdf", "a", "三十六个月", BASIS)).toBeNull();
  });

  it("keeps a sentence with a line break in it", async () => {
    await loadReviews("/a.pdf", "s");
    await reviewAll("/a.pdf", [item("line one\nline two", "q\nq")], new AbortController().signal);
    __resetClaimReviewsForTests();
    await loadReviews("/a.pdf", "s");
    expect(cachedReview("/a.pdf", "line one\nline two", "q\nq", BASIS)?.verdict).toBe("supports");
  });

  it("does not write a file a later PageWise wrote", async () => {
    const later = { version: 99, docs: [] };
    store.seed("claim-reviews.json", { reviews: later });
    await loadReviews("/a.pdf", "s");
    await reviewAll("/a.pdf", [item("a")], new AbortController().signal);
    expect(store.peek<Record<string, unknown>>("claim-reviews.json")?.reviews).toEqual(later);
  });
});

describe("a verdict is a reading of one passage (22.0)", () => {
  it("is not read for the same sentence against other words", async () => {
    await reviewAll("/a.pdf", [item("质保期为 24 个月")], new AbortController().signal);
    expect(cachedReview("/a.pdf", "质保期为 24 个月", "三十六个月", BASIS)?.verdict).toBe("contradicts");
    expect(
      cachedReview("/a.pdf", "质保期为 24 个月", "三十六个月", { ...BASIS, passage: " 质保期为最终验收合格之日起三十六个月\n" }),
      "the same words, spaced otherwise",
    ).not.toBeNull();
    expect(
      cachedReview("/a.pdf", "质保期为 24 个月", "三十六个月", { ...BASIS, passage: "质保期为最终验收合格之日起二十四个月" }),
      "the page read again, to other words",
    ).toBeNull();
    expect(cachedReview("/a.pdf", "质保期为 24 个月", "三十六个月", { ...BASIS, page: 4 })).toBeNull();
    expect(cachedReview("/a.pdf", "质保期为 24 个月", "三十六个月", null), "no check yet").toBeNull();
  });

  it("asks again when the passage changed", async () => {
    await reviewAll("/a.pdf", [item("a")], new AbortController().signal);
    await reviewAll("/a.pdf", [{ ...item("a"), passage: "another reading of page 3" }], new AbortController().signal);
    expect(calls).toHaveLength(2);
  });

  it("does not read back a 21.0 entry, which does not say what it read", async () => {
    const entry = { claim: "a", quote: "三十六个月", verdict: "supports", reason: "r" };
    store.seed("claim-reviews.json", {
      reviews: { version: 1, docs: [{ path: "/a.pdf", stamp: "s", savedAt: 1, entries: [entry] }] },
    });
    await loadReviews("/a.pdf", "s");
    expect(cachedReview("/a.pdf", "a", "三十六个月", BASIS)).toBeNull();
  });

  it("writes the page and the print beside each verdict", async () => {
    await loadReviews("/a.pdf", "s");
    await reviewAll("/a.pdf", [item("a")], new AbortController().signal);
    const saved = store.peek<{ reviews: { docs: { entries: { page: number; fp: string }[] }[] } }>("claim-reviews.json");
    expect(saved?.reviews.docs[0]?.entries[0]).toMatchObject({ page: 3, fp: passageFingerprint(BASIS.passage) });
  });
});

describe("a citation not found can be sent too (22.0)", () => {
  it("is read against its page's text", () => {
    expect(reviewBasis({ status: "unlocated", pageText: { page: 4, text: "page four" } })).toEqual({
      page: 4,
      passage: "page four",
      wholePage: true,
    });
    expect(reviewBasis({ status: "unconfirmed", pageText: { page: 2, text: "ocr words" } })?.wholePage).toBe(true);
    expect(reviewBasis({ status: "located", page: 3, passage: "para" })).toEqual({ page: 3, passage: "para" });
  });

  it("is not sent when there is nothing to read", () => {
    expect(reviewBasis({ status: "unlocated" })).toBeNull();
    expect(reviewBasis({ status: "outOfRange" })).toBeNull();
    expect(reviewBasis({ status: "unreadable" })).toBeNull();
    expect(reviewBasis({ status: "tooShort" })).toBeNull();
    expect(reviewBasis(null)).toBeNull();
  });

  it("tells the model the words are not on the page word for word", () => {
    const p = reviewPrompt([{ ...item("a"), wholePage: true }]);
    expect(p).toContain("Citation 1\nPage 3 (the quoted words are not on it word for word; this is the page's text):");
  });
});
