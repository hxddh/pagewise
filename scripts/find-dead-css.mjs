#!/usr/bin/env node
/**
 * Class names defined in CSS that nothing in the app applies.
 *
 * The first version of this searched for the name anywhere in the TypeScript,
 * which was wrong in both directions:
 *
 *   - `.recent-files` was reported LIVE because `src/lib/recent-files.ts` exists
 *     and every `import "./recent-files"` contains the string. The rules had had
 *     no markup behind them since the v3 shell replaced that list.
 *   - `.markedContent` was reported DEAD because pdf.js writes it into the text
 *     layer at runtime and this repo's source never mentions it.
 *
 * So it now collects the names the app actually puts in a `class` position —
 * `className="…"`, `class="…"`, and the literal segments of a
 * `className={`a ${x} b`}` template — and nothing else. A name assembled entirely
 * out of interpolation (`ui-panel--${tone}`) has no literal to find, so those
 * prefixes are still treated as live. Names that only ever come from a library's
 * DOM are listed in EXTERNAL below, with the library that writes each one.
 *
 * Still reports rather than deletes. The output is short enough to read.
 *
 * Usage: node scripts/find-dead-css.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not `.pathname`: on Windows a file: URL's pathname is
// "/D:/a/repo/src", and handing that leading slash to fs resolves to
// "D:\\D:\\a\\repo\\src". That doubled drive letter failed the 7.7.0 Windows
// release build, and it is the second Windows-only break from a check added
// on Linux and never run anywhere else.
const SRC = fileURLToPath(new URL("../src", import.meta.url));

/**
 * Class names no source file can mention because something else writes them.
 * Each needs the library that produces it named, or it does not belong here.
 */
