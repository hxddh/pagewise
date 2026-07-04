import { LazyStore } from "@tauri-apps/plugin-store";
import { getApiKey, setApiKey } from "./api-key-store";
import {
  ALL_PROVIDER_IDS,
  DEFAULT_SETTINGS,
  LEGACY_MODEL_MAP,
  PROVIDER_PRESETS,
  defaultAgentModel,
  defaultVisionModel,
  type LlmSettings,
  type LlmStoreV2,
  type ProviderId,
  type ProviderProfile,
} from "./types";
import { isToolModel, isVisionModel } from "./model-capabilities";

const STORE_PATH = "settings.json";
const SETTINGS_KEY = "llm";

/** Fields persisted in settings.json — apiKey lives in the OS keychain when available. */
type StoredLlmV1 = Omit<LlmSettings, "apiKey"> & { apiKey?: string; version?: number };

/**
 * On-disk payload. When the OS keychain is unavailable (e.g. Linux without a Secret
 * Service), API keys are kept here as a per-provider plaintext fallback (`apiKeys`) so a
 * saved key survives restarts and unrelated setting saves. `apiKey` is the legacy
 * single-slot fallback (associated with the active provider), read for backward compat.
 */
type StoredPayload = LlmStoreV2 & {
  apiKey?: string;
  apiKeys?: Partial<Record<ProviderId, string>>;
};

type RawStored = StoredLlmV1 & Partial<StoredPayload>;

type KeychainGet = (provider: ProviderId) => Promise<string>;
type KeychainSet = (provider: ProviderId, key: string) => Promise<void>;

let store: LazyStore | null = null;

/** In-memory store + injectable keychain for unit tests (mirrors chat-sessions.ts). */
let memoryStore: { value: StoredPayload | null } | null = null;
let keychainGet: KeychainGet = getApiKey;
let keychainSet: KeychainSet = setApiKey;

/**
 * Test seam: swap the Tauri store for an in-memory one and inject a fake keychain.
 * Passing no args (or a keychain that throws) simulates a machine with no working keychain.
 */
export function __resetSettingsStoreForTests(opts?: {
  store?: StoredPayload | null;
  keychain?: { get?: KeychainGet; set?: KeychainSet } | null;
}): void {
  memoryStore = { value: opts?.store ?? null };
  store = null;
  keychainGet = opts?.keychain?.get ?? getApiKey;
  keychainSet = opts?.keychain?.set ?? setApiKey;
}

/** Test helper: inspect the raw persisted payload (including plaintext key fallbacks). */
export function __peekSettingsStoreForTests(): StoredPayload | null {
  return memoryStore ? memoryStore.value : null;
}

async function getStore(): Promise<LazyStore> {
  if (memoryStore) {
    const mem = memoryStore;
    return {
      get: async (key: string) => (key === SETTINGS_KEY ? mem.value : null),
      set: async (key: string, value: unknown) => {
        if (key === SETTINGS_KEY) mem.value = value as StoredPayload;
      },
      save: async () => {},
    } as unknown as LazyStore;
  }
  if (!store) {
    store = new LazyStore(STORE_PATH);
  }
  return store;
}

export function defaultProviderProfile(provider: ProviderId): ProviderProfile {
  if (provider === "custom") {
    return {
      model: "",
      visionModel: "",
      baseURL: "",
      thinkingEnabled: false,
      connectionVerified: false,
    };
  }
  const preset = PROVIDER_PRESETS[provider];
  return {
    model: preset.defaultModel,
    visionModel: defaultVisionModel(provider),
    thinkingEnabled: false,
    connectionVerified: false,
  };
}

export function migrateLlmSettings(saved: Partial<LlmSettings> | null | undefined): LlmSettings {
  const merged: LlmSettings = { ...DEFAULT_SETTINGS, ...saved };
  // Coerce a corrupt/non-string model before any string ops (.startsWith etc).
  merged.model = typeof merged.model === "string" ? merged.model : DEFAULT_SETTINGS.model;
  const legacy = LEGACY_MODEL_MAP[merged.model];
  if (legacy) {
    merged.model = legacy.model;
    merged.thinkingEnabled = legacy.thinkingEnabled;
    merged.connectionVerified = false;
  }
  if (merged.provider === "deepseek" && merged.model.startsWith("deepseek-") && !merged.model.includes("v4")) {
    merged.model = "deepseek-v4-flash";
    merged.connectionVerified = false;
  }
  if (
    merged.provider === "deepseek" &&
    (merged.baseURL === "https://api.deepseek.com/v1" ||
      merged.baseURL === "https://api.deepseek.com/v1/")
  ) {
    merged.baseURL = undefined;
    merged.connectionVerified = false;
  }
  if (
    merged.provider === "openrouter" &&
    (merged.model === "deepseek/deepseek-v4-flash" ||
      merged.model === "deepseek/deepseek-v4-pro")
  ) {
    merged.model = "openai/gpt-4o-mini";
    merged.connectionVerified = false;
  }
  return merged;
}

