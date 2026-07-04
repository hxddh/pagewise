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

  it("reports failed paths on restore and prunes them from storage", async () => {
    const storeMod = await import("@tauri-apps/plugin-store");
    const store = new storeMod.LazyStore("");
    await store.set("paths", ["/gone/report.pdf", "/ok/report.pdf"]);

    invokeMock.mockImplementation((_cmd: string, args: { path: string }) => {
      if (args.path === "/gone/report.pdf") return Promise.reject(new Error("missing"));
      return Promise.resolve(undefined);
    });

    const { restoreAllowedPaths } = await import("./allowed-paths");
    const result = await restoreAllowedPaths(["/ok/report.pdf"]);

    expect(result.failed).toContain("/gone/report.pdf");
    expect(result.restored).toBeGreaterThan(0);

    const remaining = (await store.get("paths")) as string[];
    expect(remaining).not.toContain("/gone/report.pdf");
  });
});
