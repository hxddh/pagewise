import { LazyStore } from "@tauri-apps/plugin-store";
import { getApiKey, setApiKey, deleteApiKey } from "./api-key-store";
import {
  ALL_PROVIDER_IDS,
  DEFAULT_SETTINGS,
  LEGACY_MODEL_MAP,
  PROVIDER_PRESETS,
  defaultVisionModel,
  visionPresetModels,
  type LlmSettings,
  type LlmStoreV2,
  type ProviderId,
  type ProviderProfile,
} from "./types";
import { isThinkingCapableModel, isKnownNonVisionModel, isToolModel, isVisionModel } from "./model-capabilities";

const STORE_PATH = "settings.json";
const SETTINGS_KEY = "llm";

/** Fields persisted in settings.json — apiKey also mirrored in `apiKeys` for reliable reads. */
type StoredLlmV1 = Omit<LlmSettings, "apiKey"> & { apiKey?: string; version?: number };

/**
 * On-disk payload. API keys are mirrored in `apiKeys` (per provider) inside the local
 * Tauri app data directory so keys survive unsigned macOS rebuilds where Keychain access
 * prompts or fails. The OS keychain is still updated when available. `apiKey` is the legacy
 * single-slot fallback (associated with the active provider), read for backward compat.
 */
type StoredPayload = LlmStoreV2 & {
  apiKey?: string;
  apiKeys?: Partial<Record<ProviderId, string>>;
  /** Providers whose keys were explicitly cleared — skip keychain re-import. */
  apiKeysCleared?: Partial<Record<ProviderId, true>>;
  /** One-time migration: copy any OS keychain keys into the local mirror. */
  apiKeysMigratedFromKeychain?: boolean;
};

type RawStored = StoredLlmV1 & Partial<StoredPayload>;

type KeychainGet = (provider: ProviderId) => Promise<string>;
type KeychainSet = (provider: ProviderId, key: string) => Promise<void>;

let store: LazyStore | null = null;
let migrationPromise: Promise<void> | null = null;

let settingsStoreLock: Promise<unknown> = Promise.resolve();
function withSettingsStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = settingsStoreLock.then(fn, fn);
  settingsStoreLock = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** In-memory store + injectable keychain for unit tests. */
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
  migrationPromise = null;
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

  let thinkingEnabled = asSettings.thinkingEnabled;

  if (provider !== "custom") {
    const presetProvider = provider as Exclude<ProviderId, "custom">;
    const visionPresets = visionPresetModels(presetProvider);
    if (!visionModel) {
      visionModel =
        isVisionModel(provider, model) && !isToolModel(provider, model)
          ? model
          : defaultVisionModel(presetProvider);
    } else if (
      visionPresets.length > 0 &&
      !visionPresets.includes(visionModel) &&
      visionModel === model &&
      isToolModel(provider, model)
    ) {
      visionModel = defaultVisionModel(presetProvider);
    } else if (
      visionModel === "google/gemma-4-31b-it:free" &&
      visionPresets.length > 0
    ) {
      visionModel = defaultVisionModel(presetProvider);
    }
    if (thinkingEnabled && !isThinkingCapableModel(provider, model)) {
      thinkingEnabled = false;
    }
  }

  return {
    model,
    visionModel: visionModel || undefined,
    baseURL: asSettings.baseURL,
    thinkingEnabled,
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
  /** True when API keys are mirrored in plaintext on disk (keychain unavailable). */
  plaintextKeysOnDisk: boolean;
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
  keyUpdate?: { provider: ProviderId; apiKey: string; keychainOk?: boolean },
): Promise<void> {
  return withSettingsStoreLock(async () => {
  const s = await getStore();
  const prior = await s.get<RawStored>(SETTINGS_KEY);

  const fallbackKeys: Partial<Record<ProviderId, string>> = { ...(prior?.apiKeys ?? {}) };
  const clearedKeys: Partial<Record<ProviderId, true>> = { ...(prior?.apiKeysCleared ?? {}) };

  // Fold any legacy single-slot key into the per-provider map before rewriting.
  if (prior?.apiKey?.trim()) {
    const legacyProvider = isLlmStoreV2(prior) ? prior.activeProvider : storeData.activeProvider;
    if (!fallbackKeys[legacyProvider]?.trim()) {
      fallbackKeys[legacyProvider] = prior.apiKey;
    }
  }

  if (keyUpdate) {
    if (keyUpdate.apiKey.trim()) {
      if (keyUpdate.keychainOk === false) {
        fallbackKeys[keyUpdate.provider] = keyUpdate.apiKey;
      } else {
        delete fallbackKeys[keyUpdate.provider];
      }
      delete clearedKeys[keyUpdate.provider];
    } else {
      delete fallbackKeys[keyUpdate.provider];
      clearedKeys[keyUpdate.provider] = true;
    }
  }

  const payload: StoredPayload = { ...normalizeStore(storeData) };
  if (prior?.apiKeysMigratedFromKeychain) {
    payload.apiKeysMigratedFromKeychain = true;
  }
  const entries = Object.entries(fallbackKeys).filter(([, v]) => v?.trim());
  if (entries.length > 0) {
    payload.apiKeys = Object.fromEntries(entries) as Partial<Record<ProviderId, string>>;
  }
  if (Object.keys(clearedKeys).length > 0) {
    payload.apiKeysCleared = clearedKeys;
  }

  await s.set(SETTINGS_KEY, payload);
  await s.save();
  });
}