function migrateProviderProfile(
  provider: ProviderId,
  profile: ProviderProfile,
): ProviderProfile {
  const asSettings = migrateLlmSettings({ provider, ...profile, apiKey: "" });
  let model = asSettings.model;
  let visionModel = profile.visionModel?.trim() ?? "";
  let connectionVerified = asSettings.connectionVerified;

  if (provider !== "custom") {
    const presetProvider = provider as Exclude<ProviderId, "custom">;
    if (!visionModel) {
      visionModel =
        isVisionModel(provider, model) && !isToolModel(provider, model)
          ? model
          : defaultVisionModel(presetProvider);
    }
    if (!isToolModel(provider, model)) {
      model = defaultAgentModel(presetProvider);
      connectionVerified = false;
    }
  }

  return {
    model,
    visionModel: visionModel || undefined,
    baseURL: asSettings.baseURL,
    thinkingEnabled: asSettings.thinkingEnabled,
    connectionVerified,
  };
}

function profileToSettings(
  provider: ProviderId,
  profile: ProviderProfile,
  apiKey: string,
): LlmSettings {
  return {
    provider,
    model: profile.model,
    baseURL: profile.baseURL,
    thinkingEnabled: profile.thinkingEnabled,
    connectionVerified: profile.connectionVerified,
    apiKey,
  };
}

/** Settings metadata without reading the OS keychain (safe at app startup). */
export type LlmSettingsMeta = Omit<LlmSettings, "apiKey"> & {
  hasStoredKey: boolean;
  visionModel: string;
};

function settingsToProfile(settings: LlmSettings, visionModel?: string): ProviderProfile {
  return {
    model: settings.model,
    visionModel,
    baseURL: settings.baseURL,
    thinkingEnabled: settings.thinkingEnabled,
    connectionVerified: settings.connectionVerified,
  };
}

export function migrateV1ToV2(saved: Partial<LlmSettings> | null | undefined): LlmStoreV2 {
  const merged = migrateLlmSettings(saved);
  return {
    version: 2,
    activeProvider: merged.provider,
    profiles: {
      [merged.provider]: settingsToProfile(merged),
    },
  };
}

function isLlmStoreV2(raw: unknown): raw is LlmStoreV2 {
  return (
    typeof raw === "object" &&
    raw !== null &&
    "version" in raw &&
    (raw as LlmStoreV2).version === 2 &&
    "activeProvider" in raw &&
    "profiles" in raw
  );
}

function normalizeStore(raw: LlmStoreV2): LlmStoreV2 {
  const profiles: Partial<Record<ProviderId, ProviderProfile>> = {};
  const sourceProfiles =
    raw.profiles && typeof raw.profiles === "object" && !Array.isArray(raw.profiles)
      ? raw.profiles
      : {};
  for (const id of ALL_PROVIDER_IDS) {
    const existing = sourceProfiles[id];
    if (existing) {
      profiles[id] = migrateProviderProfile(id, existing);
    }
  }
  const activeProvider = ALL_PROVIDER_IDS.includes(raw.activeProvider)
    ? raw.activeProvider
    : DEFAULT_SETTINGS.provider;
  if (!profiles[activeProvider]) {
    profiles[activeProvider] = defaultProviderProfile(activeProvider);
  }
  return { version: 2, activeProvider, profiles };
}

/**
 * Persist the V2 store. Existing plaintext keychain fallbacks are PRESERVED unless a
 * `keyUpdate` explicitly overwrites (non-empty) or clears (empty string) one provider's key.
 */
