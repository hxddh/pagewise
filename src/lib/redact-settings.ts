import type { LlmSettings } from "./types";

/** Strip secrets before logging or snapshot comparison. */
export function redactSettings(settings: LlmSettings): LlmSettings {
  return {
    ...settings,
    apiKey: settings.apiKey ? "[redacted]" : "",
  };
}

/**
 * Cheap, non-cryptographic fingerprint of a secret. Lets save-dedup detect a
 * CHANGED key value (sk-A -> sk-B) without ever logging or persisting the raw
 * key: two distinct keys are overwhelmingly unlikely to collide (length +
 * FNV-1a 32-bit hash), and the fingerprint is not reversible to the key.
 */
export function apiKeyFingerprint(apiKey: string): string {
  if (!apiKey) return "0";
  let hash = 0x811c9dc5;
  for (let i = 0; i < apiKey.length; i += 1) {
    hash ^= apiKey.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${apiKey.length}:${(hash >>> 0).toString(36)}`;
}

/**
 * Snapshot used ONLY to dedup persistence. Includes a fingerprint of the apiKey
 * (never the raw value) so that changing only the key still produces a distinct
 * snapshot and triggers a real save. Safe to hold in memory.
 */
export function settingsPersistSnapshot(settings: LlmSettings, visionModel = ""): string {
  return JSON.stringify({
    ...redactSettings(settings),
    apiKey: apiKeyFingerprint(settings.apiKey),
    visionModel,
  });
}

export function settingsSnapshot(settings: LlmSettings): string {
  return JSON.stringify(redactSettings(settings));
}
