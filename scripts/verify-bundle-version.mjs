#!/usr/bin/env node
/**
 * Verify built macOS .app Info.plist matches VERSION (release CI only).
 */
import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const expected = readFileSync(join(root, "VERSION"), "utf8").trim();

const bundleDir = join(root, "src-tauri/target/release/bundle/macos");
let appName;
try {
  appName = readdirSync(bundleDir).find((name) => name.endsWith(".app"));
} catch {
  console.error(`Bundle directory not found: ${bundleDir}`);
  process.exit(1);
}

if (!appName) {
  console.error(`No .app bundle found in ${bundleDir}`);
  process.exit(1);
}

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
