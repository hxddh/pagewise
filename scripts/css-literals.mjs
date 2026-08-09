#!/usr/bin/env node
/**
 * Values written out in CSS where a design token exists for them.
 *
 * This exists because the number it replaces was wrong. The 7.6 evaluation
 * reported "95 hardcoded sizes in App.css", counted with
 * `grep -cE '^\s*(font-size|border-radius|padding|margin|gap):\s*[0-9]'`. That
 * matches `margin: 0`, `border-radius: 50%`, `padding: 0 var(--space-md)` and
 * every `em` value inside `.markdown` — none of which a spacing token should
 * cover. The real count was around ten, so the finding was inflated by roughly
 * nine to one and the conclusion drawn from it ("the type scale is only a local
 * fact") was not supported.
 *
 * So: only a literal a token could actually replace is counted. Zeros, `50%`
 * circles, `em` values that scale with their text, and already-tokenized
 * shorthands are not violations, and saying they are makes the metric useless.
 *
 * Usage: node scripts/css-literals.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not `.pathname`: on Windows a file: URL's pathname is
// "/D:/a/repo/src", and handing that leading slash to fs resolves to
// "D:\\D:\\a\\repo\\src". That doubled drive letter failed the 7.7.0 Windows
// release build, and it is the second Windows-only break from a check added
// on Linux and never run anywhere else.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIRS = ["src/styles/app", "src/styles"];

/** value → token, per property family. */
const SPACING = { "4px": "--space-xs", "6px": "--space-sm", "8px": "--space-md", "12px": "--space-lg", "16px": "--space-xl" };
const FONT = { "11px": "--text-xs", "12px": "--text-sm", "13px": "--text-base", "14px": "--text-md", "15px": "--text-lg", "28px": "--text-display" };
const RADIUS = { "4px": "--radius-sm", "6px": "--radius", "10px": "--radius-lg", "999px": "--radius-pill", "9999px": "--radius-pill" };

const TABLE = {
  "font-size": FONT,
  "border-radius": RADIUS,
  padding: SPACING,
  margin: SPACING,
  gap: SPACING,
  "row-gap": SPACING,
  "column-gap": SPACING,
};

/**
 * A token exists for this literal.
 *
 * `0` is not a spacing step — it is the absence of one, and `var(--space-zero)`
 * would be worse than `0`. `50%` is a circle. `em` is relative to its own text,
 * which is what markdown body copy wants. None of those count.
 */
export function tokenFor(property, value) {
  const table = TABLE[property];
  if (!table) return null;
  if (/^0$/.test(value)) return null;
  if (value.endsWith("%")) return null;
  if (/e[m|x]$|rem$/.test(value)) return null;
  return table[value] ?? null;
}

export function findLiterals(css) {
  const out = [];
  const body = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const lines = body.split("\n");
  lines.forEach((line, i) => {
    const m = /^\s*([a-z-]+)\s*:\s*([^;]+);/.exec(line);
    if (!m) return;
    const [, property, raw] = m;
    if (!TABLE[property]) return;
    for (const part of raw.trim().split(/\s+/)) {
      const token = tokenFor(property, part);
      if (token) out.push({ line: i + 1, property, value: part, token });
    }
  });
  return out;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  let total = 0;
  for (const dir of DIRS) {
    for (const file of readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".css"))) {
      const path = join(dir, file);
      const hits = findLiterals(readFileSync(join(ROOT, path), "utf8"));
      for (const h of hits) {
        console.log(`  ${path}:${h.line}  ${h.property}: ${h.value}  → var(${h.token})`);
      }
      total += hits.length;
    }
  }
  console.log(
    total === 0
      ? "No CSS literal has a token that could replace it."
      : `\n${total} literal${total === 1 ? "" : "s"} a token could replace.`,
  );
}
