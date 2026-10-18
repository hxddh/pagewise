// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatEmptyState } from "./EmptyState";
import { WelcomeView } from "./WelcomeView";
import en from "../i18n/locales/en.json";

/**
 * The real English strings, without booting the i18n provider.
 *
 * Sibling tests mock `t` as `(k) => k`, which cannot work here: the defect is
 * that "Welcome to PageWise" already contains the product name, so the
 * assertion is about the copy itself. Reading en.json keeps that real while
 * skipping the provider's trip to the Tauri store.
 */
vi.mock("../i18n", () => ({
  useI18n: () => ({
    t: (key: string) =>
      key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], en) ??
      key,
  }),
}));

/**
 * The screens a reader sees before anything works.
 *
 * Both defects held here were found by photographing the app, not by reading
 * it — 8.0 is the first release where that was possible (scripts/ui-shots.mjs).
 * Neither is visible in the JSX: one needs you to know that `welcome.title`
 * already contains the product name, the other needs you to know what a
 * different component renders at the same time.
 *
 * They are asserted here, in the normal suite, rather than as screenshot
 * baselines. Pixel diffs across engines and machines are flaky enough to get
 * waved through, and a check that gets waved through is worse than none. These
 * are about what is on screen, which the DOM answers exactly.
 */

// Explicit, because vitest here runs without globals, so testing-library never
// installs its automatic cleanup and each render would stack on the last.
afterEach(cleanup);

const wrap = (ui: React.ReactNode) => render(<>{ui}</>);

describe("welcome screen", () => {
  it("says the product's name once", () => {
    // It read "Welcome to PageWise" / "PageWise", one line apart, in both
    // locales — the title string already carries the name.
    wrap(
      <WelcomeView
        recentFiles={[]}
        canUseAgent={false}
        onOpenFile={() => {}}
        onOpenRecent={() => {}}
        onConfigureApi={() => {}}
      />,
    );
    const occurrences = screen.getAllByText(/PageWise/i);
    expect(
      occurrences,
      occurrences.map((n) => n.textContent).join(" | "),
    ).toHaveLength(1);
  });
});

describe("chat empty state without an API key", () => {
  const props = {
    hasApiKey: false,
    settingsReady: true,
    onConfigureApi: vi.fn(),
  };

  it("offers one way to connect while a document is open, and says what is sent", () => {
    // 24.0: the composer's "Configure AI" button is gone, so this is the single
    // control for it — and the reader learns, before connecting anything, what
    // already works and that the pages the assistant reads go to the provider.
    wrap(<ChatEmptyState {...props} hasDocument />);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button").textContent).toBe(en.empty.connectAi);
    expect(screen.getByText(en.empty.worksWithoutAi)).toBeTruthy();
    expect(screen.getByText(en.empty.whatIsSent)).toBeTruthy();
  });

  it("still offers the only way through when no document is open", () => {
    // Here the composer has no Configure button, so removing this one would
    // leave the message with no way to act on it.
    wrap(<ChatEmptyState {...props} hasDocument={false} />);
    expect(screen.getByRole("button")).toBeTruthy();
  });
});
