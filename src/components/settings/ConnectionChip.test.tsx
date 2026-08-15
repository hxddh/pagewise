// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionChip } from "./ConnectionChip";
import type { LlmSettings } from "../../lib/types";
import en from "../../i18n/locales/en.json";

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) =>
      key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], en) ??
      key,
  }),
}));

afterEach(cleanup);

const VERIFIED = {
  provider: "openai",
  model: "gpt-4o",
  connectionVerified: true,
  apiKeys: { openai: "sk-test" },
} as unknown as LlmSettings;

const chip = (extra: { dirty?: boolean; testFailed?: boolean } = {}) =>
  render(
    <ConnectionChip
      settings={VERIFIED}
      activeProvider="openai"
      apiKeyTouched={false}
      apiKeyDraft=""
      dirty={extra.dirty ?? false}
      testFailed={extra.testFailed ?? false}
    />,
  );

/**
 * The badge above the AI Provider panel, when the panel below it is reporting a
 * failure.
 *
 * `connectionVerified` records that a test passed at some point and is not
 * cleared by a later failure — deliberately, since it gates the agent and one
 * dropped request should not lock a reader out of chat. That left the two
 * statements free to disagree, and photographing a revoked key showed them
 * doing it: a red "Invalid API key" banner under a green "In use · verified"
 * badge.
 */
describe("connection chip", () => {
  it("does not claim verified while a test error is on the panel", () => {
    chip({ testFailed: true });
    expect(screen.queryByText(en.settings.connectionInUseVerified)).toBeNull();
    expect(screen.getByText(en.settings.testFailed)).toBeTruthy();
  });

  it("still says verified when nothing has failed", () => {
    // The check above could pass by never saying verified at all.
    chip();
    expect(screen.getByText(en.settings.connectionInUseVerified)).toBeTruthy();
  });

  it("lets an unsaved edit speak first", () => {
    // A stale error describes settings the reader has since changed; the chip
    // should be about what is in front of them.
    chip({ dirty: true, testFailed: true });
    expect(screen.getByText(en.settings.unsaved)).toBeTruthy();
  });
});