const EXTERNAL = new Map([
  ["markedContent", "pdf.js wraps marked-content spans in the text layer"],
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(SRC);
const codeFiles = files.filter((f) => [".ts", ".tsx"].includes(extname(f)));
const code = codeFiles.map((f) => readFileSync(f, "utf8")).join("\n");

/**
 * Every class name the source puts in a class position.
 *
 * Attribute values are read whole and split on whitespace, so a multi-class
 * string counts for each of its names; `${…}` spans inside a template are
 * dropped, which leaves the literal segments around them.
 */
/**
 * The string literals in a fragment, each closed by its own kind of quote.
 *
 * Pairing quote characters off against each other does not work: in
 * `` `a ${c ? "" : "b"}` `` the closer of one literal becomes the opener of the
 * next and everything shifts by one, which is how `.chat-column-hidden` came to
 * be reported as dead. A template's `${…}` is left inside its literal and split
 * apart by the caller, so the names around an interpolation still count.
 */
function stringLiterals(fragment) {
  const out = [];
  for (let i = 0; i < fragment.length; i++) {
    const quote = fragment[i];
    if (quote !== '"' && quote !== "'" && quote !== "`") continue;
    let j = i + 1;
    let buffer = "";
    while (j < fragment.length && fragment[j] !== quote) {
      if (fragment[j] === "\\") {
        j += 2;
        continue;
      }
      buffer += fragment[j];
      j += 1;
    }
    out.push(buffer);
    i = j;
  }
  return out;
}

/**
 * The right-hand sides of `const x = …` for a set of names, where the value is
 * a literal class list or a single template.
 *
 * Needed because a class list is not always written where it is used: every
 * `ui-*` component builds one in a local first
 * (`const classes = ["ui-btn", `ui-btn--${variant}`]`) and then writes
 * `className={classes}`. A scanner that reads only the attribute sees the
 * identifier and none of the names — which is how `ui-btn--ghost` and eleven
 * others came back as "defined but never applied" the moment the interpolation
 * rule was tightened to class positions.
 *
 * Restricted to array literals and string/template literals on purpose. An
 * earlier version read any declaration the identifier named, which walked into
 * test fixtures (`{ type: `tool-${name}` }`) and turned "tool" into a live class
 * prefix — exempting `.tool-label`, `.tool-fold-state` and `.tool-debug`, three
 * rules with no markup behind them. Classes live in class-shaped values.
 */
function assignedFragments(source, names) {
  const out = [];
  for (const name of names) {
    const re = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*`, "g");
    let m;
    while ((m = re.exec(source))) {
      const start = m.index + m[0].length;
      const first = source[start];
      if (first !== "[" && first !== '"' && first !== "'" && first !== "`") continue;
      let i = start;
      let depth = 0;
      let quote = null;
      for (; i < source.length; i += 1) {
        const ch = source[i];
        if (quote) {
          if (ch === "\\") i += 1;
          else if (ch === quote) quote = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") quote = ch;
        else if (ch === "[" || ch === "(" || ch === "{") depth += 1;
        else if (ch === "]" || ch === ")" || ch === "}") {
          if (depth === 0) break;
          depth -= 1;
        } else if (ch === ";" && depth === 0) break;
      }
      out.push(source.slice(start, i));
    }
  }
  return out;
}

export function appliedClassNames(source) {
  const found = new Set();
  /*
   * Prefixes that only exist as an interpolation — `cite-${level}` — and must
   * therefore be treated as live for every class they could produce.
   *
   * Collected from CLASS POSITIONS ONLY, and that is the whole point. The first
   * version of this scanned the file for `foo-${` anywhere, so a test fixture
   * writing `/doc-${i}.pdf` (chat/persist.test.ts) registered "doc" as a class
   * prefix and exempted every `.doc-*` rule in the app — `.doc-name` and
   * `.doc-meta` had no markup behind them for two releases while this check
   * reported zero. A path fragment and a class prefix look the same to a regex;
   * they do not look the same inside `className={…}`.
   */
  const composed = new Set();
  const identifiers = new Set();
  const add = (value) => {
    for (const name of value.split(/[\s${}()?:'"`+]+/)) {
      if (/^[A-Za-z][\w-]*$/.test(name)) found.add(name);
    }
  };
  const addComposed = (fragment) => {
    for (const m of fragment.matchAll(/([a-z][\w-]*?)-{1,2}\$\{/g)) composed.add(m[1]);
  };
  const noteIdentifiers = (fragment) => {
    for (const m of fragment.matchAll(/[A-Za-z_$][\w$]*/g)) identifiers.add(m[0]);
  };
  // className="a b" / class="a b"
  for (const m of source.matchAll(/\bclass(?:Name)?\s*=\s*"([^"]*)"/g)) add(m[1]);
  // className={…} — brace-matched, not regex-terminated. A non-greedy `\{…\}`
  // stops at the first `}`, which inside `` `a ${cond ? "b" : ""}` `` is the
  // interpolation's own closer — so everything after it, including the class
  // names, was never read. Six live names were reported dead that way.
  for (const m of source.matchAll(/\bclass(?:Name)?\s*=\s*\{/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") depth -= 1;
    }
    const fragment = source.slice(m.index + m[0].length, i - 1);
    add(stringLiterals(fragment).join(" "));
    addComposed(fragment);
    noteIdentifiers(fragment);
  }
  // Follow the locals those attributes name, one level: `const classes = […]`.
  for (const fragment of assignedFragments(source, identifiers)) {
    add(stringLiterals(fragment).join(" "));
    addComposed(fragment);
  }
  // classList.add("x") / .toggle("x", cond) / a bare className assignment
  for (const m of source.matchAll(/classList\.\w+\(\s*"([^"]*)"/g)) add(m[1]);
  for (const m of source.matchAll(/\.className\s*=\s*"([^"]*)"/g)) add(m[1]);
  return { found, composed };
}

const { found: applied, composed: composedPrefixes } = appliedClassNames(code);

const composed = [...composedPrefixes];

const defined = new Map();
for (const f of files.filter((f) => extname(f) === ".css")) {
  // Comments first: this file's own prose names the rules it explains, and a
  // scanner that reads them reports them as defined and then as dead.
  const css = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of css.matchAll(/(^|[\s,>+~(])\.([A-Za-z][\w-]*)/gm)) {
    // Forward slashes on every platform, so the report reads the same way
    // wherever it runs. Display only here, unlike check-raw-buttons.mjs, where
    // the same slice was compared against a hand-written path and lost.
    if (!defined.has(m[2])) defined.set(m[2], f.slice(SRC.length + 1).split(sep).join("/"));
  }
}

const suspect = [...defined.keys()]
  .filter((c) => !applied.has(c))
  .filter((c) => !EXTERNAL.has(c))
  // `ui-panel--${tone}` makes both `ui-panel--surface` and the bare `ui-panel`
  // base class live, and neither has a literal to find.
  .filter((c) => !composed.some((p) => c === p || c.startsWith(`${p}-`)))
  .sort();

/*
 * What the app applies, of what the stylesheets define.
 *
 * The candidate set now reaches through locals and templates, so it holds class
 * names and near-misses both ("secondary", "md"); reporting its raw size says
 * nothing. The number that means something is the intersection.
 */
const appliedDefined = [...applied].filter((c) => defined.has(c)).length;

console.log(
  `${defined.size} class names defined, ${appliedDefined} applied by the app, ` +
    `${suspect.length} defined but never applied:\n`,
);
for (const c of suspect) console.log(`  .${c.padEnd(32)} ${defined.get(c)}`);
if (EXTERNAL.size > 0) {
  console.log("\nDefined and applied by a library, not by this app:");
  for (const [name, why] of EXTERNAL) console.log(`  .${name.padEnd(32)} ${why}`);
}
console.log(
  "\nStill a list to read, not a list to pipe into a delete: a name reached only " +
    "through a runtime-assembled string will appear here too.",
);
