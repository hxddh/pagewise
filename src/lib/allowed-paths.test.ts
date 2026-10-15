import { beforeEach, describe, expect, it, vi } from "vitest";

/** The Rust commands this module calls. */
const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  isPathGranted,
  pickDocument,
  pickSavePath,
  requireGrantedPath,
  ungrantedPaths,
} from "./allowed-paths";

/**
 * The webview asks; it never grants (21.0).
 *
 * `register_allowed_path` took any path the webview named, so the allowlist
 * kept nothing out of reach of a script running there. The module now only
 * opens the dialogs (which grant in Rust) and asks whether a path is granted.
 */
describe("allowed-paths", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("never calls a command that grants a path the webview names", async () => {
    invokeMock.mockResolvedValue(true);
    await requireGrantedPath("/Users/me/docs/report.pdf");
    await ungrantedPaths(["/a.pdf", "/b.pdf"]);
    const commands = invokeMock.mock.calls.map(([cmd]) => cmd);
    expect(commands).not.toContain("register_allowed_path");
    expect(new Set(commands)).toEqual(new Set(["path_granted"]));
  });

  it("refuses a path Rust has not granted", async () => {
    invokeMock.mockResolvedValue(false);
    await expect(requireGrantedPath("/Users/me/.ssh/id_rsa")).rejects.toThrow("path not authorized");
  });

  it("reads a failed check as not granted", async () => {
    invokeMock.mockRejectedValue(new Error("lock poisoned"));
    expect(await isPathGranted("/x.pdf")).toBe(false);
    expect(await isPathGranted("   ")).toBe(false);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("lists the recents that are no longer granted, once each", async () => {
    invokeMock.mockImplementation(async (_cmd: string, args: { path: string }) => args.path !== "/gone.pdf");
    expect(await ungrantedPaths(["/kept.pdf", "/gone.pdf", "/gone.pdf", " "])).toEqual(["/gone.pdf"]);
  });

  it("opens the document dialog in Rust, and resolves null on cancel", async () => {
    invokeMock.mockResolvedValueOnce("/Users/me/docs/report.pdf").mockResolvedValueOnce(null);
    expect(await pickDocument()).toBe("/Users/me/docs/report.pdf");
    expect(await pickDocument()).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("pick_document");
  });

  it("asks Rust for the save path, which grants the folder", async () => {
    invokeMock.mockResolvedValueOnce("/out/notes.md");
    expect(await pickSavePath("notes.md", "Markdown", ["md"])).toBe("/out/notes.md");
    expect(invokeMock).toHaveBeenCalledWith("pick_save_path", {
      defaultName: "notes.md",
      filterName: "Markdown",
      extensions: ["md"],
    });
  });

  it("surfaces the real Rust cause when a dialog fails", async () => {
    invokeMock.mockRejectedValueOnce("Invalid path: No such file");
    await expect(pickDocument()).rejects.toThrow("No such file");
  });
});
