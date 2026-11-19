import { describe, expect, it } from "vitest";
import { CITATION_SCHEME, parseCitationUrl, remarkCitations } from "./remark-citations";

interface TestNode {
  type: string;
  value?: string;
  url?: string;
  data?: { hName?: string; hProperties?: { className?: string[] } };
  children?: TestNode[];
}

function collectText(node: TestNode): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value ?? "";
  return (node.children ?? []).map(collectText).join("");
}

describe("remarkCitations (v25)", () => {
  it("lifts .cite-claim across inline strong/code/emphasis nodes for the whole sentence", () => {
    const source = 'Intro sentence. Revenue fell **14.2%** in `Q3`〔p2 "fell 14.2%"〕.';
    const tree: TestNode = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: "Intro sentence. Revenue fell " },
            { type: "strong", children: [{ type: "text", value: "14.2%" }] },
            { type: "text", value: " in " },
            { type: "inlineCode", value: "Q3" },
            { type: "text", value: '〔p2 "fell 14.2%"〕.' },
          ],
        },
      ],
    };

    remarkCitations()(tree as never, { value: source });
    const p = tree.children![0]!;
    const claimSpan = p.children!.find((c) => c.type === "citeClaim");
    expect(claimSpan).toBeDefined();
    expect(collectText(claimSpan!)).toBe("Revenue fell 14.2% in Q3");
    const link = p.children!.find((c) => c.type === "link" && c.url?.startsWith(CITATION_SCHEME));
    expect(link).toBeDefined();
    expect(parseCitationUrl(link!.url!)?.pages).toEqual([2]);
  });

  it("wraps a multi-citation sentence once and keeps consecutive citation links adjacent", () => {
    const source = 'Combined cap applies〔p2 "first quote"〕 〔p3 "second quote"〕.';
    const tree: TestNode = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [{ type: "text", value: source }],
        },
      ],
    };

    remarkCitations()(tree as never, { value: source });
    const children = tree.children![0]!.children!;
    expect(children[0]?.type).toBe("citeClaim");
    expect(collectText(children[0]!)).toBe("Combined cap applies");
    expect(children[1]?.type).toBe("link");
    expect(children[2]?.type).toBe("link");
  });
});
