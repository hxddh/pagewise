// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecentFilesList } from "./RecentFilesList";
import en from "../i18n/locales/en.json";

vi.mock("../i18n", () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, string | number>) => {
      const raw =
        (key
          .split(".")
          .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], en) as
          | string
          | undefined) ?? key;
      return raw.replace(/\{\{?(\w+)\}?\}/g, (m, name) => String(vars?.[name] ?? m));
    },
  }),
}));

// Explicit: vitest runs here without globals, so testing-library never installs
// its automatic cleanup and each render would stack on the last.
afterEach(cleanup);

const FILES = [
  {
    path: "/Users/reader/Papers/Attention Is All You Need.pdf",
    name: "Attention Is All You Need.pdf",
    kind: "pdf" as const,
    openedAt: Date.now() - 3_600_000,
  },
  {
    path: "/Users/reader/scan.png",
    name: "scan.png",
    kind: "image" as const,
    openedAt: Date.now() - 86_400_000,
  },
];

/**
 * What a row in the Library drawer says about a file.
 *
 * Found by photographing the drawer, like 8.1.0's search results and 8.1.3's
 * tab strip. Nothing here is visible in the JSX: it needs you to notice that
 * the last segment of a file's path is its filename, and that the line above
 * has just printed it.
 */
describe("recent files, drawer layout", () => {
  it("does not print the filename twice in one row", () => {
    // The summary used to be `…/<parent>/<name>`. In the drawer's 229px column
    // that ran the meta line onto two lines for an ordinary paper and three for
    // a long export — measured rows of 52px and 64px against 40px — and every
    // extra line was the name the row already showed.
    render(
      <RecentFilesList files={FILES} layout="drawer" onOpen={() => {}} />,
    );

    for (const file of FILES) {
      const row = screen.getByTitle(file.path);
      const meta = row.querySelector(".library-meta");
      expect(meta, "row has no meta line").not.toBeNull();
      expect(
        meta?.textContent ?? "",
        "the name is on the line above; repeating it is what wrapped the row",
      ).not.toContain(file.name);
    }
  });

  it("still says which folder the file came from", () => {
    // The fix drops a segment, so it could pass the check above by saying
    // nothing at all. Two files with the same name in different folders are
    // exactly what this line is for.
    render(
      <RecentFilesList files={FILES} layout="drawer" onOpen={() => {}} />,
    );

    const meta = screen
      .getByTitle("/Users/reader/Papers/Attention Is All You Need.pdf")
      .querySelector(".library-meta");
    expect(meta?.textContent).toContain("Papers");
  });
});
