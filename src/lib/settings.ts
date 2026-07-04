import { LazyStore } from "@tauri-apps/plugin-store";
import { getApiKey, setApiKey } from "./api-key-store";
import {
  ALL_PROVIDER_IDS,
  DEFAULT_SETTINGS,
  LEGACY_MODEL_MAP,
  PROVIDER_PRESETS,
  type LlmSettings,
  type LlmStoreV2,
  type ProviderId,
  type ProviderProfile,
} from "./types";

const STORE_PATH = "settings.json";
const SETTINGS_KEY = "llm";

let store: LazyStore | null = null;

async function getStore(): Promise<LazyStore> {
  if (!store) {
    store = new LazyStore(STORE_PATH);
  }
  return store;
}

/** Fields persisted in settings.json — apiKey lives in the OS keychain when available. */
type StoredLlmV1 = Omit<LlmSettings, "apiKey"> & { apiKey?: string; version?: number };

export function defaultProviderProfile(provider: ProviderId): ProviderProfile {
  if (provider === "custom") {
    return {
      model: "",
      baseURL: "",
      thinkingEnabled: false,
      connectionVerified: false,
    };
  }
  const preset = PROVIDER_PRESETS[provider];
  return {
    model: preset.defaultModel,
    thinkingEnabled: false,
    connectionVerified: false,
  };
}

export function migrateLlmSettings(saved: Partial<LlmSettings> | null | undefined): LlmSettings {
  const merged: LlmSettings = { ...DEFAULT_SETTINGS, ...saved };
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
  return {
    model: asSettings.model,
    baseURL: asSettings.baseURL,
    thinkingEnabled: asSettings.thinkingEnabled,
    connectionVerified: asSettings.connectionVerified,
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

function settingsToProfile(settings: LlmSettings): ProviderProfile {
  return {
    model: settings.model,
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
  for (const id of ALL_PROVIDER_IDS) {
    const existing = raw.profiles[id];
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

async function writeStoreV2(storeData: LlmStoreV2, legacyApiKeyInJson?: string): Promise<void> {
  const s = await getStore();
  const payload: LlmStoreV2 & { apiKey?: string } = {
    ...normalizeStore(storeData),
  };
  if (legacyApiKeyInJson?.trim()) {
    payload.apiKey = legacyApiKeyInJson;
  }
  await s.set(SETTINGS_KEY, payload);
  await s.save();
}

/** Write to keychain and verify read-back. Returns true when keychain holds the key. */
async function persistApiKey(provider: ProviderId, apiKey: string): Promise<boolean> {
  await setApiKey(provider, apiKey);
  const verified = await getApiKey(provider);
  return verified === apiKey;
}

async function loadApiKey(provider: ProviderId, jsonFallback?: string): Promise<string> {
  try {
    const fromKeychain = await getApiKey(provider);
    if (fromKeychain.trim()) return fromKeychain;
  } catch {
    // fall through to json backup
  }
  return jsonFallback?.trim() ?? "";
}

async function readStoreV2(): Promise<LlmStoreV2> {
  const s = await getStore();
  const raw = await s.get<StoredLlmV1 & Partial<LlmStoreV2>>(SETTINGS_KEY);

  if (isLlmStoreV2(raw)) {
    return normalizeStore(raw);
  }

  const migrated = migrateV1ToV2(raw);
  const legacyKey = raw?.apiKey?.trim() ?? "";
  if (legacyKey) {
    await persistApiKey(migrated.activeProvider, legacyKey);
    const keychainOk = (await getApiKey(migrated.activeProvider)) === legacyKey;
    await writeStoreV2(migrated, keychainOk ? undefined : legacyKey);
  } else {
    await writeStoreV2(migrated);
  }
  return migrated;
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

export async function loadProviderSettings(provider: ProviderId): Promise<LlmSettings> {
  const storeData = await readStoreV2();
  const profile = getProfileFromStore(storeData, provider);
  const apiKey = await loadApiKey(provider);
  return profileToSettings(provider, profile, apiKey);
}

export async function loadApiKeyForProvider(provider: ProviderId): Promise<string> {
  return loadApiKey(provider);
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
  await writeStoreV2(storeData);

  let resolvedKey = apiKey;
  if (resolvedKey !== undefined && resolvedKey.trim()) {
    const migrated = await persistApiKey(provider, resolvedKey);
    if (!migrated) {
      await writeStoreV2(storeData, resolvedKey);
    }
  } else if (resolvedKey === undefined) {
    resolvedKey = await loadApiKey(provider);
  } else {
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
export async function saveSettings(settings: LlmSettings): Promise<void> {
  const profile = settingsToProfile(migrateLlmSettings(settings));
  const priorKey = await loadApiKey(settings.provider);
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
