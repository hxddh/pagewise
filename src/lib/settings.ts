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
  type LlmStoreV3,
  type ProviderId,
  type ProviderProfile,
} from "./types";
import { isKnownNonVisionModel, isThinkingCapableModel, isToolModel, isVisionModel } from "./model-capabilities";

const STORE_PATH = "settings.json";
const SETTINGS_KEY = "llm";

/**
 * Everything a previous version may have written, read exactly once.
 *
 * 18.0 rewrote the payload to v3 and deleted the ladder of migrations that used
 * to run on every read: v1's flat object, v2's `profiles`, the legacy single
 * `apiKey` slot, `apiKeysCleared` tombstones and the keychain-import flag. What
 * replaced them is one function (`migrateToV3`) that runs when the payload on
 * disk is not v3, and nothing after it. Only v3 is ever written.
 */
interface LegacyPayload {
  version?: number;
  activeProvider?: ProviderId;
  profiles?: Partial<Record<ProviderId, ProviderProfile>>;
  /** v1: one flat settings object. */
  provider?: ProviderId;
  model?: string;
  baseURL?: string;
  thinkingEnabled?: boolean;
  webSearch?: boolean;
  connectionVerified?: boolean;
  /** v1/v2 key carriers. */
  apiKey?: string;
  apiKeys?: Partial<Record<ProviderId, string>>;
  apiKeysCleared?: Partial<Record<ProviderId, true>>;
  apiKeysMigratedFromKeychain?: boolean;
  /** v3. */
  keys?: Partial<Record<ProviderId, string | null>>;
}

type StoredPayload = LegacyPayload;

type KeychainGet = (provider: ProviderId) => Promise<string>;
type KeychainSet = (provider: ProviderId, key: string) => Promise<void>;

let store: LazyStore | null = null;

/**
 * Session-level record of a keychain we couldn't reach (denied/blocked prompt).
 * Once set, no code path consults the keychain again this session — a single
 * background index sweep otherwise fires hundreds of keychain accesses
 * (loadVisionSettings per page × concurrency). Cleared when the reader opens
 * Settings, which is the moment to re-ask the OS.
 */
let keychainBlockedThisSession = false;
export function resetKeychainBlockedFlag(): void {
  keychainBlockedThisSession = false;
  forgetSessionKey();
}

/**
 * API keys resolved this session, so the OS keychain is asked once per key.
 *
 * On a machine where the keychain works there is deliberately no plaintext
 * mirror on disk, so every read would otherwise go to the OS — and settings are
 * resolved on every vision-indexed page. On macOS, where an unsigned build's
 * changed signature makes the system re-ask for the login keychain password,
 * that is one prompt per page. Cleared whenever a key is written or removed,
 * which is the only way it changes from inside the app.
 */
const sessionKeys = new Map<ProviderId, string>();
function forgetSessionKey(provider?: ProviderId): void {
  if (provider === undefined) sessionKeys.clear();
  else sessionKeys.delete(provider);
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
  keychainBlockedThisSession = false;
  forgetSessionKey();
  keychainGet = opts?.keychain?.get ?? getApiKey;
  keychainSet = opts?.keychain?.set ?? setApiKey;
}

/** Test helper: inspect the raw persisted payload (including plaintext mirrors). */
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

/** Serializes every write so two saves can't interleave their set/save cycles. */
let writeLock: Promise<unknown> = Promise.resolve();
function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = writeLock.then(fn, fn);
  writeLock = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
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

/**
 * Coerce a stored profile into something the app can use.
 *
 * This is the only place legacy model ids are rewritten: `deepseek-chat` and
 * `deepseek-reasoner` map to their current equivalents, a DeepSeek `/v1` base
 * URL is dropped (the endpoint does not use it), and OpenRouter's retired
 * `deepseek/deepseek-v4-*` routes fall back to a tool-capable model. A rewrite
 * clears `connectionVerified`, because a model that has never been tested is
 * exactly what that flag would otherwise claim.
 */
