#!/usr/bin/env node
/**
 * Watch a structured answer the whole way (14.1): `npm run dev`, then
 * `npm run audit:tables`.
 *
 * A scripted model asked to "tabulate" answers with a Markdown table whose
 * cells carry citations — three whose words are on their page, one whose
 * words are not. This checks, in the running app, that
 *
 *   - the system prompt asks for such tables;
 *   - the table renders, with a chip in each cited cell, coloured by the check;
 *   - "Export table" writes CSV with each row's sources and what was found;
 *   - "Keep the verified" keeps the fully verified row as its row, and leaves
 *     out the row with a quote that was not found.
 *
 * Not a CI check — it needs the dev server and a browser, like ui-shots.
 */
import { chromium } from "playwright";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installTauriMock, sampleDocument, PAGE_RUNS } from "./ui-harness/tauri-mock.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const F = join(root, "src-tauri/tests/fixtures/text-pages.pdf");
const shots = join(root, "docs/ui-shots");
mkdirSync(shots, { recursive: true });

const chunk = (d, f = null) =>
  `data: ${JSON.stringify({ id: "h", object: "chat.completion.chunk", created: 1, model: "h",
    choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
const answer = (t) => chunk({ role: "assistant", content: "" }) +
  (t.match(/.{1,9}/gsu) ?? []).map((w) => chunk({ content: w })).join("") + chunk({}, "stop") + "data: [DONE]\n\n";

const ANSWER = [
  "I read pages 1 and 2.",
  "",
  "| Page | Opens with | Ends with |",
  "|---|---|---|",
  '| 1 | Lorem ipsum〔p1 "Lorem ipsum dolor sit amet"〕 | labore〔p1 "invidunt ut labore on page 1"〕 |',
  '| 2 | Lorem ipsum〔p2 "Lorem ipsum dolor sit amet"〕 | a decline〔p2 "revenue fell by twelve percent"〕 |',
  "",
].join("\n");

const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.addInitScript(installTauriMock, {
  pdfB64: readFileSync(F).toString("base64"),
  apiKey: "sk-harness",
  doc: sampleDocument(),
  runs: PAGE_RUNS,
  settings: { llm: { provider: "openai", model: "gpt-4o", connectionVerified: true, apiKeys: { openai: "sk-harness" } } },
});
await p.addInitScript((x) => { window.__HARNESS_OPEN_PATH__ = x; window.__HARNESS_SAVE_PATH__ = "/harness/out/table.csv"; }, F);

const reqs = [];
await p.route("**/chat/completions", async (route) => {
  reqs.push(route.request().postDataJSON());
  return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: answer(ANSWER) });
});

const log = (m) => console.error(`[tables] ${m}`);
p.setDefaultTimeout(15000);
await p.goto("http://localhost:1420/", { waitUntil: "load" });
await p.waitForTimeout(1100);
await p.getByRole("button", { name: /open document/i }).first().click();
await p.waitForTimeout(3000);
const composer = p.getByPlaceholder(/ask about this document/i);
await composer.click();
await composer.fill("Tabulate how each page opens and ends.");
await p.keyboard.press("Enter");
await p.waitForFunction(() => document.querySelectorAll("table button.cite").length === 4 &&
  document.querySelectorAll("button.cite-pending").length === 0, null, { timeout: 20000 });
log("answered");

const cells = await p.$$eval("table button.cite", (els) => els.map((e) => e.className.replace("cite ", "")));
await p.locator(".messages").screenshot({ path: join(shots, "tables-answer.png") });

// 16.0: the table's CSV is in the answer's More menu.
await p.getByRole("button", { name: /more for this answer/i }).last().click();
await p.getByRole("menuitem", { name: /export table as csv/i }).click();
await p.waitForTimeout(1500);
const writes = await p.evaluate(() => window.__HARNESS_WRITES__ ?? []);
const csv = writes.find((w) => w.path === "/harness/out/table.csv")?.content ?? "";

await p.getByRole("button", { name: /keep the verified sentences/i }).click();
await p.getByRole("tab", { name: /record/i }).click().catch(() => p.getByText(/^Record$/).first().click());
await p.waitForTimeout(1200);
const recordText = await p.locator(".record-panel, [class*=record]").first().innerText().catch(() => "");
await b.close();

const sys = String((reqs[0]?.messages ?? []).find((m) => m.role === "system")?.content ?? "");
const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
const results = {
  "system prompt asks for cited tables": /answer with a Markdown table: one row per item/.test(sys),
  "a chip in each cited cell": cells.length === 4,
  "three found, one not": cells.filter((c) => c.includes("cite-located")).length === 3 && cells.some((c) => c.includes("cite-unlocated")),
  "CSV header adds sources and checked": lines[0] === "Page,Opens with,Ends with,Sources,Checked",
  "CSV row 1: both quotes found": lines[1] === "1,Lorem ipsum,labore,p. 1 Verified (found); p. 1 Verified (found),2 of 2 found",
  "CSV row 2: one not found": lines[2] === "2,Lorem ipsum,a decline,p. 2 Verified (found); p. 2 Not found (not found),1 of 2 found",
  "CSV carries a byte-order mark for spreadsheets": csv.startsWith("﻿"),
  "the verified row is kept as its row": /Page: 1 · Opens with: Lorem ipsum · Ends with: labore/.test(recordText),
  "the row with a quote not found is not kept": !/a decline/.test(recordText),
};
console.log(JSON.stringify({ cells, csv, recordText: recordText.slice(0, 300) }, null, 2));
let failed = 0;
for (const [name, ok] of Object.entries(results)) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failed += 1;
}
process.exit(failed ? 1 : 0);
