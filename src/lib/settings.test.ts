import { afterEach, describe, expect, it } from "vitest";
import {
  __peekSettingsStoreForTests,
  __resetSettingsStoreForTests,
  defaultProviderProfile,
  loadApiKeyForProvider,
  loadLlmStore,
  loadProviderSettings,
  migrateLlmSettings,
  migrateV1ToV2,
  saveProviderProfile,
  setActiveProvider,
} from "./settings";
import { DEFAULT_SETTINGS, PROVIDER_PRESETS, type ProviderId } from "./types";

describe("migrateLlmSettings", () => {
  it("maps legacy deepseek-chat model", () => {
    const result = migrateLlmSettings({
      provider: "deepseek",
      model: "deepseek-chat",
      apiKey: "",
    });
    expect(result.model).toBe("deepseek-v4-flash");
    expect(result.thinkingEnabled).toBe(false);
    expect(result.connectionVerified).toBe(false);
  });

  it("normalizes deepseek /v1 base URL", () => {
    const result = migrateLlmSettings({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      baseURL: "https://api.deepseek.com/v1",
      apiKey: "",
    });
    expect(result.baseURL).toBeUndefined();
  });

  it("migrates OpenRouter DeepSeek V4 to a tool-capable model", () => {
    const result = migrateLlmSettings({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      apiKey: "",
    });
    expect(result.model).toBe("openai/gpt-4o-mini");
    expect(result.connectionVerified).toBe(false);
  });

  it("coerces a non-string model from a corrupt store without throwing", () => {
    const result = migrateLlmSettings({
      provider: "deepseek",
      // Simulate corruption: model is not a string.
      model: 42 as unknown as string,
      apiKey: "",
    });
    expect(result.model).toBe(DEFAULT_SETTINGS.model);
  });

  it("does not throw when model is null", () => {
    expect(() =>
      migrateLlmSettings({ provider: "openrouter", model: null as unknown as string }),
    ).not.toThrow();
  });
});

describe("migrateV1ToV2", () => {
  it("preserves active provider profile from v1 settings", () => {
    const store = migrateV1ToV2({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      thinkingEnabled: true,
      connectionVerified: true,
      apiKey: "sk-test",
    });

    expect(store.version).toBe(2);
    expect(store.activeProvider).toBe("openrouter");
    expect(store.profiles.openrouter).toEqual({
      model: "openai/gpt-4o-mini",
      thinkingEnabled: true,
      connectionVerified: false,
    });
  });
});

describe("defaultProviderProfile", () => {
  it("uses preset default model for known providers", () => {
    expect(defaultProviderProfile("deepseek").model).toBe(
      PROVIDER_PRESETS.deepseek.defaultModel,
    );
  });

  it("starts custom provider empty", () => {
    expect(defaultProviderProfile("custom")).toEqual({
      model: "",
      baseURL: "",
      thinkingEnabled: false,
      connectionVerified: false,
    });
  });
});

/** A keychain with no working OS backend (e.g. Linux without Secret Service). */
function brokenKeychain() {
  return {
    get: async (): Promise<string> => {
      throw new Error("keychain unavailable");
    },
    set: async (): Promise<void> => {
      throw new Error("keychain unavailable");
    },
  };
}

/** A working in-memory keychain. */
function memoryKeychain() {
  const keys = new Map<ProviderId, string>();
  return {
    get: async (provider: ProviderId): Promise<string> => keys.get(provider) ?? "",
    set: async (provider: ProviderId, key: string): Promise<void> => {
      keys.set(provider, key);
    },
  };
}

