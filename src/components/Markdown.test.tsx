// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Markdown, PageRefContext } from "./Markdown";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

afterEach(cleanup);

function markdown(text: string, onJump: ((page: number) => void) | null = () => {}) {
  return render(
    <PageRefContext.Provider value={onJump}>
      <Markdown>{text}</Markdown>
    </PageRefContext.Provider>,
  ).container;
}

/**
 * Page citations, all the way from the answer text to something clickable.
 *
 * `remarkPageRefs` has its own tests and they all passed while this was broken:
 * they assert the mdast transform, which was always right. react-markdown's
 * `defaultUrlTransform` then replaced the `pagewise-page:` href with "" — the
 * scheme is not on its allowlist — so the link reached SafeAnchor with no href,
 * missed the scheme branch, failed `isSafeLink` and rendered as a bare <span>.
 *
 * The result was that every page reference in every answer was plain text, and
 * clicking one to jump the preview did nothing. Nothing threw, and no test at
 * either end of the chain could see it: the plugin's tests stop above the loss
 * and the anchor's assumptions start below it.
 */
describe("page citations", () => {
  it("renders a page reference as something the reader can click", () => {
    const container = markdown("See page 2 for the first of the two.");
    const link = container.querySelector(".page-ref-link");
    expect(link, "page reference did not survive to a control").not.toBeNull();
    expect(link?.textContent).toContain("page 2");
  });

  it("jumps to the cited page when clicked", () => {
    const onJump = vi.fn();
    const container = markdown("The table is on page 7.", onJump);
    container.querySelector<HTMLButtonElement>(".page-ref-link")?.click();
    expect(onJump).toHaveBeenCalledWith(7);
  });

  it("still refuses a link the sanitizer rejects", () => {
    // The fix widens the allowlist by one internal scheme. It must not have
    // opened the door generally.
    const container = markdown("[click](javascript:alert(1))");
    expect(container.querySelector("a")).toBeNull();
  });

  it("still opens an ordinary external link", () => {
    const container = markdown("[docs](https://example.com/docs)");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com/docs");
  });
});
