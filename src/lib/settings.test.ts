import { afterEach, describe, expect, it } from "vitest";
import {
  __peekSettingsStoreForTests,
  __resetSettingsStoreForTests,
  defaultProviderProfile,
  loadApiKeyForProvider,
  loadLlmStore,
  loadProviderSettings,
  loadSettings,
  loadSettingsMeta,
  loadVisionSettings,
  reofferPlaintextMirrors,
  resetKeychainBlockedFlag,
  saveProviderProfile,
  saveSettings,
  setActiveProvider,
} from "./settings";
import { settingsPersistSnapshot } from "./redact-settings";
import {
  DEFAULT_SETTINGS,
  PROVIDER_PRESETS,
  type LlmSettings,
  type ProviderId,
} from "./types";

describe("legacy model ids are rewritten on read", () => {
  afterEach(() => {
    __resetSettingsStoreForTests();
  });

  it("maps legacy deepseek-chat model", async () => {
    __resetSettingsStoreForTests({
      store: { provider: "deepseek", model: "deepseek-chat", apiKey: "" },
      keychain: memoryKeychain(),
    });
    const result = await loadSettings();
    expect(result.model).toBe("deepseek-v4-flash");
    expect(result.thinkingEnabled).toBe(false);
    expect(result.connectionVerified).toBe(false);
  });

  it("normalizes deepseek /v1 base URL", async () => {
    __resetSettingsStoreForTests({
      store: {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        baseURL: "https://api.deepseek.com/v1",
        apiKey: "",
      },
      keychain: memoryKeychain(),
    });
    expect((await loadSettings()).baseURL).toBeUndefined();
  });

  it("migrates OpenRouter DeepSeek V4 to a tool-capable model", async () => {
    __resetSettingsStoreForTests({
      store: { provider: "openrouter", model: "deepseek/deepseek-v4-flash", apiKey: "" },
      keychain: memoryKeychain(),
    });
    const result = await loadSettings();
    expect(result.model).toBe("openai/gpt-4o-mini");
    expect(result.connectionVerified).toBe(false);
  });

  it("coerces a non-string model from a corrupt store without throwing", async () => {
    __resetSettingsStoreForTests({
      store: { provider: "deepseek", model: 42 as unknown as string, apiKey: "" },
      keychain: memoryKeychain(),
    });
    expect((await loadSettings()).model).toBe(DEFAULT_SETTINGS.model);
  });

  it("does not throw when model is null", async () => {
    __resetSettingsStoreForTests({
      store: { provider: "openrouter", model: null as unknown as string },
      keychain: memoryKeychain(),
    });
    await expect(loadSettings()).resolves.toBeTruthy();
  });
});

describe("v1 payload migrates on read", () => {
  afterEach(() => {
    __resetSettingsStoreForTests();
  });

  it("preserves the active provider profile, model rewrite and key", async () => {
    const keychain = memoryKeychain();
    __resetSettingsStoreForTests({
      store: {
        provider: "openrouter",
        model: "deepseek/deepseek-v4-flash",
        thinkingEnabled: true,
        connectionVerified: true,
        apiKey: "sk-test",
      },
      keychain,
    });

    const store = await loadLlmStore();
    expect(store.version).toBe(3);
    expect(store.activeProvider).toBe("openrouter");
    expect(store.profiles.openrouter).toEqual({
      model: "openai/gpt-4o-mini",
      visionModel: "google/gemini-2.5-flash-lite",
      // The rewrite also drops thinking: gpt-4o-mini does not support it.
      thinkingEnabled: false,
      connectionVerified: false,
    });
    // The single legacy slot is folded in, moved to the keychain, and the
    // plaintext copy is not written back.
    expect((await loadProviderSettings("openrouter")).apiKey).toBe("sk-test");
    expect(__peekSettingsStoreForTests()?.keys?.openrouter).toBeUndefined();
    expect(await keychain.get("openrouter")).toBe("sk-test");
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
      visionModel: "",
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
    expect(persisted?.keys?.openai).toBe("sk-openai-1");
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
    // The tombstone is the record of the clear: absent would mean "ask the
    // keychain again", which is what resurrected removed keys before 18.0.
    expect(__peekSettingsStoreForTests()?.keys?.openai).toBe(null);
  });
});