async function persistApiKey(provider: ProviderId, apiKey: string): Promise<boolean> {
  try {
    await keychainSet(provider, apiKey);
    return true;
  } catch {
    return false;
  }
}

/** Copy keychain keys into settings.json once so routine reads never touch Keychain. */
async function migrateKeychainApiKeysIfNeeded(): Promise<void> {
  return withSettingsStoreLock(async () => {
  const s = await getStore();
  const raw = await s.get<RawStored>(SETTINGS_KEY);
  if (raw?.apiKeysMigratedFromKeychain) return;

  const storeData = isLlmStoreV2(raw) ? normalizeStore(raw) : migrateV1ToV2(raw);
  const fallbackKeys: Partial<Record<ProviderId, string>> = { ...(raw?.apiKeys ?? {}) };

  let keychainBlocked = false;
  if (raw?.apiKey?.trim()) {
    const legacyProvider = isLlmStoreV2(raw) ? raw.activeProvider : storeData.activeProvider;
    if (!fallbackKeys[legacyProvider]?.trim()) {
      const legacyKey = raw.apiKey.trim();
      const keychainOk = await persistApiKey(legacyProvider, legacyKey);
      if (!keychainOk) {
        fallbackKeys[legacyProvider] = legacyKey;
        keychainBlocked = true;
      }
    }
  }

  const cleared = raw?.apiKeysCleared ?? {};
  for (const provider of ALL_PROVIDER_IDS) {
    if (provider === "ollama" || fallbackKeys[provider]?.trim() || cleared[provider]) continue;
    try {
      const fromKeychain = await keychainGet(provider);
      if (fromKeychain.trim()) fallbackKeys[provider] = fromKeychain.trim();
    } catch {
      keychainBlocked = true;
    }
  }

  const payload: StoredPayload = { ...normalizeStore(storeData) };
  if (keychainBlocked) {
    const entries = Object.entries(fallbackKeys).filter(([, v]) => v?.trim());
    if (entries.length > 0) {
      payload.apiKeys = Object.fromEntries(entries) as Partial<Record<ProviderId, string>>;
    }
  }
  // Preserve deliberate clears so a keychain-blocked -> available retry can't
  // resurrect a key the user explicitly removed (the loop above already skips
  // re-importing any provider present in `cleared`).
  if (Object.keys(cleared).length > 0) {
    payload.apiKeysCleared = { ...cleared };
  }
  if (!keychainBlocked) {
    payload.apiKeysMigratedFromKeychain = true;
  }

  await s.set(SETTINGS_KEY, payload);
  await s.save();

  if (keychainBlocked) {
    migrationPromise = null;
  }
  });
}

/**
 * When Keychain works but legacy plaintext mirrors remain on disk (e.g. after an
 * unsigned rebuild or a denied prompt), copy them back into Keychain and drop the mirror.
 */
async function reconcilePlaintextKeyMirrors(): Promise<void> {
  const s = await getStore();
  const raw = await s.get<RawStored>(SETTINGS_KEY);
  if (!raw) return;

  const diskKeys: Partial<Record<ProviderId, string>> = { ...(raw.apiKeys ?? {}) };
  if (raw.apiKey?.trim()) {
    const legacyProvider = isLlmStoreV2(raw) ? raw.activeProvider : DEFAULT_SETTINGS.provider;
    if (!diskKeys[legacyProvider]?.trim()) {
      diskKeys[legacyProvider] = raw.apiKey.trim();
    }
  }

  const entries = Object.entries(diskKeys).filter(([, v]) => v?.trim()) as [
    ProviderId,
    string,
  ][];
  if (entries.length === 0) return;

  for (const [provider, key] of entries) {
    if (provider === "ollama") continue;

    const rawNow = await s.get<RawStored>(SETTINGS_KEY);
    const storeData =
      rawNow && isLlmStoreV2(rawNow)
        ? normalizeStore(rawNow)
        : isLlmStoreV2(raw)
          ? normalizeStore(raw)
          : migrateV1ToV2(raw);

    let keychainKey = "";
    try {
      keychainKey = (await keychainGet(provider)).trim();
    } catch {
      continue;
    }
    if (keychainKey && keychainKey !== key.trim()) continue;

    if (!keychainKey) {
      const keychainOk = await persistApiKey(provider, key);
      if (!keychainOk) continue;
      try {
        if ((await keychainGet(provider)).trim() !== key.trim()) continue;
      } catch {
        continue;
      }
    }
    await writeStoreV2(storeData, { provider, apiKey: key, keychainOk: true });
  }
}

function ensureApiKeysMigrated(): Promise<void> {
  if (!migrationPromise) {
    migrationPromise = migrateKeychainApiKeysIfNeeded()
      .then(() => reconcilePlaintextKeyMirrors())
      .catch((e) => {
        // A transient store I/O failure must not poison the memoized promise for
        // the rest of the session — reset so the next read retries migration.
        migrationPromise = null;
        throw e;
      });
  }
  return migrationPromise;
}

