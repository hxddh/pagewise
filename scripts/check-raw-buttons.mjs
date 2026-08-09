#!/usr/bin/env node
/**
 * Every `<button>` written by hand has to say why it is not `<Button>`.
 *
 * 6.3 replaced twenty-one button class names with one component, and argued at
 * the time that a handful of elements should stay raw: a card-shaped button
 * loses its meaning as a styled div, a `<details>` summary is not a button at
 * all, and an inline text affordance inside a paragraph is not a control with a
 * padding and a height. That argument was correct, and it was written in one
 * comment, in one file, about a set nobody recorded.
 *
 * So the same thing happened to it as happened to the dead CSS: a judgment that
 * exists only in prose cannot tell you whether the next raw `<button>` is an
 * argued exception or something nobody got round to migrating. This makes the
 * reason a condition of writing one.
 *
 * Mark a site with a `raw-button:` comment within the four lines above it, e.g.
 * "raw-button: a card, not a control — Button would flatten it".
 *
 * Usage: node scripts/check-raw-buttons.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const SRC = new URL("../src", import.meta.url).pathname;

/**
 * Files exempt from the rule, with the reason.
 *
 * Only the primitives themselves: `<Button>` and `<Field>` have to render a real
 * `<button>` somewhere, and asking them to justify it would be circular.
 */
const EXEMPT = new Map([
  ["components/ui/Button.tsx", "the primitive itself — it is what renders the element"],
  ["components/ui/Field.tsx", "renders the trigger a Field labels"],
]);

/** How many lines above a `<button>` the reason may sit. */
const LOOKBACK = 4;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (extname(full) === ".tsx" && !full.includes(".test.")) out.push(full);
  }
  return out;
}

export function unexplainedButtons(source, path) {
  const lines = source.split("\n");
  const out = [];
  lines.forEach((line, i) => {
    // \b not [\s>]: most sites open the tag at end of line, with the props on
    // the lines below, so there is no following character to match.
    if (!/<button\b/.test(line)) return;
    const window = lines.slice(Math.max(0, i - LOOKBACK), i + 1).join("\n");
    if (/raw-button:\s*\S/.test(window)) return;
    out.push({ path, line: i + 1, text: line.trim().slice(0, 60) });
  });
  return out;
}

const unexplained = [];
let explained = 0;
let exempt = 0;

for (const file of walk(SRC)) {
  const rel = file.slice(SRC.length + 1);
  const source = readFileSync(file, "utf8");
  const count = (source.match(/<button\b/g) ?? []).length;
  if (count === 0) continue;
  if (EXEMPT.has(rel)) {
    exempt += count;
    continue;
  }
  const missing = unexplainedButtons(source, rel);
  explained += count - missing.length;
  unexplained.push(...missing);
}

if (unexplained.length === 0) {
  console.log(
    `Raw-button check passed — ${explained} hand-written <button> elements, ` +
      `each with a written reason; ${exempt} inside the primitives themselves.`,
  );
  process.exit(0);
}

console.error(
  `${unexplained.length} hand-written <button> element(s) with no reason given:\n`,
);
for (const b of unexplained) console.error(`  ${b.path}:${b.line}  ${b.text}`);
console.error(
  "\nEither use <Button>, or say why this one cannot, in a comment within " +
    `${LOOKBACK} lines above it, starting "raw-button:".\n` +
    "The reason is the point: an exception nobody wrote down is " +
    "indistinguishable from one nobody got round to.",
);
process.exit(1);
