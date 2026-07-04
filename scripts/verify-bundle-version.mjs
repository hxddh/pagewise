#!/usr/bin/env node
/**
 * Verify built macOS .app Info.plist matches VERSION (release CI only).
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const expected = readFileSync(join(root, "VERSION"), "utf8").trim();

const appGlob = "src-tauri/target/release/bundle/macos/*.app";
const appPath = execSync(`ls -d ${appGlob}`, {
  cwd: root,
  encoding: "utf8",
})
  .trim()
  .split("\n")[0];

if (!appPath) {
  console.error(`No .app bundle found at ${appGlob}`);
  process.exit(1);
}

const plist = join(root, appPath, "Contents", "Info.plist");
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

console.log(`Bundle version OK (${short}) at ${appPath}`);