/**
 * Load API key for a provider from the local settings.json mirror only.
 * Keychain is consulted once during {@link ensureApiKeysMigrated}, not on every read.
 */
async function loadApiKey(provider: ProviderId): Promise<string> {
  await ensureApiKeysMigrated();
  const s = await getStore();
  const raw = await s.get<RawStored>(SETTINGS_KEY);
  if (raw?.apiKeysCleared?.[provider]) return "";
  if (provider === "ollama") return "ollama";
  const fromMirror = (await getFallbackKey(provider)).trim();
  if (fromMirror) return fromMirror;
  try {
    const fromKeychain = (await keychainGet(provider)).trim();
    if (fromKeychain) return fromKeychain;
  } catch {
    /* fall through */
  }
  return "";
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

async function readStoreV2Raw(): Promise<LlmStoreV2> {
  const s = await getStore();
  const raw = await s.get<RawStored>(SETTINGS_KEY);

  if (isLlmStoreV2(raw)) {
    return normalizeStore(raw);
  }

  const migrated = migrateV1ToV2(raw);
  const legacyKey = raw?.apiKey?.trim() ?? "";
  if (legacyKey) {
    const keychainOk = await persistApiKey(migrated.activeProvider, legacyKey);
    await writeStoreV2(migrated, {
      provider: migrated.activeProvider,
      apiKey: legacyKey,
      keychainOk,
    });
  } else {
    await writeStoreV2(migrated);
  }
  return migrated;
}

async function readStoreV2(): Promise<LlmStoreV2> {
  await ensureApiKeysMigrated();
  return readStoreV2Raw();
}

async function hasStoredApiKey(provider: ProviderId): Promise<boolean> {
  if (provider === "ollama") return true;
  await ensureApiKeysMigrated();
  if ((await getFallbackKey(provider)).trim().length > 0) return true;
  const s = await getStore();
  const raw = await s.get<RawStored>(SETTINGS_KEY);
  if (raw?.apiKeysCleared?.[provider]) return false;
  try {
    return (await keychainGet(provider)).trim().length > 0;
  } catch {
    return false;
  }
}

async function hasPlaintextKeysOnDisk(): Promise<boolean> {
  await ensureApiKeysMigrated();
  const s = await getStore();
  const raw = await s.get<RawStored>(SETTINGS_KEY);
  if (!raw?.apiKeys) return false;
  return Object.values(raw.apiKeys).some((v) => v?.trim());
}

function metaFromProfile(
  provider: ProviderId,
  profile: ProviderProfile,
  hasStoredKey: boolean,
  plaintextKeysOnDisk: boolean,
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
    plaintextKeysOnDisk,
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
  const plaintextKeysOnDisk = await hasPlaintextKeysOnDisk();
  return metaFromProfile(provider, profile, hasStoredKey, plaintextKeysOnDisk);
}

/** Vision indexing model (separate from agent model when configured). */
export async function loadVisionSettings(): Promise<LlmSettings> {
  const storeData = await readStoreV2();
  const provider = storeData.activeProvider;
  const profile = getProfileFromStore(storeData, provider);
  const apiKey = await loadApiKey(provider);
  let model =
    profile.visionModel?.trim() ||
    (provider !== "custom"
      ? defaultVisionModel(provider as Exclude<ProviderId, "custom">)
      : "");
  // Replace only when the stored id is a known non-vision model and matches the agent model
  // (legacy shared slot). Explicit user scan models are preserved even on DeepSeek.
  const userScan = profile.visionModel?.trim();
  if (
    provider !== "custom" &&
    model &&
    isKnownNonVisionModel(model) &&
    (!userScan || userScan === profile.model)
  ) {
    model =
      defaultVisionModel(provider as Exclude<ProviderId, "custom">) || profile.model;
  }
  return profileToSettings(
    provider,
    {
      ...profile,
      model: provider === "custom" ? model : model || profile.model,
    },
    apiKey,
  );
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

  let resolvedKey = apiKey;
  if (resolvedKey !== undefined && resolvedKey.trim()) {
    const keychainOk = await persistApiKey(provider, resolvedKey);
    await writeStoreV2(storeData, { provider, apiKey: resolvedKey, keychainOk });
  } else if (resolvedKey === undefined) {
    // No key change requested — preserve existing local mirror.
    await writeStoreV2(storeData);
    resolvedKey = await loadApiKey(provider);
  } else {
    // Explicit clear of the key.
    try {
      await deleteApiKey(provider);
    } catch {
      /* keychain may be unavailable */
    }
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
  const storedKey = await loadApiKey(settings.provider);
  const draftKey = settings.apiKey.trim();

  let keyArg: string | undefined;
  if (!draftKey) {
    keyArg = storedKey ? "" : undefined;
  } else if (draftKey !== storedKey) {
    keyArg = draftKey;
  } else {
    keyArg = undefined;
  }

  await saveProviderProfile(settings.provider, profile, keyArg);
}