/**
 * The plaintext mirror's way out (20.0).
 *
 * A mirror is written when the keychain refuses the key, and until 20.0 nothing
 * ever offered it again: `readPayload` skipped the migration once the payload
 * was v3, `loadApiKey` returned the mirror without asking, and re-saving the
 * same key passed no key argument at all — so a key that landed on disk once
 * stayed there for good. The only exit was typing a *different* key.
 */
describe("plaintext mirror has a way out", () => {
  afterEach(() => {
    __resetSettingsStoreForTests();
  });

  /** A keychain that refuses every call until the reader unlocks it. */
  function flakyKeychain() {
    const keys = new Map<ProviderId, string>();
    let reachable = false;
    return {
      allow(): void {
        reachable = true;
      },
      get: async (provider: ProviderId): Promise<string> => {
        if (!reachable) throw new Error("keychain unavailable");
        return keys.get(provider) ?? "";
      },
      set: async (provider: ProviderId, key: string): Promise<void> => {
        if (!reachable) throw new Error("keychain unavailable");
        keys.set(provider, key);
      },
    };
  }

  it("moves the mirror into the keychain when it becomes reachable, and off the disk", async () => {
    const keychain = flakyKeychain();
    __resetSettingsStoreForTests({ keychain });
    await saveProviderProfile("openai", { model: "gpt-4o-mini" }, "sk-mirrored");
    expect(__peekSettingsStoreForTests()?.keys?.openai).toBe("sk-mirrored");

    // Later: the keychain works (the reader unlocked it; the build was signed).
    keychain.allow();
    resetKeychainBlockedFlag();
    expect(await reofferPlaintextMirrors()).toBe(1);

    expect(__peekSettingsStoreForTests()?.keys?.openai).toBeUndefined();
    expect(await keychain.get("openai")).toBe("sk-mirrored");
    // And the reader still has their key.
    expect(await loadApiKeyForProvider("openai")).toBe("sk-mirrored");
  });

  it("keeps the mirror, and says nothing moved, while the keychain still refuses", async () => {
    __resetSettingsStoreForTests({ keychain: brokenKeychain() });
    await saveProviderProfile("openai", { model: "gpt-4o-mini" }, "sk-mirrored");

    expect(await reofferPlaintextMirrors()).toBe(0);
    expect(__peekSettingsStoreForTests()?.keys?.openai).toBe("sk-mirrored");
    expect((await loadProviderSettings("openai")).apiKey).toBe("sk-mirrored");
  });

  it("moves it on the next successful keychain write, not only on a re-offer", async () => {
    const keychain = flakyKeychain();
    __resetSettingsStoreForTests({ keychain });
    await saveProviderProfile("openai", { model: "gpt-4o-mini" }, "sk-mirrored");

    keychain.allow();
    resetKeychainBlockedFlag();
    // The reader re-saves the same key — or any other field. Before 20.0 this
    // path passed no key argument and left the mirror exactly where it was.
    await saveProviderProfile("openai", { model: "gpt-4o-mini" });

    expect(__peekSettingsStoreForTests()?.keys?.openai).toBeUndefined();
    expect(await keychain.get("openai")).toBe("sk-mirrored");
  });

  it("never writes a mirror over a different key the keychain already has", async () => {
    const keychain = flakyKeychain();
    keychain.allow();
    await keychain.set("openai", "sk-current");
    __resetSettingsStoreForTests({
      store: {
        version: 3,
        activeProvider: "openai",
        profiles: { openai: defaultProviderProfile("openai") },
        keys: { openai: "sk-stale-mirror" },
      },
      keychain,
    });

    expect(await reofferPlaintextMirrors()).toBe(0);
    expect(await keychain.get("openai")).toBe("sk-current");
    // The stale mirror is left alone rather than deleted behind the reader.
    expect(__peekSettingsStoreForTests()?.keys?.openai).toBe("sk-stale-mirror");
  });
});

