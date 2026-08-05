#!/usr/bin/env node
/**
 * Fail the build when a stylesheet reads a custom property nothing defines.
 *
 * `var(--does-not-exist)` is silent. With no fallback the declaration becomes
 * `unset` at computed-value time: a colour quietly inherits, a background
 * quietly goes transparent. Six of these had accumulated by 6.2 — a "Mark"
 * button rendered as white text on a near-white surface in the light theme, a
 * note field with no background at all, and four hover states that never
 * brightened. Every one of them looked like sloppy design rather than a
 * mistake, which is exactly why a person does not catch them.
 *
 * A fallback (`var(--x, 6px)`) is still reported: it means two places disagree
 * about what `--x` is, which is how the same token produced 0px in one rule and
 * 6px in another.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "src";
/** Injected by pdf.js at runtime rather than declared by this project. */
const EXTERNAL = new Set(["--total-scale-factor", "--scale-factor"]);

function cssFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...cssFiles(path));
    else if (entry.endsWith(".css")) out.push(path);
  }
  return out;
}

const files = cssFiles(ROOT);
const defined = new Set();
for (const file of files) {
  for (const m of readFileSync(file, "utf8").matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)) {
    defined.add(m[1]);
  }
}

const problems = [];
for (const file of files) {
  const source = readFileSync(file, "utf8");
  const lines = source.split("\n");
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/var\(\s*(--[a-z0-9-]+)\s*([^)]*)\)/g)) {
      const name = m[1];
      if (defined.has(name) || EXTERNAL.has(name)) continue;
      const hasFallback = m[2].trim().startsWith(",");
      problems.push({
        file,
        line: i + 1,
        name,
        detail: hasFallback
          ? "undefined; the fallback hides it, and other rules may use a different one"
          : "undefined and has no fallback: the declaration is dropped",
      });
    }
  });
}

if (problems.length > 0) {
  console.error("Undefined CSS custom properties:\n");
  for (const p of problems) {
    console.error(`  ${p.file}:${p.line}  ${p.name} — ${p.detail}`);
  }
  console.error(
    `\n${problems.length} problem(s). Define the token in src/styles/tokens.css ` +
      "or use the name that exists.",
  );
  process.exit(1);
}

console.log(`CSS token check passed — ${defined.size} tokens defined, every reference resolves.`);
