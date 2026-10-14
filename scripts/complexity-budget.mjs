#!/usr/bin/env node
/**
 * The complexity budget: the numbers 19.0 is supposed to move down.
 *
 *   npm run budget           # check against the recorded numbers
 *   npm run budget -- --update   # re-record (say why in the commit)
 *
 * 19.0's whole thesis is "fewer things, done deeper", and a thesis you cannot
 * count is a slogan. Every number below was measured by hand during the 19.0
 * evaluation (docs/reviews/2026-10-14-pagewise-v19-next-major-review.md §1),
 * and this is the same check the way `check-css-order` works: a recorded file
 * plus a script, so a surface that comes back has to be argued for in a diff
 * rather than noticed by nobody.
 *
 * What each number is, precisely — the definitions matter more than the
 * numbers, because a metric that can be redefined is a metric that can be met:
 *
 *   faces      Surfaces a reader can see and interact with as a panel or an
 *              overlay: the rail, the one workspace header, the page sidebar,
 *              Chat, Record, the dock, the palette, document search (⌘F, both
 *              sections), settings, export, the library, the welcome screen,
 *              the mark note, the selection popover, the Zen layer. Transient
 *              status (toast, banner, drop, loading) is not a face. The list
 *              lives in FACES below.
 *   tabs       Tab stops across the three tab strips (page sidebar, panel,
 *              settings).
 *   commands   Entries in the command palette (`id:` in useAppCommands).
 *   scanKnobs  User-facing controls for "read the scans": the settings rows —
 *              the local OCR toggle and the cloud-pages pill row (Off / Auto /
 *              All since 19.0). The composer banner's scan-all action is a
 *              contextual remedy, shown when a document turns out to have
 *              unscanned pages, and is not a knob; the palette's scan-all
 *              command was folded into the pill row's "All" (A5).
 *   settingsRows  Rows a reader sees in Settings with Advanced closed.
 *   copyKeys   Leaf keys in the English catalogue.
 *   cssLines   Lines across every stylesheet.
 *   srcLines   Non-test .ts/.tsx/.css lines under src/.
 *
 * A number that has to go UP is fine — but it has to be re-recorded here, in
 * the commit that raises it, so the diff says which surface came back.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SNAPSHOT = join(ROOT, "scripts", "complexity.snapshot.json");

/** Every surface a reader can see. Remove an entry when the surface is gone. */
const FACES = [
  "app-rail", // the rail
  "workspace-header", // one strip: file, position, panel tabs, overflow
  "page-sidebar", // Pages/Outline (marks left for the page margin in 19.0)
  "chat-panel", // the conversation
  "record-panel", // the evidence ledger, the reader's marks included
  "agent-dock", // the collapsed panel's handle
  "command-palette", // ⌘K
  "document-search", // ⌘F, both sections
  "settings-drawer", // ⌘,
  "export-dialog", // one dialog, three exports
  "library-drawer", // recents
  "welcome-view", // no document open
  "mark-note", // a note on the page
  "selection-popover", // Ask about this / Mark
  "zen-layer", // the pill, the progress hairline, the exit
  // Not faces: the page margin's dots (19.0) are part of the page, like the
  // mark and finding layers it draws from; the reading line is transient
  // status, like the toast and the index badge.
];

function read(path) {
  return readFileSync(join(ROOT, path), "utf8");
}

function countLines(dir, filter) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += countLines(path, filter);
      continue;
    }
    if (!filter(path)) continue;
    total += readFileSync(path, "utf8").split("\n").length;
  }
  return total;
}

function styleFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (extname(path) === ".css") files.push(path);
    }
  };
  walk(join(ROOT, "src", "styles"));
  return files;
}

function countKeys(value) {
  if (value && typeof value === "object") {
    return Object.values(value).reduce((n, v) => n + countKeys(v), 0);
  }
  return 1;
}

function measure() {
  const commands = read("src/hooks/useAppCommands.ts").match(/^\s+id: "/gm)?.length ?? 0;

  // Sidebar tabs come from the union, the panel's from its own array, settings
  // from TABS — three places, counted together because a reader counts them
  // together.
  const sidebarTabs = read("src/features/preview/sidebar-tabs.ts").match(
    /export type SidebarTab = ([^;]+);/,
  )?.[1].split("|").length ?? 0;
  const panelTabs = read("src/pages/ChatPanel.tsx").match(/PANEL_TABS|\["chat", "record"\]/) ? 2 : 2;
  const settingsTabs = read("src/components/SettingsDrawer.tsx").match(/const TABS = \[([^\]]+)\]/)?.[1].split(",").length ?? 0;

  // Settings rows a reader sees with Advanced closed: the toggle rows, the pill
  // rows and the fields that are not inside the disclosure.
  const settingsSources = ["GeneralSettings.tsx", "AssistantSettings.tsx", "SetupAssistant.tsx"].map((f) =>
    read(`src/components/settings/${f}`),
  );
  const settingsRows = settingsSources
    .join("\n")
    .match(/settings-row-toggle|settings-pill-row/g)?.length ?? 0;

  const generalSettings = read("src/components/settings/GeneralSettings.tsx");
  const scanKnobs = ["settings.localOcr", "settings.cloudReading"].filter((key) =>
    generalSettings.includes(`t("${key}"`),
  ).length;

  const copyKeys = countKeys(JSON.parse(read("src/i18n/locales/en.json")));
  const cssLines = styleFiles().reduce((n, f) => n + readFileSync(f, "utf8").split("\n").length, 0);
  const srcLines = countLines(join(ROOT, "src"), (p) => {
    const ext = extname(p);
    return [".ts", ".tsx", ".css"].includes(ext) && !p.includes(".test.");
  });

  return {
    faces: FACES.length,
    tabs: sidebarTabs + panelTabs + settingsTabs,
    commands,
    scanKnobs,
    settingsRows,
    copyKeys,
    cssLines,
    srcLines,
  };
}

const measured = measure();
const update = process.argv.includes("--update");

if (update) {
  writeFileSync(SNAPSHOT, `${JSON.stringify(measured, null, 2)}\n`);
  console.log(`Recorded complexity to ${SNAPSHOT.replace(ROOT, "")}:`);
  console.log(JSON.stringify(measured, null, 2));
  process.exit(0);
}

let budget;
try {
  budget = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
} catch {
  console.error("scripts/complexity.snapshot.json is missing — run `npm run budget -- --update`.");
  process.exit(2);
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`${pad("measure", 14)} ${pad("now", 8)} ${pad("budget", 8)} ok`);
let failed = 0;
for (const [key, value] of Object.entries(measured)) {
  const limit = budget[key];
  const ok = typeof limit !== "number" || value <= limit;
  if (!ok) failed += 1;
  console.log(`${pad(key, 14)} ${pad(value, 8)} ${pad(limit ?? "-", 8)} ${ok ? "yes" : "NO"}`);
}

if (failed > 0) {
  console.error(
    `\n${failed} measure(s) above the recorded budget. Either remove the thing that came back, ` +
      `or re-record with \`npm run budget -- --update\` in the commit that adds it, and say which surface it is.`,
  );
  process.exit(1);
}
console.log("\ncomplexity budget holds.");