function normalizeProfile(provider: ProviderId, profile: ProviderProfile): ProviderProfile {
  const fallback = defaultProviderProfile(provider);
  let model = typeof profile.model === "string" && profile.model ? profile.model : fallback.model;
  let thinking = !!profile.thinkingEnabled;
  let verified = !!profile.connectionVerified;
  let baseURL = profile.baseURL;
  let visionModel = profile.visionModel?.trim() ?? "";

  const legacy = LEGACY_MODEL_MAP[model];
  if (legacy) {
    model = legacy.model;
    thinking = legacy.thinkingEnabled;
    verified = false;
  }
  if (provider === "deepseek" && model.startsWith("deepseek-") && !model.includes("v4")) {
    model = "deepseek-v4-flash";
    verified = false;
  }
  if (
    provider === "deepseek" &&
    (baseURL === "https://api.deepseek.com/v1" || baseURL === "https://api.deepseek.com/v1/")
  ) {
    baseURL = undefined;
    verified = false;
  }
  if (
    provider === "openrouter" &&
    (model === "deepseek/deepseek-v4-flash" || model === "deepseek/deepseek-v4-pro")
  ) {
    model = "openai/gpt-4o-mini";
    verified = false;
  }

  if (provider !== "custom") {
    const visionPresets = visionPresetModels(provider);
    if (!visionModel) {
      visionModel =
        isVisionModel(provider, model) && !isToolModel(provider, model)
          ? model
          : defaultVisionModel(provider);
    } else if (
      visionPresets.length > 0 &&
      !visionPresets.includes(visionModel) &&
      visionModel === model &&
      isToolModel(provider, model)
    ) {
      visionModel = defaultVisionModel(provider);
    } else if (visionModel === "google/gemma-4-31b-it:free" && visionPresets.length > 0) {
      visionModel = defaultVisionModel(provider);
    }
    if (thinking && !isThinkingCapableModel(provider, model)) thinking = false;
  }

  return {
    model,
    visionModel: visionModel || undefined,
    baseURL,
    thinkingEnabled: thinking,
    webSearch: profile.webSearch,
    connectionVerified: verified,
  };
}

function isLlmStoreV3(raw: StoredPayload | null | undefined): raw is LlmStoreV3 & StoredPayload {
  return (
    !!raw &&
    typeof raw === "object" &&
    raw.version === 3 &&
    ALL_PROVIDER_IDS.includes(raw.activeProvider as ProviderId) &&
    !!raw.profiles &&
    typeof raw.profiles === "object" &&
    !Array.isArray(raw.profiles)
  );
}

/**
 * Fold anything older than v3 into v3, consulting the keychain at most once.
 *
 * Three jobs, in order:
 *
 *  1. Profiles. v2 has one per provider; v1 has a single flat object. Each is
 *     normalized (see `normalizeProfile`), and the active provider always ends
 *     up with a profile so later reads never have to invent one.
 *  2. Keys already on disk. v3's `keys` map wins; then v2's per-provider
 *     mirrors; then v1's single slot; and `apiKeysCleared` becomes a `null`,
 *     which is v3's way of saying "the reader removed this one — do not ask the
 *     keychain again".
 *  3. The keychain. A mirror is a fallback, not a home: where the keychain is
 *     reachable, a mirrored key is moved into it and taken off the disk. Where
 *     the keychain refuses, keys found this session are cached in memory and
 *     the mirror is kept — that is the machine this mirror exists for.
 */
