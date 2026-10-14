// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two behaviours that replaced the old panel's races.
 *
 * The 760-line panel this replaces needed three tests for one problem: a
 * network call started for provider A resolving after the reader had moved to
 * provider B. 18.0 removed the thing that caused it — the panel no longer edits
 * a *preview* provider that has to be activated separately, so switching
 * providers saves and activates in one step and there is no "the panel moved"
 * to race. What is left to hold: switching activates, and a save that fails
 * stops the switch instead of leaving two providers disagreeing about which one
 * is in use.
 */

const h = vi.hoisted(() => ({
  /** When false, the debounced save reports failure. */
  saveOk: true,
  savedProfiles: [] as Array<{ provider: string; profile: Record<string, unknown> }>,
  activated: [] as string[],
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
    persistNow: async () => (h.saveOk ? profileFor(h.activeProvider) : null),
    markSaved: () => {},
    discardPending: () => {},
  }),
}));
vi.mock("../../lib/llm", () => ({
  testConnection: async () => "ok",
  testVisionConnection: async () => "ok",
  validateModel: () => undefined,
  formatLlmError: (e: unknown) => String(e),
}));
vi.mock("../../lib/settings", () => ({
  loadLlmStore: async () => ({
    version: 3,
    activeProvider: h.activeProvider,
    profiles: { openai: profileFor("openai"), deepseek: profileFor("deepseek") },
  }),
  loadProviderSettings: async (provider: string) => profileFor(provider),
  saveProviderProfile: async (provider: string, profile: Record<string, unknown>) => {
    h.savedProfiles.push({ provider, profile });
    return { ...profileFor(provider), ...profile };
  },
  setActiveProvider: async (provider: string) => {
    h.activated.push(provider);
    h.activeProvider = provider;
    return profileFor(provider);
  },
}));

const { AssistantSettings } = await import("./AssistantSettings");

function mount() {
  return render(
    <AssistantSettings
      includeViewingPageDefault={false}
      onIncludeViewingPageDefaultChange={() => {}}
      showUsageLine
      onShowUsageLineChange={() => {}}
    />,
  );
}

const LABEL: Record<string, string> = { openai: "OpenAI", deepseek: "DeepSeek" };

async function openAdvanced(container: HTMLElement) {
  const button = container.querySelector<HTMLButtonElement>(
    `button[aria-label="settings.advancedSection"]`,
  );
  if (!button) throw new Error("no advanced disclosure button");
  await act(async () => {
    button.click();
  });
}

async function selectProvider(container: HTMLElement, provider: string) {
  const cells = [...container.querySelectorAll<HTMLElement>("button.provider-cell")];
  const cell = cells.find((c) => c.textContent?.trim().startsWith(LABEL[provider]!));
  if (!cell) throw new Error(`no provider cell for ${provider}`);
  await act(async () => {
    cell.click();
  });
}

beforeEach(() => {
  h.saveOk = true;
  h.savedProfiles.length = 0;
  h.activated.length = 0;
  h.activeProvider = "openai";
});
afterEach(cleanup);

describe("assistant settings", () => {
  it("switching a provider saves the current one and activates the new one", async () => {
    const { container } = mount();
    await waitFor(() => expect(container.querySelector(".settings-card")).toBeTruthy());
    await openAdvanced(container);
    await waitFor(() => expect(container.querySelector("button.provider-cell")).toBeTruthy());
    await selectProvider(container, "deepseek");

    await waitFor(() => expect(h.activated).toEqual(["deepseek"]));
    // The panel now shows the provider it activated.
    const active = container.querySelector<HTMLElement>("button.provider-cell.active");
    expect(active?.textContent?.trim().startsWith("DeepSeek")).toBe(true);
  });

  it("a failed save stops the switch instead of leaving two providers in use", async () => {
    h.saveOk = false;
    const { container } = mount();
    await waitFor(() => expect(container.querySelector(".settings-card")).toBeTruthy());
    await openAdvanced(container);
    await waitFor(() => expect(container.querySelector("button.provider-cell")).toBeTruthy());
    await selectProvider(container, "deepseek");

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(h.activated).toEqual([]);
    const active = container.querySelector<HTMLElement>("button.provider-cell.active");
    expect(active?.textContent?.trim().startsWith("OpenAI")).toBe(true);
  });
});
