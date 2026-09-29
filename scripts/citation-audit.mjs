#!/usr/bin/env node
/**
 * Watch a citation go the whole way: `npm run dev`, then `npm run audit:citations`.
 *
 * A scripted model answers with three citations — one whose words are on the
 * page, one whose words are not, one naming a page the document does not have
 * — and this checks, in the running app, what the reader is shown and what the
 * model is told on the next question. Screenshots go to docs/ui-shots/.
 *
 * WHY IT EXISTS. 8.1.8 and 9.1 were both features correct on each side of a
 * seam and dead at it (see request-audit.mjs). A citation crosses four: the
 * stream, the Markdown plugin, the chip's check, and the note built at the
 * next send. Unit tests cover each; only this covers the joins.
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
const toolCall = (name, args) =>
  chunk({ role: "assistant", tool_calls: [{ index: 0, id: `t${Math.floor(Math.random() * 1e6)}`, type: "function",
    function: { name, arguments: "" } }] }) +
  chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }) +
  chunk({}, "tool_calls") + "data: [DONE]\n\n";
// Streamed in small pieces, so a marker arrives split across chunks the way a
// real stream splits it.
const answer = (t) => chunk({ role: "assistant", content: "" }) +
  (t.match(/.{1,7}/gsu) ?? []).map((w) => chunk({ content: w })).join("") + chunk({}, "stop") + "data: [DONE]\n\n";

const ANSWER =
  'Page two opens with the standard filler text〔p2 "sed diam nonumy eirmod tempor invidunt ut labore on page 2"〕. ' +
  'It also reports that revenue fell sharply〔p1 "revenue fell by twelve percent"〕, ' +
  'and the appendix gives the totals〔p9 "totals for the year"〕.';

const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.addInitScript(installTauriMock, {
  pdfB64: readFileSync(F).toString("base64"),
  apiKey: "sk-harness",
  doc: sampleDocument(),
  runs: PAGE_RUNS,
  settings: { llm: { provider: "openai", model: "gpt-4o", connectionVerified: true, apiKeys: { openai: "sk-harness" } } },
});
await p.addInitScript((x) => { window.__HARNESS_OPEN_PATH__ = x; }, F);

const reqs = [];
let step = 0;
await p.route("**/chat/completions", async (route) => {
  reqs.push(route.request().postDataJSON());
  step += 1;
  const sse = { status: 200, headers: { "content-type": "text/event-stream" } };
  if (step === 1) return route.fulfill({ ...sse, body: toolCall("read_pdf_page", { page: 2 }) });
  if (step === 2) return route.fulfill({ ...sse, body: answer(ANSWER) });
  return route.fulfill({ ...sse, body: answer("Understood.") });
});

const log = (m) => console.error(`[audit] ${m}`);
p.setDefaultTimeout(15000);
await p.goto("http://localhost:1420/", { waitUntil: "load" });
log("loaded");
await p.waitForTimeout(1100);
await p.getByRole("button", { name: /open document/i }).first().click();
await p.waitForTimeout(3000);
log("opened");
const composer = p.getByPlaceholder(/ask about this document/i);
await composer.click();
await composer.fill("What does page two say?");
await p.keyboard.press("Enter");
await p.waitForTimeout(6000);
log(`answered; requests=${reqs.length}`);

const chips = await p.$$eval("button.cite", (els) => els.map((e) => ({ label: e.textContent, cls: e.className, title: e.title })));
const tally = await p.$eval(".citation-tally", (e) => e.textContent).catch(() => null);
const rawLeft = await p.$$eval(".markdown", (els) => els.some((e) => /〔|〕/.test(e.textContent ?? "")));
await p.locator(".messages").screenshot({ path: join(shots, "citations-answer.png") });

await p.locator("button.cite-located").first().click();
await p.waitForTimeout(1200);
const lit = await p.$$eval(".citation-highlight", (els) => els.length);
await p.screenshot({ path: join(shots, "citations-highlight.png") });

await p.getByRole("button", { name: /keep the verified sentences \(1\)/i }).click();
await p.getByRole("tab", { name: /record/i }).click().catch(() => p.getByText(/^Record$/).first().click());
await p.waitForTimeout(1200);
const recordText = await p.locator(".record-panel, [class*=record]").first().innerText().catch(() => "");
await p.locator(".messages-panel, .chat-panel").first().screenshot({ path: join(shots, "citations-record.png") });
await p.getByRole("tab", { name: /chat/i }).click().catch(() => p.getByText(/^Chat$/).first().click());
await p.waitForTimeout(500);

// 14.1: the kept sentence, written into a copy of the PDF where its words are.
await p.evaluate(() => { window.__HARNESS_SAVE_PATH__ = "/harness/out/text-pages-annotated.pdf"; });
await p.getByRole("button", { name: /more/i }).first().click();
await p.getByRole("menuitem", { name: /export pdf with evidence/i }).click();
await p.waitForTimeout(1500);
const exported = await p.evaluate(() => window.__HARNESS_EXPORTS__ ?? []);
const annotations = exported[0]?.annotations ?? [];

await composer.click();
await composer.fill("And the totals?");
await p.keyboard.press("Enter");
await p.waitForTimeout(4000);
await b.close();

const textOf = (content) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => c?.text ?? "").join("") : "";
const sys = String((reqs[0].messages ?? []).find((m) => m.role === "system")?.content ?? "");
const last = reqs[reqs.length - 1];
const users = (last.messages ?? []).filter((m) => m.role === "user");
const hint = textOf(users[users.length - 1]?.content);

const results = {
  "system prompt carries the citation rule": /〔p12 "words copied exactly from page 12"〕/.test(sys),
  "three chips rendered": chips.length === 3,
  "no raw marker left in the answer": !rawLeft,
  "chip 1 located": /cite-located/.test(chips[0]?.cls ?? ""),
  "chip 2 unlocated": /cite-unlocated/.test(chips[1]?.cls ?? ""),
  "chip 3 out of range": /cite-outOfRange/.test(chips[2]?.cls ?? ""),
  "tally reads 1 of 3": /1 of 3/.test(tally ?? ""),
  "located chip lights the words": lit > 0,
  "next question tells the model p1 was not found": /p1 'revenue fell by twelve percent' — these words are not on that page/.test(hint),
  "next question tells the model p9 does not exist": /p9 'totals for the year' — that page does not exist/.test(hint),
  "keeping verified sentences records only the located one":
    /Page two opens with the standard filler text/.test(recordText) && !/revenue fell sharply/.test(recordText),
  "the kept sentence enters the record as found on its page": /Wording found on page 2/.test(recordText),
  "evidence export writes the kept sentence, on page 2, over its words":
    annotations.length === 1 &&
    annotations[0].page === 2 &&
    annotations[0].frame === "pdf" &&
    /Page two opens with the standard filler text/.test(annotations[0].contents) &&
    annotations[0].rects.some((r) => Math.abs(r.y - 640) < 1),
  "evidence export goes to a new file, not over the open one": exported[0]?.outPath === "/harness/out/text-pages-annotated.pdf",
  "the located citation is not reported": !/sed diam nonumy/.test(hint.split("In your previous answer")[1] ?? ""),
};
console.log(JSON.stringify({ chips, tally, recordText: recordText.slice(0, 400), annotations }, null, 2));
let failed = 0;
for (const [name, ok] of Object.entries(results)) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failed += 1;
}
process.exit(failed ? 1 : 0);