async function writeStoreV2(
  storeData: LlmStoreV2,
  keyUpdate?: { provider: ProviderId; apiKey: string },
): Promise<void> {
  const s = await getStore();
  const prior = await s.get<RawStored>(SETTINGS_KEY);

  const fallbackKeys: Partial<Record<ProviderId, string>> = { ...(prior?.apiKeys ?? {}) };

  // Fold any legacy single-slot key into the per-provider map before rewriting.
  if (prior?.apiKey?.trim()) {
    const legacyProvider = isLlmStoreV2(prior) ? prior.activeProvider : storeData.activeProvider;
    if (!fallbackKeys[legacyProvider]?.trim()) {
      fallbackKeys[legacyProvider] = prior.apiKey;
    }
  }

  if (keyUpdate) {
    if (keyUpdate.apiKey.trim()) {
      fallbackKeys[keyUpdate.provider] = keyUpdate.apiKey;
    } else {
      delete fallbackKeys[keyUpdate.provider];
    }
  }

  const payload: StoredPayload = { ...normalizeStore(storeData) };
  const entries = Object.entries(fallbackKeys).filter(([, v]) => v?.trim());
  if (entries.length > 0) {
    payload.apiKeys = Object.fromEntries(entries) as Partial<Record<ProviderId, string>>;
  }

  await s.set(SETTINGS_KEY, payload);
  await s.save();
}

/** Write to keychain and verify read-back. Returns true when keychain holds the key. */
async function persistApiKey(provider: ProviderId, apiKey: string): Promise<boolean> {
  try {
    await keychainSet(provider, apiKey);
    const verified = await keychainGet(provider);
    return verified === apiKey;
  } catch {
    return false;
  }
}

async function loadApiKey(provider: ProviderId, jsonFallback?: string): Promise<string> {
  try {
    const fromKeychain = await keychainGet(provider);
    if (fromKeychain.trim()) return fromKeychain;
  } catch {
    // fall through to json backup
  }
  return jsonFallback?.trim() ?? "";
}

/** The plaintext fallback key stored in settings.json for a provider (keychain-less machines). */
async function getFallbackKey(provider: ProviderId): Promise<string> {
  const s = await getStore();
  const raw = await s.get<RawStored>(SETTINGS_KEY);
  if (!raw) return "";
  const perProvider = raw.apiKeys?.[provider]?.trim();
  if (perProvider) return perProvider;
  if (raw.apiKey?.trim()) {
    const legacyProvider = isLlmStoreV2(raw) ? raw.activeProvider : DEFAULT_SETTINGS.provider;
    if (legacyProvider === provider) return raw.apiKey.trim();
  }
  return "";
}

async function readStoreV2(): Promise<LlmStoreV2> {
  const s = await getStore();
  const raw = await s.get<RawStored>(SETTINGS_KEY);

  if (isLlmStoreV2(raw)) {
    return normalizeStore(raw);
  }

  const migrated = migrateV1ToV2(raw);
  const legacyKey = raw?.apiKey?.trim() ?? "";
  if (legacyKey) {
    const keychainOk = await persistApiKey(migrated.activeProvider, legacyKey);
    // If the keychain accepted the key, drop the plaintext copy; otherwise keep it as fallback.
    await writeStoreV2(migrated, {
      provider: migrated.activeProvider,
      apiKey: keychainOk ? "" : legacyKey,
    });
  } else {
    await writeStoreV2(migrated);
  }
  return migrated;
}

async function hasStoredApiKey(provider: ProviderId): Promise<boolean> {
  if (provider === "ollama") return true;
  const fallback = await getFallbackKey(provider);
  if (fallback.trim()) return true;
  const storeData = await readStoreV2();
  const profile = getProfileFromStore(storeData, provider);
  return profile.connectionVerified === true;
}

function metaFromProfile(
  provider: ProviderId,
  profile: ProviderProfile,
  hasStoredKey: boolean,
): LlmSettingsMeta {
  const visionModel =
    profile.visionModel?.trim() ||
    (provider !== "custom" ? defaultVisionModel(provider as Exclude<ProviderId, "custom">) : "");
  return {
    provider,
    model: profile.model,
    visionModel,
    baseURL: profile.baseURL,
    thinkingEnabled: profile.thinkingEnabled,
    connectionVerified: profile.connectionVerified,
    hasStoredKey,
  };
}
function getProfileFromStore(storeData: LlmStoreV2, provider: ProviderId): ProviderProfile {
  return migrateProviderProfile(
    provider,
    storeData.profiles[provider] ?? defaultProviderProfile(provider),
  );
}