async function migrateToV3(raw: StoredPayload | null): Promise<LlmStoreV3> {
  const profiles: Partial<Record<ProviderId, ProviderProfile>> = {};
  if (raw?.profiles && typeof raw.profiles === "object" && !Array.isArray(raw.profiles)) {
    for (const id of ALL_PROVIDER_IDS) {
      const existing = raw.profiles[id];
      if (existing) profiles[id] = normalizeProfile(id, existing);
    }
  } else {
    const provider = ALL_PROVIDER_IDS.includes(raw?.provider as ProviderId)
      ? (raw?.provider as ProviderId)
      : DEFAULT_SETTINGS.provider;
    profiles[provider] = normalizeProfile(provider, {
      model: typeof raw?.model === "string" ? raw.model : "",
      baseURL: raw?.baseURL,
      thinkingEnabled: raw?.thinkingEnabled,
      webSearch: raw?.webSearch,
      connectionVerified: false,
    });
  }
  const activeProvider = ALL_PROVIDER_IDS.includes((raw?.activeProvider ?? raw?.provider) as ProviderId)
    ? ((raw?.activeProvider ?? raw?.provider) as ProviderId)
    : DEFAULT_SETTINGS.provider;
  if (!profiles[activeProvider]) profiles[activeProvider] = defaultProviderProfile(activeProvider);

  const keys: Partial<Record<ProviderId, string | null>> = { ...(raw?.keys ?? {}) };
  for (const [provider, value] of Object.entries(raw?.apiKeys ?? {})) {
    if (keys[provider as ProviderId] === undefined && typeof value === "string" && value.trim()) {
      keys[provider as ProviderId] = value.trim();
    }
  }
  for (const [provider, cleared] of Object.entries(raw?.apiKeysCleared ?? {})) {
    if (keys[provider as ProviderId] === undefined && cleared) keys[provider as ProviderId] = null;
  }
  const legacyKey = raw?.apiKey?.trim();
  if (legacyKey && keys[activeProvider] === undefined) keys[activeProvider] = legacyKey;

  // Mirrors → keychain, then off the disk.
  for (const provider of ALL_PROVIDER_IDS) {
    const mirror = keys[provider];
    if (typeof mirror !== "string" || !mirror.trim()) continue;
    try {
      const existing = (await keychainGet(provider)).trim();
      if (existing && existing !== mirror) continue; // a different key: leave the mirror alone
      if (!existing) {
        await keychainSet(provider, mirror);
        if ((await keychainGet(provider)).trim() !== mirror) continue;
      }
      delete keys[provider];
      sessionKeys.set(provider, mirror);
    } catch {
      keychainBlockedThisSession = true;
      break;
    }
  }

  // Providers with no answer yet: ask the keychain once, cache in memory only.
  for (const provider of ALL_PROVIDER_IDS) {
    if (provider === "ollama" || keys[provider] !== undefined || sessionKeys.has(provider)) continue;
    if (keychainBlockedThisSession) break;
    try {
      const found = (await keychainGet(provider)).trim();
      if (found) sessionKeys.set(provider, found);
    } catch {
      keychainBlockedThisSession = true;
      break;
    }
  }

  const next: LlmStoreV3 = { version: 3, activeProvider, profiles };
  const entries = Object.entries(keys).filter(
    ([, value]) => value === null || (typeof value === "string" && value.trim().length > 0),
  );
  if (entries.length > 0) next.keys = Object.fromEntries(entries);
  await writePayload(next);
  return next;
}

/**
 * Persist a v3 payload. `keyUpdate` is the only way the key map changes:
 * a non-empty key the keychain accepted is not written to disk, one it refused
 * has to be (or the next launch loses it), and an empty key is a tombstone —
 * `null`, which stops the keychain from ever being asked for that provider again.
 */
async function writePayload(
  storeData: LlmStoreV3,
  keyUpdate?: { provider: ProviderId; apiKey: string; keychainOk?: boolean },
): Promise<void> {
  return withStoreLock(async () => {
    const s = await getStore();
    const prior = await s.get<StoredPayload>(SETTINGS_KEY);
    // The payload being written wins: it carries the migration's tombstones and
    // mirrors. Anything only the prior read knows about is kept as a floor.
    const keys: Partial<Record<ProviderId, string | null>> = {
      ...(prior?.keys ?? {}),
      ...(storeData.keys ?? {}),
    };

    if (keyUpdate) {
      if (keyUpdate.apiKey.trim()) {
        if (keyUpdate.keychainOk === false) keys[keyUpdate.provider] = keyUpdate.apiKey.trim();
        else delete keys[keyUpdate.provider];
      } else {
        keys[keyUpdate.provider] = null;
      }
    }

    const payload: LlmStoreV3 = {
      version: 3,
      activeProvider: storeData.activeProvider,
      profiles: storeData.profiles,
    };
    const entries = Object.entries(keys).filter(
      ([, value]) => value === null || (typeof value === "string" && value.trim().length > 0),
    );
    if (entries.length > 0) payload.keys = Object.fromEntries(entries);

    await s.set(SETTINGS_KEY, payload);
    await s.save();
  });
}

