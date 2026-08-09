// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiSettingsFooterState } from "./AiProviderSettings";

/**
 * The races in the settings panel, which are the only hard part of it.
 *
 * 759 lines and no test until now — the largest untested component in the app,
 * and the one holding the reader's API keys. Everything here is about one thing:
 * a network call started for provider A resolving after the panel has moved to
 * provider B. That has already shipped as a bug once ("a slow Test connection no
 * longer snaps the panel back to the tested provider and discards the draft"),
 * and the guard that fixed it is a sequence number nothing was checking.
 *
 * Each test drives the panel through its footer callbacks, which is how the
 * drawer drives it too.
 */

const h = vi.hoisted(() => ({
  footer: null as AiSettingsFooterState | null,
  /** Resolvers for in-flight testConnection calls, so a test can be left hanging. */
  pendingTests: [] as Array<(value: string) => void>,
  savedProfiles: [] as Array<{ provider: string; profile: Record<string, unknown> }>,
  loadedProviders: [] as string[],
  activeProvider: "openai",
}));

const profileFor = (provider: string) => ({
  provider,
  model: `${provider}-model`,
  apiKey: `sk-${provider}`,
  visionModel: "",
  baseURL: "",
  thinkingEnabled: false,
  connectionVerified: false,
});

vi.mock("../../i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }));
vi.mock("../../hooks/useConnectionStatus", () => ({
  useConnectionStatus: () => ({ plaintextKeysOnDisk: false }),
  isApiKeyConfigured: () => true,
}));
vi.mock("../../hooks/useDebouncedSave", () => ({
  useDebouncedSave: () => ({
    persistNow: async () => profileFor(h.activeProvider),
    markSaved: () => {},
    discardPending: () => {},
  }),
}));
vi.mock("../../lib/llm", () => ({
  testConnection: () =>
    new Promise<string>((resolve) => {
      h.pendingTests.push(resolve);
    }),
  testVisionConnection: async () => "ok",
  validateAgentModel: () => undefined,
  validateModel: () => undefined,
  formatLlmError: (e: unknown) => String(e),
}));
vi.mock("../../lib/settings", () => ({
  loadLlmStore: async () => ({
    version: 2,
    activeProvider: h.activeProvider,
    profiles: {
      openai: profileFor("openai"),
      deepseek: profileFor("deepseek"),
    },
  }),
  loadProviderSettings: async (provider: string) => {
    h.loadedProviders.push(provider);
    return profileFor(provider);
  },
  saveProviderProfile: async (provider: string, profile: Record<string, unknown>) => {
    h.savedProfiles.push({ provider, profile });
    return { ...profileFor(provider), ...profile };
  },
  setActiveProvider: async (provider: string) => {
    h.activeProvider = provider;
    return profileFor(provider);
  },
}));

const { AiProviderSettings } = await import("./AiProviderSettings");

function mount() {
  return render(
    <AiProviderSettings
      onFooterState={(state) => {
        h.footer = state;
      }}
      onTestResult={() => {}}
    />,
  );
}

/**
 * Click a provider cell. The grid labels cells from PROVIDER_PRESETS, so this
 * finds them the way a reader does — by the name on the button.
 */
const LABEL: Record<string, string> = { openai: "OpenAI", deepseek: "DeepSeek" };

function providerCell(container: HTMLElement, provider: string): HTMLElement {
  const cells = [...container.querySelectorAll<HTMLElement>("button.provider-cell")];
  const cell = cells.find((c) => c.textContent?.trim().startsWith(LABEL[provider]!));
  if (!cell) throw new Error(`no provider cell for ${provider} in [${cells.map((c) => c.textContent).join(", ")}]`);
  return cell;
}

/** Which provider the panel is showing — the grid marks it `.active`. */
function shownProvider(container: HTMLElement): string | undefined {
  const selected = container.querySelector<HTMLElement>("button.provider-cell.active");
  return Object.keys(LABEL).find((p) =>
    selected?.textContent?.trim().startsWith(LABEL[p]!),
  );
}

async function selectProvider(container: HTMLElement, provider: string) {
  const cell = providerCell(container, provider);
  await act(async () => {
    cell.click();
  });
}

beforeEach(() => {
  h.footer = null;
  h.pendingTests.length = 0;
  h.savedProfiles.length = 0;
  h.loadedProviders.length = 0;
  h.activeProvider = "openai";
});
afterEach(cleanup);

describe("test connection", () => {
  it("persists against the provider it tested, not the one on screen", async () => {
    // The reader hits Test on OpenAI, gets bored, clicks DeepSeek. The call
    // resolves. Whatever the panel is showing, what was verified is OpenAI.
    const { container } = mount();
    await waitFor(() => expect(h.footer).not.toBeNull());

    act(() => h.footer!.onTest());
    await waitFor(() => expect(h.pendingTests).toHaveLength(1));

    await selectProvider(container, "deepseek");
    await act(async () => {
      h.pendingTests[0]!("ok");
    });

    await waitFor(() => expect(h.savedProfiles).toHaveLength(1));
    expect(h.savedProfiles[0]!.provider).toBe("openai");
    expect(h.savedProfiles[0]!.profile).toMatchObject({ connectionVerified: true });
  });

  it("does not drag the panel back to the provider it tested", async () => {
    // This is the shipped bug. The late writes used to land unconditionally, so
    // the panel snapped back to OpenAI and the DeepSeek draft went with it.
    const { container } = mount();
    await waitFor(() => expect(h.footer).not.toBeNull());

    act(() => h.footer!.onTest());
    await waitFor(() => expect(h.pendingTests).toHaveLength(1));

    await selectProvider(container, "deepseek");
    expect(shownProvider(container)).toBe("deepseek");

    await act(async () => {
      h.pendingTests[0]!("ok");
    });

    expect(shownProvider(container)).toBe("deepseek");
  });

  it("applies the result normally when the panel has not moved", async () => {
    // The guard must not swallow the ordinary case.
    mount();
    await waitFor(() => expect(h.footer).not.toBeNull());

    act(() => h.footer!.onTest());
    await waitFor(() => expect(h.pendingTests).toHaveLength(1));
    await act(async () => {
      h.pendingTests[0]!("ok");
    });

    await waitFor(() => expect(h.footer!.testing).toBe(false));
    expect(h.savedProfiles[0]!.provider).toBe("openai");
  });
});

describe("switching provider", () => {
  it("loads the provider that was picked", async () => {
    const { container } = mount();
    await waitFor(() => expect(h.footer).not.toBeNull());
    await selectProvider(container, "deepseek");
    await waitFor(() => expect(h.loadedProviders).toContain("deepseek"));
  });

  it("does nothing when the provider on screen is picked again", async () => {
    // Re-selecting must not re-fetch, or a click on the current cell discards a
    // draft in progress.
    const { container } = mount();
    await waitFor(() => expect(h.footer).not.toBeNull());
    h.loadedProviders.length = 0;
    await selectProvider(container, "openai");
    expect(h.loadedProviders).toEqual([]);
  });

  it("reads a provider from disk once and then from memory", async () => {
    const { container } = mount();
    await waitFor(() => expect(h.footer).not.toBeNull());

    await selectProvider(container, "deepseek");
    await waitFor(() => expect(h.loadedProviders).toContain("deepseek"));
    const afterFirst = h.loadedProviders.length;

    await selectProvider(container, "openai");
    await selectProvider(container, "deepseek");
    expect(h.loadedProviders.length).toBe(afterFirst);
  });
});
