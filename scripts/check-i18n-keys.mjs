#!/usr/bin/env node
/**
 * Every translation key is used, and both locales have the same keys (16.0).
 *
 * A key is used when the source names it: `t("a.b")`, a `key: "a.b"` /
 * `labelKey` / `message:` string, or any string literal equal to it. A key
 * built from a template (`t(\`cite.${status}\`)`) counts every key under its
 * fixed prefix as used. Plural forms (`_plural`, `_one`, `_other`) count
 * with their base key.
 *
 * Usage: node scripts/check-i18n-keys.mjs   (exit 1 on a problem)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LOCALES = join(ROOT, "src/i18n/locales");

function flatten(obj, prefix = "", out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") flatten(v, key, out);
    else out.set(key, v);
  }
  return out;
}

function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "locales" || name === "node_modules") continue;
      sources(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const en = flatten(JSON.parse(readFileSync(join(LOCALES, "en.json"), "utf8")));
const zh = flatten(JSON.parse(readFileSync(join(LOCALES, "zh-CN.json"), "utf8")));
const code = sources(join(ROOT, "src")).map((p) => readFileSync(p, "utf8")).join("\n");

const literals = new Set([...code.matchAll(/["'`]([A-Za-z][\w-]*(?:\.[\w-]+)+)["'`]/g)].map((m) => m[1]));
const prefixes = [...code.matchAll(/`([A-Za-z][\w-]*(?:\.[\w-]+)*\.)\$\{/g)].map((m) => m[1]);
const base = (k) => k.replace(/_(plural|one|other|few|many|zero)$/, "");
const used = (k) => literals.has(k) || literals.has(base(k)) || prefixes.some((p) => k.startsWith(p));

const unused = [...en.keys()].filter((k) => !used(k));
const onlyEn = [...en.keys()].filter((k) => !zh.has(k));
const onlyZh = [...zh.keys()].filter((k) => !en.has(k));

let failed = false;
const report = (title, list) => {
  if (list.length === 0) return;
  failed = true;
  console.error(`${title} (${list.length}):`);
  for (const k of list) console.error(`  ${k}`);
};
report("Keys no source uses", unused);
report("Keys only in en.json", onlyEn);
report("Keys only in zh-CN.json", onlyZh);
if (failed) process.exit(1);
console.log(`i18n check passed — ${en.size} keys, each used, in both locales.`);
