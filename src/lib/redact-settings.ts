import type { LlmSettings } from "./types";

/** Strip secrets before logging or snapshot comparison. */
export function redactSettings(settings: LlmSettings): LlmSettings {
  return {
    ...settings,
    apiKey: settings.apiKey ? "[redacted]" : "",
  };
}

export function settingsPersistSnapshot(settings: LlmSettings, visionModel = ""): string {
  return JSON.stringify({ ...redactSettings(settings), visionModel });
}

export function settingsSnapshot(settings: LlmSettings): string {
  return JSON.stringify(redactSettings(settings));
}