describe("settingsPersistSnapshot — apiKey change detection", () => {
  const base: LlmSettings = {
    ...DEFAULT_SETTINGS,
    provider: "openai",
    model: "gpt-4o-mini",
  };

  it("produces a DIFFERENT snapshot when only the apiKey value changes", () => {
    // Regression: redacting every key to "[redacted]" made sk-A and sk-B look
    // identical, so the debounced save deduped and never persisted the change.
    const a = settingsPersistSnapshot({ ...base, apiKey: "sk-A" });
    const b = settingsPersistSnapshot({ ...base, apiKey: "sk-B" });
    expect(a).not.toBe(b);
  });

  it("is stable for an unchanged key (so unrelated saves still dedup)", () => {
    const a = settingsPersistSnapshot({ ...base, apiKey: "sk-same" }, "gpt-4o-mini");
    const b = settingsPersistSnapshot({ ...base, apiKey: "sk-same" }, "gpt-4o-mini");
    expect(a).toBe(b);
  });

  it("never leaks the raw key into the snapshot", () => {
    const snap = settingsPersistSnapshot({ ...base, apiKey: "sk-test-rawvalue-123" });
    expect(snap).not.toContain("sk-test-rawvalue-123");
  });

  it("distinguishes a set key from an empty key", () => {
    const empty = settingsPersistSnapshot({ ...base, apiKey: "" });
    const set = settingsPersistSnapshot({ ...base, apiKey: "sk-A" });
    expect(empty).not.toBe(set);
  });
});

describe("migrateProviderProfile", () => {
  it("preserves a vision-only OpenRouter model in the agent slot (validated at send)", async () => {
    __resetSettingsStoreForTests({
      store: {
        version: 2,
        activeProvider: "openrouter",
        profiles: {
          openrouter: {
            model: "qwen/qwen2.5-vl-72b-instruct",
            connectionVerified: true,
          },
        },
      },
      keychain: memoryKeychain(),
    });

    const store = await loadLlmStore();
    const profile = store.profiles.openrouter!;
    expect(profile.model).toBe("qwen/qwen2.5-vl-72b-instruct");
    expect(profile.visionModel).toBe("qwen/qwen2.5-vl-72b-instruct");
    expect(profile.connectionVerified).toBe(true);
  });

  it("resets legacy shared agent/scan model id to default scan preset", async () => {
    __resetSettingsStoreForTests({
      store: {
        version: 2,
        activeProvider: "openrouter",
        profiles: {
          openrouter: {
            model: "openai/gpt-4o-mini",
            visionModel: "openai/gpt-4o-mini",
            connectionVerified: true,
          },
        },
      },
      keychain: memoryKeychain(),
    });

    const store = await loadLlmStore();
    const profile = store.profiles.openrouter!;
    expect(profile.visionModel).toBe("google/gemini-2.5-flash-lite");
    expect(profile.model).toBe("openai/gpt-4o-mini");
  });

  it("clears thinking when the assistant model does not support it", async () => {
    __resetSettingsStoreForTests({
      store: {
        version: 2,
        activeProvider: "openrouter",
        profiles: {
          openrouter: {
            model: "openai/gpt-4o-mini",
            thinkingEnabled: true,
            connectionVerified: true,
          },
        },
      },
      keychain: memoryKeychain(),
    });

    const store = await loadLlmStore();
    expect(store.profiles.openrouter!.thinkingEnabled).toBe(false);
  });

  it("loadVisionSettings uses default scan model when stored model is not vision-capable", async () => {
    __resetSettingsStoreForTests({
      store: {
        version: 2,
        activeProvider: "openrouter",
        profiles: {
          openrouter: {
            model: "openai/gpt-4o-mini",
            visionModel: "openai/gpt-4o-mini",
            connectionVerified: true,
          },
        },
      },
      keychain: memoryKeychain(),
    });

    const vision = await loadVisionSettings();
    expect(vision.model).toBe("google/gemini-2.5-flash-lite");
  });

  it("loadVisionSettings preserves custom OpenRouter scan model", async () => {
    __resetSettingsStoreForTests({
      store: {
        version: 2,
        activeProvider: "openrouter",
        profiles: {
          openrouter: {
            model: "openai/gpt-4o-mini",
            visionModel: "anthropic/claude-3.5-sonnet",
            connectionVerified: true,
          },
        },
      },
      keychain: memoryKeychain(),
    });

    const vision = await loadVisionSettings();
    expect(vision.model).toBe("anthropic/claude-3.5-sonnet");
  });

  it("loadVisionSettings does not fall back to agent model for custom provider with empty scan", async () => {
    __resetSettingsStoreForTests({
      store: {
        version: 2,
        activeProvider: "custom",
        profiles: {
          custom: {
            model: "my-agent-model",
            visionModel: "",
            connectionVerified: true,
          },
        },
      },
      keychain: memoryKeychain(),
    });

    const vision = await loadVisionSettings();
    expect(vision.model).toBe("");
  });

  it("loadVisionSettings preserves explicit DeepSeek scan model distinct from agent", async () => {
    __resetSettingsStoreForTests({
      store: {
        version: 2,
        activeProvider: "deepseek",
        profiles: {
          deepseek: {
            model: "deepseek-v4-flash",
            visionModel: "some-custom-scan-model",
            connectionVerified: true,
          },
        },
      },
      keychain: memoryKeychain(),
    });

    const vision = await loadVisionSettings();
    expect(vision.model).toBe("some-custom-scan-model");
  });

  it("migrates unreliable gemma-4 free scan model to default", async () => {
    __resetSettingsStoreForTests({
      store: {
        version: 2,
        activeProvider: "openrouter",
        profiles: {
          openrouter: {
            model: "openai/gpt-4o-mini",
            visionModel: "google/gemma-4-31b-it:free",
            connectionVerified: true,
          },
        },
      },
      keychain: memoryKeychain(),
    });

    const store = await loadLlmStore();
    expect(store.profiles.openrouter!.visionModel).toBe("google/gemini-2.5-flash-lite");
  });
});

