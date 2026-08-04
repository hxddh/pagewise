import { describe, expect, it } from "vitest";
import { linksOnPages, pagesWithLinks } from "./page-links";
import type { DocLink } from "./types";

function link(page: number, url: string, context = ""): DocLink {
  return { page, url, context, rect: { x: 0, y: 0, width: 40, height: 10 } };
}

describe("linksOnPages", () => {
  it("returns only the links on the pages that were read", () => {
    const links = [link(1, "https://a.example/"), link(2, "https://b.example/")];
    expect(linksOnPages(links, [2])).toEqual([{ page: 2, url: "https://b.example/" }]);
  });

  it("carries the line the link sits on when there is one", () => {
    expect(linksOnPages([link(1, "https://a.example/", "See the spec")], [1])).toEqual([
      { page: 1, url: "https://a.example/", context: "See the spec" },
    ]);
  });

  it("drops a scheme the app would refuse to open", () => {
    // A PDF is untrusted input; the preview will not draw these either.
    const links = [link(1, "javascript:alert(1)"), link(1, "https://ok.example/")];
    expect(linksOnPages(links, [1])).toEqual([{ page: 1, url: "https://ok.example/" }]);
  });

  it("lists a repeated destination once per page", () => {
    // A link spanning two lines is reported as two annotations.
    const links = [link(3, "https://a.example/"), link(3, "https://a.example/")];
    expect(linksOnPages(links, [3])).toHaveLength(1);
  });

  it("keeps the same destination on different pages", () => {
    const links = [link(1, "https://a.example/"), link(2, "https://a.example/")];
    expect(linksOnPages(links, [1, 2])).toHaveLength(2);
  });

  it("caps a page of nothing but links so it cannot flood the context", () => {
    const links = Array.from({ length: 200 }, (_, i) => link(1, `https://a.example/${i}`));
    expect(linksOnPages(links, [1])).toHaveLength(40);
  });

  it("treats a document with no links as empty", () => {
    expect(linksOnPages(undefined, [1])).toEqual([]);
  });
});

describe("pagesWithLinks", () => {
  it("lists each page once, in order", () => {
    const links = [link(3, "https://a.example/"), link(1, "https://b.example/"), link(3, "https://c.example/")];
    expect(pagesWithLinks(links)).toEqual([1, 3]);
  });

  it("does not advertise a page whose only link would be filtered out", () => {
    expect(pagesWithLinks([link(1, "javascript:alert(1)")])).toEqual([]);
  });

  it("treats a document with no links as empty", () => {
    expect(pagesWithLinks(undefined)).toEqual([]);
  });
});