describe("store I/O — keychain fallback (no working keychain)", () => {
  afterEach(() => {
    __resetSettingsStoreForTests();
  });

  it("persists the API key to settings.json when the keychain write fails", async () => {
    __resetSettingsStoreForTests({ keychain: brokenKeychain() });

    await saveProviderProfile("openai", { model: "gpt-4o-mini" }, "sk-openai-1");

    const loaded = await loadProviderSettings("openai");
    expect(loaded.apiKey).toBe("sk-openai-1");

    // The plaintext fallback must actually be on "disk".
    const persisted = __peekSettingsStoreForTests();
    expect(persisted?.apiKeys?.openai).toBe("sk-openai-1");
  });

  it("survives an app restart with a keychain-less machine", async () => {
    __resetSettingsStoreForTests({ keychain: brokenKeychain() });
    await saveProviderProfile("openai", { model: "gpt-4o-mini" }, "sk-openai-1");

    // Simulate restart: fresh store instance, same on-disk payload, still no keychain.
    const persisted = __peekSettingsStoreForTests();
    __resetSettingsStoreForTests({ store: persisted, keychain: brokenKeychain() });

    expect((await loadProviderSettings("openai")).apiKey).toBe("sk-openai-1");
    expect(await loadApiKeyForProvider("openai")).toBe("sk-openai-1");
  });

  it("preserves the fallback key across unrelated setting saves", async () => {
    __resetSettingsStoreForTests({ keychain: brokenKeychain() });
    await saveProviderProfile("openai", { model: "gpt-4o-mini" }, "sk-openai-1");

    // Save an unrelated field (no apiKey arg) — must not erase the fallback.
    await saveProviderProfile("openai", { thinkingEnabled: true });
    // Save a completely different provider — must not touch openai's key.
    await saveProviderProfile("deepseek", { model: "deepseek-v4-flash" });
    // Switch active provider — must not erase the fallback.
    await setActiveProvider("deepseek");

    expect((await loadProviderSettings("openai")).apiKey).toBe("sk-openai-1");
  });

  it("keeps independent fallback keys per provider", async () => {
    __resetSettingsStoreForTests({ keychain: brokenKeychain() });
    await saveProviderProfile("openai", { model: "gpt-4o-mini" }, "sk-openai");
    await saveProviderProfile("openrouter", { model: "openai/gpt-4o-mini" }, "sk-router");

    expect((await loadProviderSettings("openai")).apiKey).toBe("sk-openai");
    expect((await loadProviderSettings("openrouter")).apiKey).toBe("sk-router");
  });

  it("clears the fallback when the key is explicitly emptied", async () => {
    __resetSettingsStoreForTests({ keychain: brokenKeychain() });
    await saveProviderProfile("openai", { model: "gpt-4o-mini" }, "sk-openai");
    await saveProviderProfile("openai", {}, "");

    expect((await loadProviderSettings("openai")).apiKey).toBe("");
    expect(__peekSettingsStoreForTests()?.apiKeys?.openai).toBeUndefined();
  });
});

describe("store I/O — working keychain", () => {
  afterEach(() => {
    __resetSettingsStoreForTests();
  });

  it("does not write plaintext to settings.json when the keychain works", async () => {
    __resetSettingsStoreForTests({ keychain: memoryKeychain() });
    await saveProviderProfile("openai", { model: "gpt-4o-mini" }, "sk-openai");

    expect((await loadProviderSettings("openai")).apiKey).toBe("sk-openai");
    expect(__peekSettingsStoreForTests()?.apiKeys).toBeUndefined();
  });

  it("migrates a legacy V1 store and stores the key in the keychain", async () => {
    const keychain = memoryKeychain();
    __resetSettingsStoreForTests({
      store: {
        provider: "openrouter",
        model: "deepseek/deepseek-v4-flash",
        apiKey: "sk-legacy",
      } as unknown as NonNullable<ReturnType<typeof __peekSettingsStoreForTests>>,
      keychain,
    });

    const loaded = await loadProviderSettings("openrouter");
    // V1 -> V2 migration also remaps the model.
    expect(loaded.model).toBe("openai/gpt-4o-mini");
    expect(loaded.apiKey).toBe("sk-legacy");
    // Keychain accepted it -> no plaintext copy left behind.
    expect(__peekSettingsStoreForTests()?.apiKey).toBeUndefined();
    expect(await keychain.get("openrouter")).toBe("sk-legacy");
  });
});

describe("normalizeStore edge cases", () => {
  afterEach(() => {
    __resetSettingsStoreForTests();
  });

  it("drops unknown provider ids and falls back to the default active provider", async () => {
    __resetSettingsStoreForTests({
      store: {
        version: 2,
        activeProvider: "bogus" as ProviderId,
        profiles: { ["bogus" as ProviderId]: { model: "whatever" } },
      },
      keychain: memoryKeychain(),
    });

    const store = await loadLlmStore();
    expect(store.activeProvider).toBe(DEFAULT_SETTINGS.provider);
    expect(store.profiles["bogus" as ProviderId]).toBeUndefined();
    // A default profile is materialized for the (now valid) active provider.
    expect(store.profiles[DEFAULT_SETTINGS.provider]).toBeDefined();
  });

  it("materializes a default profile when the active provider profile is missing", async () => {
    __resetSettingsStoreForTests({
      store: { version: 2, activeProvider: "openai", profiles: {} },
      keychain: memoryKeychain(),
    });

    const store = await loadLlmStore();
    expect(store.activeProvider).toBe("openai");
    expect(store.profiles.openai).toEqual(defaultProviderProfile("openai"));
  });
});