async function readPayload(): Promise<LlmStoreV3> {
  const s = await getStore();
  const raw = await s.get<StoredPayload>(SETTINGS_KEY);
  if (isLlmStoreV3(raw)) return raw;
  return migrateToV3(raw ?? null);
}

/** Keys that live in plaintext on disk (keychain unavailable). */
async function plaintextMirrors(): Promise<Partial<Record<ProviderId, string>>> {
  const payload = await readPayload();
  const out: Partial<Record<ProviderId, string>> = {};
  for (const [provider, value] of Object.entries(payload.keys ?? {})) {
    if (typeof value === "string" && value.trim()) out[provider as ProviderId] = value.trim();
  }
  return out;
}

async function persistApiKey(provider: ProviderId, apiKey: string): Promise<boolean> {
  forgetSessionKey(provider);
  try {
    await keychainSet(provider, apiKey);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load API key for a provider: session cache, then the disk mirror, then the
 * keychain (once per key per session).
 */
async function loadApiKey(provider: ProviderId): Promise<string> {
  const cached = sessionKeys.get(provider);
  if (cached !== undefined) return cached;
  const payload = await readPayload();
  if (provider === "ollama") return "ollama";
  const mirror = payload.keys?.[provider];
  if (typeof mirror === "string" && mirror.trim()) {
    sessionKeys.set(provider, mirror.trim());
    return mirror.trim();
  }
  if (mirror === null) return ""; // explicitly cleared — the keychain is not asked
  if (keychainBlockedThisSession) return "";
  try {
    const fromKeychain = (await keychainGet(provider)).trim();
    if (fromKeychain) {
      sessionKeys.set(provider, fromKeychain);
      return fromKeychain;
    }
  } catch {
    keychainBlockedThisSession = true;
  }
  return "";
}

async function hasStoredApiKey(provider: ProviderId): Promise<boolean> {
  if (provider === "ollama") return true;
  const cached = sessionKeys.get(provider);
  if (cached !== undefined) return cached.trim().length > 0;
  const payload = await readPayload();
  const mirror = payload.keys?.[provider];
  if (typeof mirror === "string") return mirror.trim().length > 0;
  if (mirror === null) return false;
  return (await loadApiKey(provider)).trim().length > 0;
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
    webSearch: profile.webSearch,
    connectionVerified: profile.connectionVerified,
    apiKey,
  };
}

function settingsToProfile(settings: LlmSettings, visionModel?: string): ProviderProfile {
  return {
    model: settings.model,
    visionModel,
    baseURL: settings.baseURL,
    thinkingEnabled: settings.thinkingEnabled,
    webSearch: settings.webSearch,
    connectionVerified: settings.connectionVerified,
  };
}

/** Settings metadata without reading the OS keychain (safe at app startup). */
export type LlmSettingsMeta = Omit<LlmSettings, "apiKey"> & {
  hasStoredKey: boolean;
  visionModel: string;
  /** True when API keys are mirrored in plaintext on disk (keychain unavailable). */
  plaintextKeysOnDisk: boolean;
};

function profileFor(payload: LlmStoreV3, provider: ProviderId): ProviderProfile {
  return payload.profiles[provider] ?? defaultProviderProfile(provider);
}

export async function loadLlmStore(): Promise<LlmStoreV3> {
  return readPayload();
}

/** Active provider metadata without touching the OS keychain. */
export async function loadSettingsMeta(): Promise<LlmSettingsMeta> {
  const payload = await readPayload();
  const provider = payload.activeProvider;
  const profile = profileFor(payload, provider);
  const visionModel =
    profile.visionModel?.trim() ||
    (provider !== "custom"
      ? defaultVisionModel(provider as Exclude<ProviderId, "custom">)
      : "");
  const mirrors = await plaintextMirrors();
  return {
    provider,
    model: profile.model,
    baseURL: profile.baseURL,
    thinkingEnabled: profile.thinkingEnabled,
    connectionVerified: profile.connectionVerified,
    visionModel,
    hasStoredKey: await hasStoredApiKey(provider),
    plaintextKeysOnDisk: Object.keys(mirrors).length > 0,
  };
}

/** Vision indexing model (separate from agent model when configured). */
export async function loadVisionSettings(): Promise<LlmSettings> {
  const payload = await readPayload();
  const provider = payload.activeProvider;
  const profile = profileFor(payload, provider);
  const apiKey = await loadApiKey(provider);
  let model =
    profile.visionModel?.trim() ||
    (provider !== "custom"
      ? defaultVisionModel(provider as Exclude<ProviderId, "custom">)
      : "");
  // Replace only when the stored id is a known non-vision model and matches the
  // agent model (the legacy shared slot). An explicit scan model is preserved.
  const userScan = profile.visionModel?.trim();
  if (
    provider !== "custom" &&
    model &&
    isKnownNonVisionModel(model) &&
    (!userScan || userScan === profile.model)
  ) {
    model = defaultVisionModel(provider as Exclude<ProviderId, "custom">) || profile.model;
  }
  return profileToSettings(
    provider,
    { ...profile, model: provider === "custom" ? model : model || profile.model },
    apiKey,
  );
}

export async function loadProviderSettings(provider: ProviderId): Promise<LlmSettings> {
  const payload = await readPayload();
  return profileToSettings(provider, profileFor(payload, provider), await loadApiKey(provider));
}

export async function loadApiKeyForProvider(provider: ProviderId): Promise<string> {
  return loadApiKey(provider);
}

/** Active provider + profile — used by the agent and connection status. */
export async function loadSettings(): Promise<LlmSettings> {
  const payload = await readPayload();
  return loadProviderSettings(payload.activeProvider);
}

export async function saveProviderProfile(
  provider: ProviderId,
  patch: Partial<ProviderProfile>,
  apiKey?: string,
): Promise<LlmSettings> {
  const payload = await readPayload();
  const nextProfile = normalizeProfile(provider, { ...profileFor(payload, provider), ...patch });
  payload.profiles[provider] = nextProfile;

  let resolvedKey = apiKey;
  if (resolvedKey !== undefined && resolvedKey.trim()) {
    const keychainOk = await persistApiKey(provider, resolvedKey);
    await writePayload(payload, { provider, apiKey: resolvedKey, keychainOk });
  } else if (resolvedKey === undefined) {
    await writePayload(payload);
    resolvedKey = await loadApiKey(provider);
  } else {
    forgetSessionKey(provider);
    try {
      await deleteApiKey(provider);
    } catch {
      /* keychain may be unavailable */
    }
    await writePayload(payload, { provider, apiKey: "" });
    resolvedKey = "";
  }

  return profileToSettings(provider, nextProfile, resolvedKey ?? "");
}

export async function setActiveProvider(provider: ProviderId): Promise<LlmSettings> {
  const payload = await readPayload();
  if (!payload.profiles[provider]) {
    payload.profiles[provider] = defaultProviderProfile(provider);
  }
  payload.activeProvider = provider;
  await writePayload(payload);
  return loadProviderSettings(provider);
}

/** Saves the profile of `settings.provider`; the active provider is unchanged. */
export async function saveSettings(settings: LlmSettings, visionModel?: string): Promise<void> {
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

  await saveProviderProfile(settings.provider, settingsToProfile(settings, visionModel), keyArg);
}
