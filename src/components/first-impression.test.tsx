// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmptyState } from "./EmptyState";
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

  it("offers no second way to configure while a document is open", () => {
    // ChatPanel turns the composer's own button into "Configure AI" whenever a
    // document is open and no key is set. A link here as well put an
    // explanation at the top of the panel and a primary button at the bottom,
    // both doing the same thing.
    wrap(<EmptyState {...props} hasDocument />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("still offers the only way through when no document is open", () => {
    // Here the composer has no Configure button, so removing this one would
    // leave the message with no way to act on it.
    wrap(<EmptyState {...props} hasDocument={false} />);
    expect(screen.getByRole("button")).toBeTruthy();
  });
});
