#!/usr/bin/env node
/**
 * Count what a reader is shown (16.0): `npm run dev`, then `npm run ui:inventory`.
 *
 * 16.0 set numbers for how much the app puts in front of a reader, and these
 * are counted from the running app rather than from the source, where a
 * control behind a condition is easy to miss:
 *
 *   - under an answer: at most 4 visible buttons;
 *   - one export entry in the chat menu and one in the palette, both opening
 *     the same dialog of three;
 *   - at most 12 settings rows across General and AI Provider;
 *   - citation chips in at most three levels (plus the unmarked "none").
 *
 * A scripted model answers with a table and three citations — found, found
 * with a number the passage lacks, and not found — so every footer action
 * that can appear does.
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installTauriMock, sampleDocument, PAGE_RUNS } from "./ui-harness/tauri-mock.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const F = join(root, "src-tauri/tests/fixtures/text-pages.pdf");

const chunk = (d, f = null) =>
  `data: ${JSON.stringify({ id: "h", object: "chat.completion.chunk", created: 1, model: "h", choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
const answer = (t) =>
  chunk({ role: "assistant", content: "" }) +
  (t.match(/.{1,9}/gsu) ?? []).map((w) => chunk({ content: w })).join("") +
  chunk({}, "stop") +
  "data: [DONE]\n\n";

const ANSWER = [
  "## What page two says",
  "",
  'Page two opens with filler text〔p2 "sed diam nonumy eirmod tempor invidunt ut labore on page 2"〕, and repeats labore 5 times〔p2 "invidunt ut labore on page 2"〕.',
  "",
  "| Page | Says |",
  "|---|---|",
  '| 1 | lorem〔p1 "Lorem ipsum dolor sit amet"〕 |',
  '| 3 | a decline〔p3 "revenue fell sharply in the third quarter"〕 |',
].join("\n");

const b = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || "/opt/pw-browsers/chromium" });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.addInitScript(installTauriMock, {
  pdfB64: readFileSync(F).toString("base64"),
  apiKey: "sk-harness",
  doc: sampleDocument(),
  runs: PAGE_RUNS,
  settings: { llm: { provider: "openai", model: "gpt-4o", connectionVerified: true, apiKeys: { openai: "sk-harness" } } },
});
await p.addInitScript((x) => {
  window.__HARNESS_OPEN_PATH__ = x;
}, F);
await p.route("**/chat/completions", (route) =>
  route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: answer(ANSWER) }),
);

p.setDefaultTimeout(15000);
await p.goto(process.env.PAGEWISE_DEV_URL ?? "http://localhost:1420/", { waitUntil: "load" });
await p.waitForTimeout(1100);
await p.getByRole("button", { name: /open document/i }).first().click();
await p.waitForTimeout(3000);
const composer = p.getByPlaceholder(/ask about this document/i);
await composer.click();
await composer.fill("What does page two say?");
await p.keyboard.press("Enter");
await p.waitForFunction(
  () => document.querySelectorAll("button.cite").length >= 4 && document.querySelectorAll("button.cite-pending").length === 0,
  null,
  { timeout: 20000 },
);
await p.waitForTimeout(500);

const visible = (els) => els.filter((e) => e.offsetParent !== null).length;
const footerButtons = await p.$$eval(".message-assistant-actions button", visible);
const chipLevels = await p.$$eval("button.cite", (els) => [
  ...new Set(els.flatMap((e) => [...e.classList].filter((c) => c.startsWith("cite-level-")))),
]);

/*
 * The reading surface (17.0), measured rather than asserted in a stylesheet:
 * how wide the answer's column opens, whether its headings step, whether a
 * table has rules, and whether the two labelled actions under an answer are
 * readable text. All four were defects found by measurement — 45 characters a
 * line, `1em` headings, no `.markdown table` rule at all, and an 11px/3.96:1
 * "Copy"/"Keep" — so they are counting invariants now, not intentions.
 */
