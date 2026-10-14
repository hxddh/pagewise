#!/usr/bin/env node
/**
 * Verify the built macOS .app's Info.plist matches VERSION (release CI only).
 *
 * The check reads a plist with `defaults`, which exists only on macOS, so on
 * the other platforms it exits quietly rather than failing a build it was never
 * written for. Those bundles carry the version in their filenames, which the
 * release workflow checks instead.
 */
import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.log(`Skipping bundle version check on ${process.platform} (macOS only).`);
  process.exit(0);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const expected = readFileSync(join(root, "VERSION"), "utf8").trim();

/*
 * Both possible homes for the .app. A plain `tauri build` writes under
 * `target/release`; the universal macOS build (`--target
 * universal-apple-darwin`) writes under `target/<triple>/release`. The check is
 * the same either way — which bundle exists is the build's business, not the
 * reader's.
 */
const candidates = [
  join(root, "src-tauri/target/release/bundle/macos"),
  join(root, "src-tauri/target/universal-apple-darwin/release/bundle/macos"),
];

const bundleDir = candidates.find((dir) => {
  try {
    return readdirSync(dir).some((name) => name.endsWith(".app"));
  } catch {
    return false;
  }
});

if (!bundleDir) {
  console.error(`No .app bundle found in any of:\n  ${candidates.join("\n  ")}`);
  process.exit(1);
}

const appName = readdirSync(bundleDir).find((name) => name.endsWith(".app"));

const plist = join(bundleDir, appName, "Contents", "Info.plist");
const short = execSync(
  `/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "${plist}"`,
  { encoding: "utf8" },
).trim();
const build = execSync(
  `/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "${plist}"`,
  { encoding: "utf8" },
).trim();

if (short !== expected) {
  console.error(
    `CFBundleShortVersionString mismatch: expected ${expected}, got ${short}`,
  );
  process.exit(1);
}

if (build !== expected) {
  console.error(`CFBundleVersion mismatch: expected ${expected}, got ${build}`);
  process.exit(1);
}

console.log(`Bundle version OK (${short}) at ${join(bundleDir, appName)}`);
