#!/usr/bin/env node
/**
 * The webview's reach into the app's own store files, asserted instead of
 * described.
 *
 * Until 20.0 the capability file carried `store:default`, and the 20.0 review
 * called it the widest line in that file. The store plugin's `load` command
 * took a *path* from the webview and resolved it with
 * `app.path().resolve(path, BaseDirectory::AppData)`, which is
 * `base_dir_path.push(path)` (`tauri-2.12.3/src/path/mod.rs`) — and
 * `PathBuf::push` replaces the base directory when the argument is absolute.
 * Verified locally with `rustc`:
 *
 *     let mut base = PathBuf::from("/home/user/.local/share/app.pagewise");
 *     base.push("/etc/passwd");            // → /etc/passwd
 *     base.push("../../etc/passwd");       // → /home/user/.local/share/app.pagewise/../../etc/passwd
 *
 * So `store:default` let any script in the webview read and write any JSON file
 * the app could address, and the hand-built Rust allowlist for the *file*
 * commands never saw it. The plugin is gone (`store_io.rs` replaced it, with
 * names validated to one path component under the app data directory), and
 * these assertions are what keeps it gone: the capability, the imports, the
 * plugin registration and the crate, plus the name shape the Rust side accepts.
 *
 * What this cannot assert is a live denial — that a running webview is refused
 * `plugin:store|load`. That needs the Tauri runtime; the suite has no app
 * process. The static diff is the part a test can hold.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function read(path) {
  return readFileSync(join(ROOT, path), "utf8");
}

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(join(ROOT, dir))) {
    const path = join(ROOT, dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "node_modules" || name === "locales") continue;
      sourceFiles(relative(ROOT, path), out);
    } else if (/\.(ts|tsx|mjs|js)$/.test(name)) {
      out.push(relative(ROOT, path));
    }
  }
  return out;
}

describe("the store capability", () => {
  it("grants the webview no store-plugin permission at all", () => {
    const files = readdirSync(join(ROOT, "src-tauri/capabilities")).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const capability = JSON.parse(read(`src-tauri/capabilities/${file}`));
      const granted = capability.permissions.map((p) => (typeof p === "string" ? p : p.identifier));
      expect(granted.filter((p) => p.startsWith("store:"))).toEqual([]);
    }
  });

  it("leaves no source that imports the plugin it replaced", () => {
    const offenders = sourceFiles("src").filter((file) =>
      /@tauri-apps\/plugin-store/.test(read(file)),
    );
    expect(offenders).toEqual([]);
    expect(JSON.parse(read("package.json")).dependencies["@tauri-apps/plugin-store"]).toBeUndefined();
  });

  it("registers no store plugin in the app, and depends on no store crate", () => {
    expect(read("src-tauri/src/lib.rs")).not.toContain("tauri_plugin_store");
    expect(read("src-tauri/Cargo.toml")).not.toMatch(/^\s*tauri-plugin-store\s*=/m);
  });

  it("names every store file the way the Rust side resolves it", () => {
    // `store_io::store_file_name` accepts one path component ending `.json`
    // (plus `finding-bodies/<uuid>.json`) and nothing else; a name that is not
    // one would be refused at runtime, and this is where that shows up instead.
    const names = new Set();
    for (const file of sourceFiles("src")) {
      for (const match of read(file).matchAll(/createAtomicStore\(\s*"([^"]+)"/g)) {
        names.add(match[1]);
      }
      for (const match of read(file).matchAll(/const STORE_PATH = "([^"]+)"/g)) {
        names.add(match[1]);
      }
    }
    expect(names.size).toBeGreaterThanOrEqual(7);
    for (const name of names) {
      expect(name, `${name} must be one .json path component`).toMatch(
        /^[A-Za-z0-9._-]{1,64}\.json$/,
      );
      expect(name).not.toContain("..");
      expect(name.startsWith(".")).toBe(false);
      expect(name.includes("/")).toBe(false);
    }
    // And the one subdirectory is the bodies one, named by uuid.
    const bodies = read("src/lib/atomic-store.ts").match(/BODIES_DIR = "([^"]+)"/)?.[1];
    expect(bodies).toBe("finding-bodies");
    expect(read("src/lib/atomic-store.ts")).toContain("`${BODIES_DIR}/${id}.json`");
  });
});
