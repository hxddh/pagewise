#!/usr/bin/env node
/**
 * The cascade is load-bearing. This checks nobody has quietly moved it.
 *
 * `App.css` grew to 3,590 lines by accretion, and later rules in it deliberately
 * override earlier ones — `.tool-steps-list` is written twice, `.message.assistant`
 * twice, and a whole block of `.app.v3 …` rules near the end exists only to win
 * against the chat rules a thousand lines above it. Which declaration applies is
 * decided by source order.
 *
 * Splitting that file into parts is therefore only safe while the parts are
 * concatenated in exactly the original order. So this script records the
 * selector sequence in `scripts/css-order.snapshot` and fails when the live
 * sequence differs — whether because a part moved in the import list, a rule was
 * moved between parts, or a rule was dropped.
 *
 * A deliberate change (adding a rule, resolving one of the duplicates) is
 * accepted by re-recording:  node scripts/check-css-order.mjs --update
 * Do that only when you have decided the new order is what you want; the diff it
 * prints is the change you are approving.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PARTS_DIR = join(root, "src/styles/app");
const SNAPSHOT = join(root, "scripts/css-order.snapshot");

/**
 * Every selector and at-rule prelude in the file, in source order.
 *
 * Depth-tracked rather than regex-matched: `@media` and `@keyframes` bodies
 * contain rules of their own, and a selector inside one is not the same position
 * in the cascade as the same selector outside it.
 */
export function selectorSequence(css) {
  const out = [];
  let depth = 0;
  let buffer = "";
  let inComment = false;

  for (let i = 0; i < css.length; i++) {
    if (inComment) {
      if (css[i] === "*" && css[i + 1] === "/") {
        inComment = false;
        i += 1;
      }
      continue;
    }
    if (css[i] === "/" && css[i + 1] === "*") {
      inComment = true;
      i += 1;
      continue;
    }
    if (css[i] === "{") {
      const prelude = buffer.trim().replace(/\s+/g, " ");
      if (prelude) out.push(`${"  ".repeat(depth)}${prelude}`);
      buffer = "";
      depth += 1;
      continue;
    }
    if (css[i] === "}") {
      buffer = "";
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (css[i] === ";" && depth === 0) {
      // A top-level @import / @charset — a position in the cascade too.
      const prelude = buffer.trim().replace(/\s+/g, " ");
      if (prelude.startsWith("@")) out.push(prelude);
      buffer = "";
      continue;
    }
    buffer += css[i];
  }
  return out;
}

/** The parts, in the numeric order their filenames declare. */
export function orderedParts(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".css"))
    .sort();
}

function liveSequence() {
  const files = orderedParts(PARTS_DIR);
  const lines = [];
  for (const file of files) {
    lines.push(`# ${file}`);
    lines.push(...selectorSequence(readFileSync(join(PARTS_DIR, file), "utf8")));
  }
  return lines;
}

const live = liveSequence();
const update = process.argv.includes("--update");

if (update || !existsSync(SNAPSHOT)) {
  writeFileSync(SNAPSHOT, `${live.join("\n")}\n`);
  console.log(
    `Recorded ${live.length} lines of CSS order to scripts/css-order.snapshot.`,
  );
  process.exit(0);
}

const stored = readFileSync(SNAPSHOT, "utf8").trimEnd().split("\n");

if (stored.length === live.length && stored.every((l, i) => l === live[i])) {
  console.log(
    `CSS order check passed — ${orderedParts(PARTS_DIR).length} parts, ` +
      `${live.filter((l) => !l.startsWith("#")).length} rules in the recorded order.`,
  );
  process.exit(0);
}

console.error("CSS cascade order changed.\n");
const max = Math.max(stored.length, live.length);
let shown = 0;
for (let i = 0; i < max && shown < 40; i++) {
  if (stored[i] === live[i]) continue;
  console.error(`  line ${i + 1}`);
  console.error(`    was: ${stored[i] ?? "(end of file)"}`);
  console.error(`    now: ${live[i] ?? "(end of file)"}`);
  shown += 1;
}
if (shown === 40) console.error("  … more differences follow");
console.error(
  "\nIf this change is intended, re-record it:\n" +
    "  node scripts/check-css-order.mjs --update\n" +
    "Read the diff above first — it is the cascade change you are approving.",
);
process.exit(1);