const reading = await p.evaluate(() => {
  const px = (v) => parseFloat(v) || 0;
  const toRgb = (s) => {
    const m = /rgba?\(([^)]+)\)/.exec(s);
    if (!m) return { r: 0, g: 0, b: 0, a: 1 };
    const parts = m[1].split(",").map(Number);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const bgOf = (el) => {
    let n = el;
    while (n) {
      const c = toRgb(getComputedStyle(n).backgroundColor);
      if (c.a > 0.95) return c;
      n = n.parentElement;
    }
    return { r: 0, g: 0, b: 0, a: 1 };
  };
  const body = document.querySelector(".markdown p");
  const h2 = document.querySelector(".markdown h2");
  const td = document.querySelector(".markdown td");
  const column = document.querySelector(".chat-column");
  const label = document.querySelector(".message-action-labelled");
  return {
    columnWidth: column ? Math.round(column.getBoundingClientRect().width) : 0,
    bodySize: body ? px(getComputedStyle(body).fontSize) : 0,
    h2Size: h2 ? px(getComputedStyle(h2).fontSize) : 0,
    cellPadding: td ? px(getComputedStyle(td).paddingLeft) : 0,
    cellRule: td ? px(getComputedStyle(td).borderBottomWidth) : 0,
    actionSize: label ? px(getComputedStyle(label).fontSize) : 0,
    actionContrast: label ? ratio(toRgb(getComputedStyle(label).color), bgOf(label)) : 0,
  };
});

// The chat menu: how many rows export.
await p.locator(".panel-header").getByRole("button", { name: /^more actions$/i }).click();
const menuExports = await p.$$eval("[role=menuitem]", (els) => els.filter((e) => /export/i.test(e.textContent ?? "")).length);
await p.keyboard.press("Escape");

// The palette: how many commands export.
await p.keyboard.press("Control+k");
await p.getByPlaceholder(/type a command/i).fill("export");
const paletteExports = await p.$$eval("[role=option]", (els) => els.length);
await p.keyboard.press("Enter");
await p.waitForSelector(".export-panel");
const dialogChoices = await p.$$eval(".export-option", (els) => els.length);
await p.keyboard.press("Escape");

// Settings: rows on the two pages a reader configures.
await p.keyboard.press("Control+,");
await p.waitForTimeout(800);
const rowSelector = ".settings-row-toggle, .settings-pill-row, .ui-field";
const countRows = () => p.$$eval(rowSelector, visible);
await p.getByRole("tab", { name: /general/i }).click().catch(() => p.getByText(/^General$/).first().click());
await p.waitForTimeout(400);
const generalRows = await countRows();
await p.getByRole("tab", { name: /ai provider/i }).click().catch(() => p.getByText(/^AI Provider$/).first().click());
await p.waitForTimeout(400);
const aiRows = await countRows();
await b.close();

const results = {
  "under an answer: at most 4 buttons": footerButtons <= 4,
  "one export entry in the chat menu": menuExports === 1,
  "one export command in the palette": paletteExports === 1,
  "the export dialog offers three": dialogChoices === 3,
  "settings: at most 12 rows": generalRows + aiRows <= 12,
  "citations in at most three levels": chipLevels.filter((l) => l !== "cite-level-none").length <= 3,
  "reading column at least 420px": reading.columnWidth >= 420,
  "answer headings step by 1.2x the body": reading.bodySize > 0 && reading.h2Size / reading.bodySize >= 1.2,
  "answer tables are ruled": reading.cellPadding >= 6 && reading.cellRule >= 1,
  "answer actions: 12px and 4.5:1": reading.actionSize >= 12 && reading.actionContrast >= 4.5,
};
console.log(
  JSON.stringify(
    { footerButtons, menuExports, paletteExports, dialogChoices, generalRows, aiRows, chipLevels, reading },
    null,
    2,
  ),
);
let failed = 0;
for (const [name, ok] of Object.entries(results)) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failed += 1;
}
process.exit(failed ? 1 : 0);
