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

  it("registers only the given file, never its parent directory", async () => {
    const { allowPathPersisted } = await import("./allowed-paths");
    await allowPathPersisted("/Users/me/docs/report.pdf");

    expect(invokeMock).toHaveBeenCalledWith("register_allowed_path", {
      path: "/Users/me/docs/report.pdf",
    });
    // The parent directory must NOT be authorized on open.
    expect(invokeMock).not.toHaveBeenCalledWith("register_allowed_path", {
      path: "/Users/me/docs",
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("throws when the file path cannot be registered", async () => {
    invokeMock.mockRejectedValueOnce(new Error("Invalid path"));
    const { allowPathPersisted } = await import("./allowed-paths");

    await expect(allowPathPersisted("/missing/report.pdf")).rejects.toThrow(
      "path not authorized",
    );
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("does not drop entries when two allow actions run concurrently", async () => {
    // Without the store lock, the two allowPathPersisted calls read the same
    // initial array and last-write-wins would drop one file's entries.
    const { allowPathPersisted } = await import("./allowed-paths");
    await Promise.all([
      allowPathPersisted("/Users/me/a/one.pdf"),
      allowPathPersisted("/Users/me/b/two.pdf"),
    ]);

    const storeMod = await import("@tauri-apps/plugin-store");
    const store = new storeMod.LazyStore("");
    const persisted = (await store.get("paths")) as string[];

    expect(persisted).toContain("/Users/me/a/one.pdf");
    expect(persisted).toContain("/Users/me/b/two.pdf");
    // Parent directories are no longer auto-registered on open.
    expect(persisted).not.toContain("/Users/me/a");
    expect(persisted).not.toContain("/Users/me/b");
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
