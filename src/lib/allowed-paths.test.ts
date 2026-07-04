import { describe, expect, it, vi, beforeEach } from "vitest";

const invokeMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/plugin-store", () => {
  let stored: unknown = null;
  return {
    LazyStore: class {
      async get() {
        return stored;
      }
      async set(_key: string, value: unknown) {
        stored = value;
      }
      async save() {}
    },
  };
});

describe("allowed-paths", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    vi.resetModules();
  });

  it("registers file and parent directory", async () => {
    const { allowPathPersisted } = await import("./allowed-paths");
    await allowPathPersisted("/Users/me/docs/report.pdf");

    expect(invokeMock).toHaveBeenCalledWith("register_allowed_path", {
      path: "/Users/me/docs/report.pdf",
    });
    expect(invokeMock).toHaveBeenCalledWith("register_allowed_path", {
      path: "/Users/me/docs",
    });
  });

  it("throws when the file path cannot be registered", async () => {
    invokeMock.mockRejectedValueOnce(new Error("Invalid path"));
    const { allowPathPersisted } = await import("./allowed-paths");

    await expect(allowPathPersisted("/missing/report.pdf")).rejects.toThrow(
      "path not authorized",
    );
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
