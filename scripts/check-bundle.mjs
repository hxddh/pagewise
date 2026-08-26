#!/usr/bin/env node
/**
 * Nothing the reader should never see reaches the shipped bundle.
 *
 * A setting nobody checks is a promise nobody keeps. This asserts the OUTCOME
 * rather than trusting any knob, so a change of minifier fails here instead of
 * shipping a console call to a reader's devtools.
 *
 * It has now done that twice, and the second time corrected this comment.
 *
 * This paragraph used to say `esbuild: { drop: [...] }` had always been inert
 * because it keyed off `process.env.NODE_ENV === "production"`, which is not
 * set while the config is evaluated, so the array was empty — and it cited the
 * dev-server warning `{ drop: [] }` as proof. That was wrong. `vite build`
 * DOES set NODE_ENV: the same warning under `vite build` reads `{ drop: [
 * 'console', 'debugger' ] }`, and esbuild's minifier honoured it. The empty
 * array appears in DEV, which is what that warning was printed by.
 *
 * The claim was believed until Vite 8.2.2 made `minify: "esbuild"` unloadable
 * and five console.error calls landed in the vendor chunk — at which point
 * "the stripping happens by the minifier's own default" was measurably false
 * too. Stripping is now stated explicitly to oxc, the minifier that actually
 * runs (`rollupOptions.output.minify.compress.dropConsole`).
 *
 * Both readings were reasonable and both were wrong, which is the argument for
 * this file: check the bundle, not the config.
 *
 * Runs as `postbuild`, so `npm run build` covers it and so does CI.
 *
 * Usage: node scripts/check-bundle.mjs
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not `.pathname` — see scripts/css-hygiene.test.mjs for the two
// Windows release builds that idiom cost.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ASSETS = join(ROOT, "dist/assets");

/**
 * The pdf.js worker is vendored, not built from this repo's source.
 *
 * It is copied in whole by `prepare:pdfjs` and never passes through the
 * bundler, so its contents are upstream's business. Holding it to this rule
 * would mean either patching someone else's minified worker or turning the
 * check off, and both are worse than naming the exception.
 */
const VENDORED = /^pdf\.worker/;

if (!existsSync(ASSETS)) {
  console.error("No dist/assets — run `npm run build` first.");
  process.exit(1);
}

const offenders = [];
let scanned = 0;

for (const file of readdirSync(ASSETS)) {
  if (!file.endsWith(".js") && !file.endsWith(".mjs")) continue;
  if (VENDORED.test(file)) continue;
  scanned += 1;
  const code = readFileSync(join(ASSETS, file), "utf8");
  // `console` is a global, so minification cannot rename it away; a match here
  // is a real call that survived.
  const hits = code.match(/console\.[a-zA-Z]+/g);
  if (hits) {
    const counts = new Map();
    for (const h of hits) counts.set(h, (counts.get(h) ?? 0) + 1);
    offenders.push(
      `  ${file}  ${[...counts].map(([k, n]) => `${k} ×${n}`).join(", ")}`,
    );
  }
}

if (scanned === 0) {
  // An empty scan passing would be the worst outcome: silent success is how the
  // option this replaces went unnoticed for so long.
  console.error("Bundle check found no JavaScript to scan — that is a failure, not a pass.");
  process.exit(1);
}

if (offenders.length === 0) {
  console.log(`Bundle check passed — ${scanned} chunk(s), no console calls shipped.`);
  process.exit(0);
}

console.error(`Console calls reached the shipped bundle:\n\n${offenders.join("\n")}\n`);
console.error(
  "The minifier is expected to strip these. If that changed deliberately, say so\n" +
    "here; if not, this is output going to a reader's devtools.",
);
process.exit(1);
