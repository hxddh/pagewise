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
};
console.log(JSON.stringify({ footerButtons, menuExports, paletteExports, dialogChoices, generalRows, aiRows, chipLevels }, null, 2));
let failed = 0;
for (const [name, ok] of Object.entries(results)) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failed += 1;
}
process.exit(failed ? 1 : 0);
