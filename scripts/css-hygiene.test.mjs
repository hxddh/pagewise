import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The two CSS sweeps of 7.6, kept as invariants instead of as a one-off tidy.
 *
 * Both were done by hand once before and both grew back, because nothing failed
 * when they did: 116 unreachable rules had accumulated since the v3 shell
 * replaced the sidebar, the library list and the onboarding steps, and four
 * `@keyframes` had outlived every animation that referenced them. A cleanup
 * nobody can regress is a cleanup that happens once.
 *
 * These run in the normal test suite, so a rule with no markup behind it fails
 * on the commit that orphans it rather than a year later.
 */

const ROOT = new URL("..", import.meta.url).pathname;
const DIRS = ["src/styles/app", "src/styles"];

function stylesheets() {
  const out = [];
  for (const dir of DIRS) {
    for (const file of readdirSync(join(ROOT, dir))) {
      if (file.endsWith(".css")) out.push(join(ROOT, dir, file));
    }
  }
  return out;
}

const withoutComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("CSS hygiene", () => {
  it("defines no class the app never applies", () => {
    // find-dead-css.mjs is the authority on what "applies" means — it reads
    // class positions, not any occurrence of the string, because
    // `import "./recent-files"` used to be mistaken for markup.
    const output = execFileSync(
      process.execPath,
      [join(ROOT, "scripts/find-dead-css.mjs")],
      { encoding: "utf8" },
    );
    const count = Number(/(\d+) defined but never applied/.exec(output)?.[1]);
    expect(Number.isFinite(count)).toBe(true);
    expect(count, `\n${output}`).toBe(0);
  });

  it("keeps no @keyframes nothing animates", () => {
    const css = withoutComments(stylesheets().map((f) => readFileSync(f, "utf8")).join("\n"));
    const defined = new Set([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]));
    const used = new Set();
    for (const m of css.matchAll(/animation(?:-name)?\s*:\s*([^;]+);/g)) {
      for (const token of m[1].split(/[\s,]+/)) if (defined.has(token)) used.add(token);
    }
    const orphaned = [...defined].filter((name) => !used.has(name)).sort();
    expect(orphaned, "declared but never animated").toEqual([]);
  });

  it("writes no value out that a token already names", () => {
    // Counted honestly — see scripts/css-literals.mjs for why the previous
    // number (95) was wrong by about 95 to 1. Zeros, percentage circles and
    // `em` values are not violations.
    const output = execFileSync(
      process.execPath,
      [join(ROOT, "scripts/css-literals.mjs")],
      { encoding: "utf8" },
    );
    expect(output.trim(), output).toBe(
      "No CSS literal has a token that could replace it.",
    );
  });

  it("reads the snapshot whatever line endings it arrives with", () => {
    // This broke the 7.6.0 Windows release build. Git checks the snapshot out
    // with CRLF on a Windows runner, and splitting it on "\n" alone left a
    // trailing "\r" on every stored line — so every line differed from the live
    // one by an invisible character, and the failure printed `was: X` / `now: X`
    // identically for each, saying nothing. Linux and macOS passed, so the
    // release published with four assets instead of six.
    const snapshot = join(ROOT, "scripts/css-order.snapshot");
    const original = readFileSync(snapshot);
    try {
      writeFileSync(snapshot, original.toString("utf8").replace(/\n/g, "\r\n"));
      expect(() =>
        execFileSync(process.execPath, [join(ROOT, "scripts/check-css-order.mjs")], {
          encoding: "utf8",
        }),
      ).not.toThrow();
    } finally {
      writeFileSync(snapshot, original);
    }
  });

  it("keeps the cascade in the order the snapshot records", () => {
    // Splitting App.css into 13 parts is only safe while they concatenate in the
    // original order — later rules deliberately override earlier ones. This is
    // the same check as `npm run check:css-order`, run with the suite so a
    // reordering cannot reach a build.
    expect(() =>
      execFileSync(process.execPath, [join(ROOT, "scripts/check-css-order.mjs")], {
        encoding: "utf8",
      }),
    ).not.toThrow();
  });
});
