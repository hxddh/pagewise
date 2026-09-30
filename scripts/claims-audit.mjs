#!/usr/bin/env node
/**
 * Watch a citation that is found but does not hold (15.0): `npm run dev`,
 * then `npm run audit:claims`.
 *
 * A scripted model answers with two citations whose words are both on page 2
 * of the harness fixture. One sentence states nothing the passage does not;
 * the other states a number ("5 times") that the passage never mentions. This
 * checks, in the running app, that
 *
 *   - the first chip is found, the second is "mismatch", naming the number;
 *   - the tally counts it, and "keep the verified" does not keep it;
 *   - the next question tells the model which number did not hold;
 *   - "Review citations" asks the model once per citation, with the passage,
 *     and each chip then carries the model's verdict.
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
/** A non-streamed structured reply, as generateObject asks for. */
const objectReply = (obj) => JSON.stringify({
  id: "r", object: "chat.completion", created: 1, model: "h",
  choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(obj) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
});

const ANSWER =
  'Page two opens with the filler text〔p2 "sed diam nonumy eirmod tempor invidunt ut labore on page 2"〕. ' +
  'Its closing phrase repeats the word labore 5 times〔p2 "invidunt ut labore on page 2"〕.';

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

const chats = [];
const reviews = [];
await p.route("**/chat/completions", async (route) => {
  const body = route.request().postDataJSON();
  if (!body.stream) {
    // A review: the sentence with a number the passage lacks is contradicted.
    const prompt = JSON.stringify(body.messages);
    reviews.push(prompt);
    const bad = prompt.includes("5 times");
    return route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: objectReply(bad
        ? { verdict: "contradicts", reason: "The passage says \"labore on page 2\" once; it gives no count." }
        : { verdict: "supports", reason: "The passage reads \"sed diam nonumy eirmod tempor invidunt ut labore\"." }),
    });
  }
  chats.push(body);
  return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" },
    body: answer(chats.length === 1 ? ANSWER : "Understood.") });
});

const log = (m) => console.error(`[claims] ${m}`);
p.setDefaultTimeout(15000);
await p.goto("http://localhost:1420/", { waitUntil: "load" });
await p.waitForTimeout(1100);
await p.getByRole("button", { name: /open document/i }).first().click();
await p.waitForTimeout(3000);
const composer = p.getByPlaceholder(/ask about this document/i);
await composer.click();
await composer.fill("What does page two say?");
await p.keyboard.press("Enter");
await p.waitForFunction(() => document.querySelectorAll("button.cite").length === 2 &&
  document.querySelectorAll("button.cite-pending").length === 0, null, { timeout: 20000 });
log("answered");

const chips = await p.$$eval("button.cite", (els) => els.map((e) => ({ cls: e.className, title: e.title })));
const tally = await p.$eval(".citation-tally", (e) => e.textContent).catch(() => "");
const keepLabel = await p.getByRole("button", { name: /keep the verified sentences/i }).getAttribute("aria-label").catch(() => "");

await p.getByRole("button", { name: /ask your model whether each passage supports/i }).click();
await p.waitForFunction(() => document.querySelectorAll("button.cite[class*=cite-review-]").length === 2, null, { timeout: 15000 });
const reviewed = await p.$$eval("button.cite", (els) => els.map((e) => ({ cls: e.className, title: e.title })));
await p.locator(".messages").screenshot({ path: join(shots, "claims-review.png") });

await composer.click();
await composer.fill("Are you sure about the count?");
await p.keyboard.press("Enter");
await p.waitForTimeout(3000);
await b.close();

const textOf = (content) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => c?.text ?? "").join("") : "";
const last = chats[chats.length - 1];
const users = (last?.messages ?? []).filter((m) => m.role === "user");
const hint = textOf(users[users.length - 1]?.content);

const results = {
  "the sentence without a stray number is found": /cite-located/.test(chips[0]?.cls ?? ""),
  "the sentence with '5 times' is found but doubted": /cite-mismatch/.test(chips[1]?.cls ?? "") && /cite-level-check/.test(chips[1]?.cls ?? ""),
  "its title names the number": /but 5 in this sentence is not in that passage/.test(chips[1]?.title ?? ""),
  "the tally counts it (16.0: in levels)": /1 verified/.test(tally ?? "") && /1 to check/.test(tally ?? ""),
  "keep-verified offers only the sound sentence": /\(1\)/.test(keepLabel ?? ""),
  "one review call per citation, each with its passage": reviews.length === 2 && reviews.every((r) => r.includes("Passage (page 2)")),
  "the chips carry the model's verdicts": /cite-review-supports/.test(reviewed[0]?.cls ?? "") && /cite-review-contradicts/.test(reviewed[1]?.cls ?? ""),
  "a contradicting verdict lowers the chip to not found (16.0)": /cite-level-notFound/.test(reviewed[1]?.cls ?? "") && /cite-level-verified/.test(reviewed[0]?.cls ?? ""),
  "the verdict's reason is in the title": /it gives no count/.test(reviewed[1]?.title ?? ""),
  "the next question names the number to the model": /5 in your sentence is not in that passage/.test(hint),
};
console.log(JSON.stringify({ chips, tally, keepLabel, reviewed }, null, 2));
let failed = 0;
for (const [name, ok] of Object.entries(results)) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failed += 1;
}
process.exit(failed ? 1 : 0);