describe("store I/O — working keychain", () => {
  afterEach(() => {
    __resetSettingsStoreForTests();
  });

  it("keeps API keys off settings.json when the keychain works", async () => {
    __resetSettingsStoreForTests({ keychain: memoryKeychain() });
    await saveProviderProfile("openai", { model: "gpt-4o-mini" }, "sk-openai");

    expect((await loadProviderSettings("openai")).apiKey).toBe("sk-openai");
    expect(__peekSettingsStoreForTests()?.keys?.openai).toBeUndefined();
  });

  it("prefers local mirror over keychain on read when both exist", async () => {
    const keychain = memoryKeychain();
    __resetSettingsStoreForTests({
      store: {
        version: 2,
        activeProvider: "openai",
        profiles: { openai: defaultProviderProfile("openai") },
        apiKeys: { openai: "sk-from-disk" },
        apiKeysMigratedFromKeychain: true,
      },
      keychain,
    });
    await keychain.set("openai", "sk-from-keychain");

    expect((await loadProviderSettings("openai")).apiKey).toBe("sk-from-disk");
  });

  it("falls back to keychain when local mirror is empty", async () => {
    const keychain = memoryKeychain();
    __resetSettingsStoreForTests({
      store: {
        version: 2,
        activeProvider: "openai",
        profiles: { openai: defaultProviderProfile("openai") },
        apiKeysMigratedFromKeychain: true,
      },
      keychain,
    });
    await keychain.set("openai", "sk-from-keychain");

    expect((await loadProviderSettings("openai")).apiKey).toBe("sk-from-keychain");
  });

  it("scrubs stale plaintext mirrors when keychain is available", async () => {
    const keychain = memoryKeychain();
    __resetSettingsStoreForTests({
      store: {
        version: 2,
        activeProvider: "openai",
        profiles: { openai: defaultProviderProfile("openai") },
        apiKeys: { openai: "sk-on-disk" },
        apiKeysMigratedFromKeychain: true,
      },
      keychain,
    });

    expect((await loadSettingsMeta()).plaintextKeysOnDisk).toBe(false);
    expect(__peekSettingsStoreForTests()?.keys?.openai).toBeUndefined();
    expect(await keychain.get("openai")).toBe("sk-on-disk");
    expect((await loadProviderSettings("openai")).apiKey).toBe("sk-on-disk");
  });

  it("reads every provider key from the keychain once, writing no mirror", async () => {
    const keychain = memoryKeychain();
    await keychain.set("openai", "sk-openai");
    await keychain.set("openrouter", "sk-router");
    __resetSettingsStoreForTests({
      store: {
        version: 2,
        activeProvider: "openai",
        profiles: {
          openai: defaultProviderProfile("openai"),
          openrouter: defaultProviderProfile("openrouter"),
        },
      },
      keychain,
    });

    expect((await loadProviderSettings("openrouter")).apiKey).toBe("sk-router");
    expect((await loadProviderSettings("openai")).apiKey).toBe("sk-openai");
    expect(__peekSettingsStoreForTests()?.version).toBe(3);
    expect(__peekSettingsStoreForTests()?.keys?.openrouter).toBeUndefined();
  });

  it("retries keychain migration after access is denied", async () => {
    let denyKeychain = true;
    const keychain = {
      get: async (provider: ProviderId): Promise<string> => {
        if (denyKeychain) throw new Error("denied");
        return provider === "openrouter" ? "sk-router" : "";
      },
      set: async (): Promise<void> => {},
    };
    __resetSettingsStoreForTests({
      store: {
        version: 2,
        activeProvider: "openrouter",
        profiles: { openrouter: defaultProviderProfile("openrouter") },
      },
      keychain,
    });

    expect((await loadProviderSettings("openrouter")).apiKey).toBe("");
    expect(__peekSettingsStoreForTests()?.version).toBe(3);

    denyKeychain = false;
    // A plain re-read stays blocked this session (no keychain re-hammering /
    // OS-prompt storm); the retry only happens after an explicit user action —
    // opening Settings, which calls resetKeychainBlockedFlag().
    expect((await loadProviderSettings("openrouter")).apiKey).toBe("");
    resetKeychainBlockedFlag();
    expect((await loadProviderSettings("openrouter")).apiKey).toBe("sk-router");
    expect(__peekSettingsStoreForTests()?.version).toBe(3);
  });

  it("does not resurrect an explicitly-cleared key after keychain becomes available", async () => {
    // Regression: the keychain migration dropped `apiKeysCleared`, so on the
    // blocked -> available retry a deliberately-removed key got re-imported.
    let denyKeychain = true;
    const keychain = {
      get: async (provider: ProviderId): Promise<string> => {
        if (denyKeychain) throw new Error("denied");
        return provider === "openrouter" ? "sk-router" : "";
      },
      set: async (): Promise<void> => {},
    };
    __resetSettingsStoreForTests({
      store: {
        version: 2,
        activeProvider: "openrouter",
        profiles: { openrouter: defaultProviderProfile("openrouter") },
        apiKeysCleared: { openrouter: true },
      },
      keychain,
    });

    // Keychain blocked: migration incomplete, cleared flag must be preserved.
    expect((await loadProviderSettings("openrouter")).apiKey).toBe("");
    expect(__peekSettingsStoreForTests()?.keys?.openrouter).toBe(null);

    // Keychain now available on retry — the cleared key must NOT come back.
    denyKeychain = false;
    expect((await loadProviderSettings("openrouter")).apiKey).toBe("");
    expect(__peekSettingsStoreForTests()?.keys?.openrouter).toBe(null);
    expect(typeof __peekSettingsStoreForTests()?.keys?.openrouter).toBe("object");
  });

  it("saveSettings with unchanged apiKey does not touch the key mirror", async () => {
    const keychain = memoryKeychain();
    __resetSettingsStoreForTests({ keychain });
    await saveProviderProfile("openai", { model: "gpt-4o-mini" }, "sk-openai");

    const before = __peekSettingsStoreForTests()?.keys?.openai;
    const loaded = await loadProviderSettings("openai");
    await saveSettings({ ...loaded, thinkingEnabled: true });

    expect(__peekSettingsStoreForTests()?.keys?.openai).toBe(before);
    expect(await keychain.get("openai")).toBe("sk-openai");
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
    expect(__peekSettingsStoreForTests()?.keys?.openrouter).toBeUndefined();
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

describe("session key cache", () => {
  it("asks the keychain once per key, not once per read", async () => {
    // Settings are resolved on every vision-indexed page, so without this a
    // scan meant one keychain round trip per page — and on an unsigned macOS
    // build, one OS password prompt per page.
    let reads = 0;
    __resetSettingsStoreForTests({
      store: { activeProvider: "openai", profiles: {} } as never,
      keychain: {
        get: async () => {
          reads += 1;
          return "sk-cached";
        },
        set: async () => {},
      },
    });
    expect(await loadApiKeyForProvider("openai")).toBe("sk-cached");
    // The first resolve also runs the one-time migration, which walks every
    // provider. What matters is that reading again costs nothing.
    const afterFirst = reads;
    expect(await loadApiKeyForProvider("openai")).toBe("sk-cached");
    expect(await loadApiKeyForProvider("openai")).toBe("sk-cached");
    expect(reads).toBe(afterFirst);
  });

  it("re-reads after the key is saved", async () => {
    const keys = ["sk-old", "sk-new"];
    let i = 0;
    __resetSettingsStoreForTests({
      store: { activeProvider: "openai", profiles: {} } as never,
      keychain: {
        get: async () => keys[Math.min(i, keys.length - 1)]!,
        set: async () => {
          i = 1;
        },
      },
    });
    expect(await loadApiKeyForProvider("openai")).toBe("sk-old");
    await saveProviderProfile("openai", {}, "sk-new");
    expect(await loadApiKeyForProvider("openai")).toBe("sk-new");
  });
});
