import type { LlmSettings } from "./types";

/** Strip secrets before logging or snapshot comparison. */
export function redactSettings(settings: LlmSettings): LlmSettings {
  return {
    ...settings,
    apiKey: settings.apiKey ? "[redacted]" : "",
  };
}

export function settingsSnapshot(settings: LlmSettings): string {
  return JSON.stringify(redactSettings(settings));
}
