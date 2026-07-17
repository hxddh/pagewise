import { describe, expect, it } from "vitest";
import { remarkPageRefs, PAGE_REF_SCHEME } from "./remark-page-refs";

// Minimal mdast node shape for the tests.
type N = { type: string; value?: string; url?: string; children?: N[] };

function run(tree: N): N {
  remarkPageRefs()(tree as never);
  return tree;
}

function para(...children: N[]): N {
  return { type: "root", children: [{ type: "paragraph", children }] };
}

function links(tree: N): { url?: string; text?: string }[] {
  const out: { url?: string; text?: string }[] = [];
  const walk = (n: N) => {
    if (n.type === "link") out.push({ url: n.url, text: n.children?.[0]?.value });
    n.children?.forEach(walk);
  };
  walk(tree);
  return out;
}

describe("remarkPageRefs", () => {
  it("linkifies an English page reference to the page scheme", () => {
    const tree = run(para({ type: "text", value: "See page 5 for details." }));
    expect(links(tree)).toEqual([{ url: `${PAGE_REF_SCHEME}5`, text: "page 5" }]);
  });

  it("targets the first page of a range", () => {
    const tree = run(para({ type: "text", value: "pp. 12-14 cover it" }));
    expect(links(tree)[0]?.url).toBe(`${PAGE_REF_SCHEME}12`);
  });

  it("linkifies a Chinese page reference", () => {
    const tree = run(para({ type: "text", value: "见第 8 页" }));
    expect(links(tree)).toEqual([{ url: `${PAGE_REF_SCHEME}8`, text: "第 8 页" }]);
  });

  it("handles a Chinese range, targeting the first page", () => {
    const tree = run(para({ type: "text", value: "第3至5页" }));
    expect(links(tree)[0]?.url).toBe(`${PAGE_REF_SCHEME}3`);
  });

  it("leaves surrounding text intact and splits the node", () => {
    const tree = run(para({ type: "text", value: "a page 2 b" }));
    const p = tree.children![0]!;
    expect(p.children!.map((c) => c.type)).toEqual(["text", "link", "text"]);
    expect(p.children![0]!.value).toBe("a ");
    expect(p.children![2]!.value).toBe(" b");
  });

  it("does not linkify inside code or existing links", () => {
    const codeTree = run(para({ type: "inlineCode", value: "page 5" }));
    expect(links(codeTree)).toEqual([]);
    const linkTree = run(
      para({ type: "link", url: "https://x", children: [{ type: "text", value: "page 9" }] }),
    );
    expect(links(linkTree)).toEqual([{ url: "https://x", text: "page 9" }]);
  });

  it("does not linkify words that merely end in p/page before a number", () => {
    for (const text of [
      "step 5 of the process",
      "the top 10 results",
      "MVP 2024 roadmap",
      "increased GDP. 2020 was different",
      "webpage 5 loads slowly",
      "keep 2 copies",
    ]) {
      const tree = run(para({ type: "text", value: text }));
      expect(links(tree)).toEqual([]);
    }
  });

  it("still linkifies dotted abbreviations", () => {
    const tree = run(para({ type: "text", value: "see p. 12 and pp. 14-16" }));
    expect(links(tree).map((l) => l.url)).toEqual([
      `${PAGE_REF_SCHEME}12`,
      `${PAGE_REF_SCHEME}14`,
    ]);
  });

  it("ignores text with no page reference", () => {
    const tree = run(para({ type: "text", value: "just some prose" }));
    expect(links(tree)).toEqual([]);
  });
});
