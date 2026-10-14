#!/usr/bin/env node
/**
 * The macOS entitlements must be ones an ad-hoc signature can carry.
 *
 * This is a config check that only ever used to fail on a *reader's* Mac: the
 * bundle is signed ad-hoc (`signingIdentity: "-"`), an ad-hoc signature has no
 * Team ID, and a restricted entitlement — one that is only legitimate with a
 * provisioning profile — makes macOS refuse to launch the app. The reader sees
 * "the application can't be opened", the process is killed before it can write
 * a crash log, and nothing on this machine can reproduce it.
 *
 *   - 17.0.0 shipped `keychain-access-groups: $(AppIdentifierPrefix)…` in an
 *     *unsigned* bundle, where it was inert (no signature, no entitlements).
 *   - 17.0.1 began signing, and that entry reached a real signature; the app
 *     stopped opening on Apple Silicon (AMFI: "its use of the
 *     keychain-access-groups entitlement is not allowed", -67050).
 *
 * So the list below is checked on every build, on every platform, in the same
 * `prebuild` chain that already refuses dead CSS and unexplained buttons.
 *
 * Usage: node scripts/check-entitlements.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = join(root, "src-tauri/Entitlements.plist");

/**
 * Entitlements that require a provisioning profile or a Team ID.
 *
 * `com.apple.developer.*` is the Apple namespace for capabilities, which are
 * granted by a profile; `keychain-access-groups` and `application-identifier`
 * name the team whose identity the system should check the signature against.
 * None of them can be satisfied by an ad-hoc signature.
 */
const RESTRICTED = [
  /^keychain-access-groups$/,
  /^com\.apple\.application-identifier$/,
  /^com\.apple\.developer\./,
  /^com\.apple\.security\.application-groups$/,
  /^aps-environment$/,
  /^get-task-allow$/,
];

/** Entitlements an ad-hoc + hardened-runtime build needs to run at all. */
const REQUIRED = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.disable-library-validation",
];

const xml = readFileSync(FILE, "utf8");
const keys = [...xml.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1].trim());

const restricted = keys.filter((key) => RESTRICTED.some((re) => re.test(key)));
const missing = REQUIRED.filter((key) => !keys.includes(key));

if (restricted.length > 0) {
  console.error(
    "Entitlements an ad-hoc signature cannot satisfy — macOS will refuse to\n" +
      "launch the app on Apple Silicon (\"the application can't be opened\"):\n" +
      restricted.map((k) => `  ${k}`).join("\n") +
      "\n\nEither drop it, or move the project to a Developer ID signature\n" +
      "(docs/RELEASE.md, \"Code signing\") — the two cannot mix.\n",
  );
  process.exit(1);
}

if (missing.length > 0) {
  console.error(
    "Missing entitlements an ad-hoc + hardened-runtime build needs:\n" +
      missing.map((k) => `  ${k}`).join("\n") +
      "\n\nSee the comments in src-tauri/Entitlements.plist for why each is there.\n",
  );
  process.exit(1);
}

console.log(
  `Entitlements OK — ${keys.length} key(s), none restricted, ad-hoc requirements present.`,
);
