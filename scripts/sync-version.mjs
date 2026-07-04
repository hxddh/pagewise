#!/usr/bin/env node
/**
 * Sync VERSION file → package.json, tauri.conf.json, Cargo.toml
 * Usage: node scripts/sync-version.mjs [optional-version]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function readVersion() {
  const fromArg = process.argv[2]?.trim();
  if (fromArg) return fromArg;
  return readFileSync(join(root, "VERSION"), "utf8").trim();
}

const version = readVersion();
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error(`Invalid semver: ${version}`);
  process.exit(1);
}

writeFileSync(join(root, "VERSION"), `${version}\n`);

const pkgPath = join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.version = version;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

const tauriPath = join(root, "src-tauri", "tauri.conf.json");
const tauri = JSON.parse(readFileSync(tauriPath, "utf8"));
// Tauri reads semver from package.json at build time — keep the pointer stable.
tauri.version = "../package.json";
writeFileSync(tauriPath, `${JSON.stringify(tauri, null, 2)}\n`);

const cargoPath = join(root, "src-tauri", "Cargo.toml");
let cargo = readFileSync(cargoPath, "utf8");
cargo = cargo.replace(/^version = "[^"]+"/m, `version = "${version}"`);
writeFileSync(cargoPath, cargo);

// Keep Cargo.lock's own package entry in sync — CI runs `cargo check --locked`,
// which fails if the lockfile version drifts from Cargo.toml. Anchored to the
// package name so it never touches a dependency's version line.
const cargoLockPath = join(root, "src-tauri", "Cargo.lock");
let cargoLock = readFileSync(cargoLockPath, "utf8");
cargoLock = cargoLock.replace(
  /(name = "pagewise"\nversion = ")[^"]+(")/,
  `$1${version}$2`,
);
writeFileSync(cargoLockPath, cargoLock);

// Keep package-lock.json in sync (root version + root package entry).
const lockPath = join(root, "package-lock.json");
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
lock.version = version;
if (lock.packages && lock.packages[""]) {
  lock.packages[""].version = version;
}
writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

console.log(
  `Synced version ${version} → package.json, package-lock.json, tauri.conf.json (package.json ref), Cargo.toml, Cargo.lock`,
);