export async function loadLlmStore(): Promise<LlmStoreV2> {
  return readStoreV2();
}

/** Active provider metadata without touching the OS keychain. */
export async function loadSettingsMeta(): Promise<LlmSettingsMeta> {
  const storeData = await readStoreV2();
  const provider = storeData.activeProvider;
  const profile = getProfileFromStore(storeData, provider);
  const hasStoredKey = await hasStoredApiKey(provider);
  return metaFromProfile(provider, profile, hasStoredKey);
}

/** Vision indexing model (separate from agent model when configured). */
export async function loadVisionSettings(): Promise<LlmSettings> {
  const storeData = await readStoreV2();
  const provider = storeData.activeProvider;
  const profile = getProfileFromStore(storeData, provider);
  const apiKey = await loadApiKey(provider, await getFallbackKey(provider));
  const visionModel =
    profile.visionModel?.trim() ||
    (provider !== "custom"
      ? defaultVisionModel(provider as Exclude<ProviderId, "custom">)
      : profile.model);
  return profileToSettings(provider, { ...profile, model: visionModel || profile.model }, apiKey);
}

export async function loadProviderSettings(provider: ProviderId): Promise<LlmSettings> {
  const storeData = await readStoreV2();
  const profile = getProfileFromStore(storeData, provider);
  const apiKey = await loadApiKey(provider, await getFallbackKey(provider));
  return profileToSettings(provider, profile, apiKey);
}

export async function loadApiKeyForProvider(provider: ProviderId): Promise<string> {
  return loadApiKey(provider, await getFallbackKey(provider));
}

/** Active provider + profile — used by Agent and connection status. */
export async function loadSettings(): Promise<LlmSettings> {
  const storeData = await readStoreV2();
  return loadProviderSettings(storeData.activeProvider);
}

export async function getActiveProvider(): Promise<ProviderId> {
  const storeData = await readStoreV2();
  return storeData.activeProvider;
}

export async function saveProviderProfile(
  provider: ProviderId,
  patch: Partial<ProviderProfile>,
  apiKey?: string,
): Promise<LlmSettings> {
  const storeData = await readStoreV2();
  const existing = getProfileFromStore(storeData, provider);
  const nextProfile = migrateProviderProfile(provider, { ...existing, ...patch });
  storeData.profiles[provider] = nextProfile;

  let resolvedKey = apiKey;
  if (resolvedKey !== undefined && resolvedKey.trim()) {
    const migrated = await persistApiKey(provider, resolvedKey);
    // Keychain holds it -> clear any plaintext fallback; otherwise persist the fallback.
    await writeStoreV2(storeData, { provider, apiKey: migrated ? "" : resolvedKey });
  } else if (resolvedKey === undefined) {
    // No key change requested — preserve existing keychain/fallback state.
    await writeStoreV2(storeData);
    resolvedKey = await loadApiKey(provider, await getFallbackKey(provider));
  } else {
    // Explicit clear of the key.
    await writeStoreV2(storeData, { provider, apiKey: "" });
    resolvedKey = "";
  }

  return profileToSettings(provider, nextProfile, resolvedKey ?? "");
}

export async function setActiveProvider(provider: ProviderId): Promise<LlmSettings> {
  const storeData = await readStoreV2();
  if (!storeData.profiles[provider]) {
    storeData.profiles[provider] = defaultProviderProfile(provider);
  }
  storeData.activeProvider = provider;
  await writeStoreV2(storeData);
  return loadProviderSettings(provider);
}

export async function markProviderVerified(
  provider: ProviderId,
  verified: boolean,
): Promise<LlmSettings> {
  return saveProviderProfile(provider, { connectionVerified: verified });
}

/** Saves profile for settings.provider — does not change the active provider. */
export async function saveSettings(
  settings: LlmSettings,
  visionModel?: string,
): Promise<void> {
  const profile = settingsToProfile(migrateLlmSettings(settings), visionModel);
  const priorKey = await loadApiKey(settings.provider, await getFallbackKey(settings.provider));
  let apiKey: string | undefined = settings.apiKey;
  if (!apiKey.trim() && priorKey.trim()) {
    apiKey = priorKey;
  }
  await saveProviderProfile(
    settings.provider,
    profile,
    settings.apiKey.trim() ? apiKey : undefined,
  );
}
