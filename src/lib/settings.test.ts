import { describe, expect, it } from "vitest";
import {
  defaultProviderProfile,
  migrateLlmSettings,
  migrateV1ToV2,
} from "./settings";
import { PROVIDER_PRESETS } from "./types";

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
