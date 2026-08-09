import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Surface hygiene kept as invariants instead of as one-off tidying.
 *
 * Every one of these was done by hand once and grew back, because nothing failed
 * when it did: 116 unreachable rules had accumulated since the v3 shell replaced
 * the sidebar, the library list and the onboarding steps; four `@keyframes` had
 * outlived every animation that referenced them; and 6.3's argument about which
 * buttons should stay hand-written lived in one comment about a set nobody
 * recorded. A cleanup nobody can regress is a cleanup that happens once.
 *
 * These run in the normal test suite, so a rule with no markup behind it — or a
 * `<button>` with no reason behind it — fails on the commit that adds it.
 */

// fileURLToPath, not `.pathname`: on Windows a file: URL's pathname is
// "/D:/a/repo/src", and handing that leading slash to fs resolves to
// "D:\\D:\\a\\repo\\src". That doubled drive letter failed the 7.7.0 Windows
// release build, and it is the second Windows-only break from a check added
// on Linux and never run anywhere else.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
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

  it("gives a reason for every hand-written <button>", () => {
    // 6.3 argued that a few elements should stay raw — a card loses its meaning
    // as a control, a tab is not a button, an inline affordance inside a
    // sentence has no box. The argument was right and lived in one comment,
    // about a set nobody recorded, so it could not tell an exception from
    // something nobody had got round to. Each site now says which it is.
    const output = execFileSync(
      process.execPath,
      [join(ROOT, "scripts/check-raw-buttons.mjs")],
      { encoding: "utf8" },
    );
    expect(output).toContain("Raw-button check passed");
  });

  it("resolves its own directory in a way that works on Windows", () => {
    // Twice in two releases a check I added broke the Windows release build and
    // nothing else, because I only ever ran it here. 7.6.0 was a CRLF snapshot;
    // 7.7.0 was `new URL(…, import.meta.url).pathname`, which yields
    // "/D:/a/repo/src" on Windows and resolves to "D:\\D:\\a\\repo\\src".
    //
    // The real fix is not another careful reading — it is this: the idiom cannot
    // be used at all. A script that needs a path from its own URL has to go
    // through fileURLToPath.
    const offenders = [];
    for (const file of readdirSync(join(ROOT, "scripts"))) {
      if (!file.endsWith(".mjs")) continue;
      const source = readFileSync(join(ROOT, "scripts", file), "utf8");
      const live = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (/import\.meta\.url\s*\)\s*\.pathname/.test(live)) offenders.push(file);
    }
    expect(
      offenders,
      "use fileURLToPath(new URL(..., import.meta.url)) — .pathname breaks on Windows",
    ).toEqual([]);
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
