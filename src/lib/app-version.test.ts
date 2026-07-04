import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(),
}));

vi.mock("./runtime", () => ({
  isTauriRuntime: vi.fn(() => false),
}));

import { getVersion } from "@tauri-apps/api/app";
import { isTauriRuntime } from "./runtime";
import { APP_VERSION_FALLBACK, resolveAppVersion } from "./app-version";

describe("resolveAppVersion", () => {
  afterEach(() => {
    vi.mocked(getVersion).mockReset();
    vi.mocked(isTauriRuntime).mockReturnValue(false);
  });

  it("returns build-time fallback outside Tauri", async () => {
    await expect(resolveAppVersion()).resolves.toBe(APP_VERSION_FALLBACK);
    expect(getVersion).not.toHaveBeenCalled();
  });

  it("returns bundle version inside Tauri", async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    vi.mocked(getVersion).mockResolvedValue("9.9.9");
    await expect(resolveAppVersion()).resolves.toBe("9.9.9");
  });

  it("falls back when getVersion fails", async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    vi.mocked(getVersion).mockRejectedValue(new Error("unavailable"));
    await expect(resolveAppVersion()).resolves.toBe(APP_VERSION_FALLBACK);
  });
});
