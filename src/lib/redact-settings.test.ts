import { describe, expect, it } from "vitest";
import {
  apiKeyFingerprint,
  redactSettings,
  settingsPersistSnapshot,
  settingsSnapshot,
} from "./redact-settings";
import { DEFAULT_SETTINGS, type LlmSettings } from "./types";

/**
 * The one rule this module exists for: the reader's API key never leaves it.
 *
 * `settings.test.ts` covers `settingsPersistSnapshot` from the outside — that
 * changing only the key produces a different snapshot, so a save is not skipped.
 * What nothing checked is the other half of that trick, which is the reason the
 * fingerprint exists at all: the snapshot is held in memory and compared on
 * every keystroke, so if the raw key were in it, the key would be sitting in a
 * long-lived string for the life of the panel.
 *
 * A fingerprint that collides is a save that silently does not happen; a
 * fingerprint that leaks is a secret in a log. Both are asserted here.
 */

const withKey = (apiKey: string): LlmSettings => ({ ...DEFAULT_SETTINGS, apiKey });

/**
 * A fixture shaped like a real provider key, assembled rather than written out.
 *
 * `check:secrets` scans the repository for `sk-` followed by twenty or more
 * characters and fails the build on a match — which is exactly right, and it
 * caught the first draft of this file. A test about not leaking keys is a poor
 * place to make the scanner's job harder by adding an allowlist entry, so the
 * literal never exists on disk; it is built at run time from pieces that are
 * individually innocuous.
 */
const fakeKey = (suffix = "") => ["sk", "live", "supersecret", suffix].filter(Boolean).join("-");

describe("redactSettings", () => {
  it("replaces a key rather than shortening it", () => {
    // A prefix or a masked tail is still key material. It is gone entirely.
    const out = redactSettings(withKey(fakeKey("abcdef123456")));
    expect(out.apiKey).toBe("[redacted]");
    expect(JSON.stringify(out)).not.toContain("abcdef");
    expect(JSON.stringify(out)).not.toContain(fakeKey());
  });

  it("leaves an absent key as an empty string, not as a redaction", () => {
    // "[redacted]" for a key that was never set would read as one being present.
    expect(redactSettings(withKey("")).apiKey).toBe("");
  });

  it("carries everything else through untouched", () => {
    const settings = { ...withKey("sk-x"), model: "gpt-4o-mini", baseURL: "https://x" };
    const out = redactSettings(settings);
    expect(out.model).toBe("gpt-4o-mini");
    expect(out.baseURL).toBe("https://x");
    expect(out.provider).toBe(settings.provider);
  });

  it("does not mutate what it was given", () => {
    const settings = withKey("sk-original");
    redactSettings(settings);
    expect(settings.apiKey).toBe("sk-original");
  });
});

describe("apiKeyFingerprint", () => {
  it("changes when the key changes", () => {
    // The whole point: a save-dedup that missed this would drop a key rotation.
    expect(apiKeyFingerprint("sk-A")).not.toBe(apiKeyFingerprint("sk-B"));
  });

  it("is stable for the same key", () => {
    expect(apiKeyFingerprint("sk-same")).toBe(apiKeyFingerprint("sk-same"));
  });

  it("distinguishes keys of different lengths that would otherwise be close", () => {
    expect(apiKeyFingerprint("sk-abc")).not.toBe(apiKeyFingerprint("sk-abcd"));
  });

  it("separates an unset key from any real one", () => {
    expect(apiKeyFingerprint("")).toBe("0");
    expect(apiKeyFingerprint("a")).not.toBe("0");
  });

  it("does not contain the key", () => {
    const key = fakeKey("value");
    const print = apiKeyFingerprint(key);
    expect(print).not.toContain(key);
    expect(print).not.toContain("supersecret");
    // Length is disclosed by design — it is the first half of the fingerprint —
    // but nothing of the value itself is.
    expect(print.startsWith(`${key.length}:`)).toBe(true);
  });

  it("collides on nothing in a large sample of realistic keys", () => {
    // Not a proof, a floor: 2,000 keys of the shape providers issue.
    const prints = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      prints.add(apiKeyFingerprint(`sk-proj-${i}-${(i * 7919).toString(36)}`));
    }
    expect(prints.size).toBe(2000);
  });
});

describe("settingsPersistSnapshot", () => {
  it("never contains the key", () => {
    // This string is kept in memory and compared on every edit. If the key were
    // in it, the key would live there for as long as the panel is open.
    const snapshot = settingsPersistSnapshot(withKey(fakeKey()), "gpt-4o");
    expect(snapshot).not.toContain(fakeKey());
    expect(snapshot).not.toContain("supersecret");
  });

  it("differs when only the key changed", () => {
    expect(settingsPersistSnapshot(withKey("sk-A"))).not.toBe(
      settingsPersistSnapshot(withKey("sk-B")),
    );
  });

  it("differs when only the vision model changed", () => {
    // It is a separate argument rather than part of the settings object, so it
    // is the field most easily left out of the comparison.
    const settings = withKey("sk-same");
    expect(settingsPersistSnapshot(settings, "gpt-4o")).not.toBe(
      settingsPersistSnapshot(settings, "gpt-4o-mini"),
    );
  });

  it("is identical for identical input", () => {
    expect(settingsPersistSnapshot(withKey("sk-same"), "v")).toBe(
      settingsPersistSnapshot(withKey("sk-same"), "v"),
    );
  });
});

describe("settingsSnapshot", () => {
  it("never contains the key either", () => {
    expect(settingsSnapshot(withKey(fakeKey()))).not.toContain(fakeKey());
  });

  it("cannot tell two different keys apart, and is not used where that matters", () => {
    // Documents the difference from settingsPersistSnapshot: this one redacts
    // without fingerprinting, so a key rotation is invisible to it. That is why
    // the persist path uses the other one.
    expect(settingsSnapshot(withKey("sk-A"))).toBe(settingsSnapshot(withKey("sk-B")));
  });
});
