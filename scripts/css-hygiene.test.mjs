import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
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

  it("draws every elevation and every timing from the scale", () => {
    // 8.0 found twelve hand-written drop shadows across eleven distinct values,
    // while `--shadow-md` sat defined-and-unused at a twelfth geometry; and two
    // animations declared at two speeds each — `popover-in` at 0.14s and 0.16s,
    // `pulse` at 1s and 1.2s. Both are the shape spacing, type and radius had
    // before they were scaled, and both drift the same way: nobody chooses the
    // second value, it just gets written next to the thing it decorates.
    //
    // Rings and insets are not elevation — `0 0 0 1px` is a border drawn with a
    // shadow, and an inset accent is a marker. Neither belongs on a scale of
    // how far a surface floats, the same way `em` is not a spacing step.
    //
    // A genuinely off-scale timing is allowed, but it has to say so: mark it
    // `motion-exception:` with the reason, like a hand-written <button>.
    const offenders = [];
    for (const file of stylesheets()) {
      if (file.endsWith("tokens.css")) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      const rel = file.slice(ROOT.length).split(sep).join("/");
      lines.forEach((line, i) => {
        const shadow = /box-shadow:\s*([^;]+);/.exec(line);
        if (
          shadow &&
          !/var\(--shadow/.test(shadow[1]) &&
          !/inset/.test(shadow[1]) &&
          !/^0 0 0 1px/.test(shadow[1].trim())
        ) {
          offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
        }
        const timing = /(?:transition|animation):\s*([^;]+);/.exec(line);
        if (timing && /\d+m?s/.test(timing[1]) && !/var\(--/.test(timing[1])) {
          const reason = lines.slice(Math.max(0, i - 4), i).join("\n");
          if (!/motion-exception:\s*\S/.test(reason)) {
            offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
          }
        }
      });
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("keeps the in-document search panel from stretching over the document", () => {
    // Both of these shipped, and nothing in the suite could have caught them:
    // the DOM was correct throughout. Search found its matches and built the
    // count, page numbers and snippets with ordinary contrast. What was wrong
    // was where they landed, which only a screenshot showed.
    //
    //   1. `.doc-search-overlay` is `display: flex` with `inset: 0` and no
    //      `align-items`, so the default `stretch` made the panel as tall as the
    //      window — 852px. `.doc-search-results` sits `top: calc(100% + 6px)`
    //      against that panel, so in a 900px window the results rendered at
    //      y=905: complete, and off the bottom edge. The panel is a translucent
    //      blurred surface, so at full height it also covered the document it
    //      was searching.
    //
    //   2. With that fixed, the close button turned out to be wrapping onto its
    //      own line, because `.doc-search-panel` was `display: block`. The
    //      evidence had been in the stylesheet all along: that panel's input is
    //      given `flex: 1`, which is inert unless the parent is a flex box.
    //      Someone wrote the child half and not the parent half.
    //
    // Asserted against stylesheet text, like every other check in this file,
    // because jsdom has no layout engine. The geometry itself was verified once
    // with the screenshot harness: panel 852px -> 30px, results y=905 -> y=109.
    const body = (css, selector) => {
      const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
      const start = stripped.indexOf(`${selector} {`);
      expect(start, `${selector} not found`).toBeGreaterThan(-1);
      return stripped.slice(start, stripped.indexOf("}", start));
    };
    const read = (rel) => readFileSync(join(ROOT, "src/styles", rel), "utf8");

    const overlay = body(read("app/09-palette-status.css"), ".doc-search-overlay");
    expect(overlay).toContain("display: flex");
    expect(
      overlay,
      "flex defaults to align-items: stretch, which made the panel as tall as " +
        "the window and pushed the results off the bottom of it",
    ).toMatch(/align-items:\s*(flex-)?start/);

    expect(
      body(read("preview.css"), ".doc-search-panel"),
      "the close button wrapped onto its own line; the input's `flex: 1` does " +
        "nothing unless this is a flex container",
    ).toContain("display: flex");
  });

  it("gives the page sidebar room for its own tab strip", () => {
    // "Pages | Outline | Marks" needed 124px of the 112px a 128px sidebar left
    // them, so the third tab ran past the edge and rendered as "Mar". The
    // buttons were never clipped internally (scrollWidth === width) — the strip
    // simply overflowed, which is the same shape as 8.1.0's search results and
    // just as invisible to a DOM test.
    //
    // This floor did NOT fix that, and this check passed for two releases while
    // the tab was still cut off. The width was asserted on the sidebar, but the
    // strip is not the sidebar's only child: it shares the header row with a
    // control, and `min-width: 0` let it be squeezed to 119px while its content
    // needed 136 — the same numbers at 1440px as at 900px, so widening the
    // window never revealed it either. A proxy for the thing that matters is
    // not the thing that matters. What holds it now is the check below.
    //
    // The floor still earns its place: it is what keeps the thumbnails legible.
    // Held as a width rather than a computed layout because jsdom has no layout
    // engine and the geometry was measured with the harness.
    const css = readFileSync(join(ROOT, "src/styles/app/07-preview-chrome.css"), "utf8");
    const width = /\.thumb-sidebar\s*\{[^}]*?width:\s*(\d+)px/s.exec(
      css.replace(/\/\*[\s\S]*?\*\//g, ""),
    );
    expect(width, ".thumb-sidebar width not found").toBeTruthy();
    expect(
      Number(width[1]),
      "three tab labels plus padding need more than this; at 128px the last one was cut off",
    ).toBeGreaterThanOrEqual(160);
  });

  it("keeps the thumbnail row pitch and the list gap agreeing", () => {
    // ThumbnailSidebar windows its list: how many rows fit, which row is first,
    // the spacer above the window and the scroll that reveals the current page
    // are all measured in THUMB_ROW_HEIGHT. That has to be the distance from one
    // row's top to the next — the button plus the gap under it.
    //
    // It was the button height alone (112) while the list also applied an 8px
    // gap, so the real pitch was 120 and every one of those sums was off by 8px
    // per row, drifting further down a long document. The two numbers live in
    // different files and nothing made them agree.
    const tsx = readFileSync(join(ROOT, "src/components/ThumbnailSidebar.tsx"), "utf8");
    const css = readFileSync(join(ROOT, "src/styles/app/07-preview-chrome.css"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    const gap = Number(/const THUMB_GAP = (\d+)/.exec(tsx)?.[1]);
    const button = Number(/const THUMB_BUTTON_HEIGHT = (\d+)/.exec(tsx)?.[1]);
    expect(Number.isFinite(gap) && Number.isFinite(button), "constants not found").toBe(true);

    expect(
      tsx,
      "THUMB_ROW_HEIGHT must be the pitch — button + gap — not the button alone",
    ).toContain("const THUMB_ROW_HEIGHT = THUMB_BUTTON_HEIGHT + THUMB_GAP;");

    const listGap = /\.thumb-list\s*\{[^}]*?gap:\s*var\(--space-([a-z0-9]+)\)/s.exec(css);
    expect(listGap, ".thumb-list gap not found").toBeTruthy();
    const SPACING = { "2xs": 2, xs: 4, sm: 6, md: 8, lg: 12, xl: 16, "2xl": 24 };
    expect(
      SPACING[listGap[1]],
      `.thumb-list draws a ${SPACING[listGap[1]]}px gap but the pitch assumes ${gap}px`,
    ).toBe(gap);
  });

  it("reports a failed document open through one surface, not two", () => {
    // `.file-error-banner` is fixed at top:12/right:12 and `.toast-viewport` at
    // top:16/right:16 — the same corner, by construction. So a failure reported
    // through both draws the same sentence twice, four pixels apart, and the
    // toast's close button lands on the banner's Dismiss: measured with the
    // screenshot harness, `elementFromPoint` at the centre of the banner's
    // button (1387, 21, 28x28) returned `.toast-close`. The banner could not be
    // dismissed until the toast expired on its own.
    //
    // The banner is the surface that stays. A document that would not open is a
    // state the reader is left sitting in, not an event that went past.
    //
    // Asserted as source text for the same reason as its neighbours: jsdom has
    // no layout engine, and the overlap is geometry.
    const css = (rel) =>
      readFileSync(join(ROOT, "src/styles", rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = (text, selector) => {
      const start = text.indexOf(`${selector} {`);
      expect(start, `${selector} not found`).toBeGreaterThan(-1);
      return text.slice(start, text.indexOf("}", start));
    };
    for (const [file, selector] of [
      ["app/13-chat-late.css", ".file-error-banner"],
      ["app/08-recents-toasts.css", ".toast-viewport"],
    ]) {
      const decl = rule(css(file), selector);
      expect(decl, `${selector} is why the two collide`).toContain("position: fixed");
      expect(decl).toMatch(/top:\s*\d+px/);
      expect(decl).toMatch(/right:\s*\d+px/);
    }

    const src = readFileSync(join(ROOT, "src/session/SessionProvider.tsx"), "utf8");
    const at = src.indexOf("setFileError(msg)");
    expect(at, "the document-load failure path moved").toBeGreaterThan(-1);
    const open = src.lastIndexOf("catch (", at);
    const close = src.indexOf("} finally {", at);
    expect(open > -1 && close > at, "could not bound the catch block").toBe(true);
    expect(
      src.slice(open, close),
      "the banner already says this; a toast saying it again covers the banner's Dismiss",
    ).not.toMatch(/\bshowToast\s*\(/);
  });

  it("leaves the sidebar tab strip alone in its header row", () => {
    // The strip fits its 143px allocation with 19px to spare — but only because
    // nothing else is in that row. It used to share it with a chevron that hid
    // the sidebar, 24px of a header that had 143, and the strip was squeezed to
    // 119 against 136 of tabs.
    //
    // That chevron was a duplicate: PreviewToolbar renders the same control
    // with the same `preview.thumbnailsHide` label whenever `totalPages > 1`,
    // which is exactly when a sidebar can exist — and being a toggle, it is
    // also the only one that can bring the panel back.
    //
    // Widening the sidebar instead was measured and rejected: at a 900px window
    // the preview toolbar has 319px for 314px of controls, so taking 40 more
    // for the sidebar puts that bar back into overlap. The two fixes pull
    // against each other and the room has to come from inside the header.
    for (const file of [
      "src/components/ThumbnailSidebar.tsx",
      "src/components/OutlineSidebar.tsx",
      "src/components/MarkSidebar.tsx",
    ]) {
      expect(
        readFileSync(join(ROOT, file), "utf8"),
        `${file} puts a second control in the row the tab strip needs; the toolbar already has this one`,
      ).not.toContain("preview.thumbnailsHide");
    }
  });

  it("lays the preview toolbar out in three columns that cannot overlap", () => {
    // The page controls were `position: absolute; left: 50%` — out of flow, so
    // the row placed the filename and the tool buttons as though the middle
    // group were not there, and it drew over both. At 900px, this app's own
    // minWidth, the three groups measured 228-361, 318-434 and 373-523: a click
    // at the centre of "Mark a region" landed on a page button.
    //
    // The first repair gave both sides `flex: 1 1 0`, which centred the middle
    // group correctly and squeezed the right column to 78px for 168px of
    // buttons — with `justify-content: flex-end` that overflows the *start*
    // edge, so the same two buttons were unreachable one layer further in.
    // Both halves are needed: sides that flex equally to keep the middle
    // centred, and a right column pinned to its content so it cannot be
    // squeezed into the middle.
    const css = readFileSync(join(ROOT, "src/styles/preview.css"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    const rule = (selector) => {
      const start = css.indexOf(`${selector} {`);
      expect(start, `${selector} not found`).toBeGreaterThan(-1);
      return css.slice(start, css.indexOf("}", start));
    };

    expect(
      rule(".preview-toolbar-center"),
      "out of flow, this group is free to draw on top of the two beside it",
    ).not.toMatch(/position:\s*absolute/);
    for (const side of [".toolbar-left", ".toolbar-right"]) {
      expect(rule(side), `${side} must share the slack so the middle stays centred`).toMatch(
        /flex:\s*1\s+1\s+0/,
      );
    }
    expect(
      rule(".toolbar-right"),
      "without this the buttons overflow leftward over the page controls",
    ).toMatch(/min-width:\s*max-content/);
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
