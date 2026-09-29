#!/usr/bin/env node
/**
 * Watch a scanned page become checkable (14.0): `npm run build`, then
 * `npm run audit:ocr`.
 *
 * The harness fixture is re-made as a scan — every page rendered to an image
 * and wrapped in a PDF with no text layer — and opened in the production
 * build, served with the app's own Content-Security-Policy on every response.
 * A scripted model reads page 2 and answers with two citations: one whose
 * words are printed there, one whose words are not. This checks, in a real
 * browser:
 *
 *   - OCR's worker, wasm core and language model load under the CSP, from
 *     the app's own origin, with no network;
 *   - the assistant's read of a scanned page is answered by OCR, not vision
 *     (the scripted model has a key, and no vision request may be made);
 *   - the printed quote's chip is `located`, the invented one `unconfirmed`
 *     — never `unlocated` — and the tally says so;
 *   - what OCR read is written to the per-document cache;
 *   - how long a page takes here.
 *
 * Not a CI check — it needs a browser and seconds of OCR per page.
 */
import { chromium } from "playwright";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installTauriMock, sampleDocument } from "./ui-harness/tauri-mock.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shots = join(root, "docs/ui-shots");
mkdirSync(shots, { recursive: true });
const log = (m) => console.error(`[ocr-audit] ${m}`);

// ------------------------------------------------------------ the scan
const scan = join(tmpdir(), "pagewise-ocr-audit-scan.pdf");
execFileSync("python3", [
  "-c",
  `
import sys, pypdfium2 as pdfium
src, out = sys.argv[1], sys.argv[2]
doc = pdfium.PdfDocument(src)
imgs = [doc[i].render(scale=200/72).to_pil().convert("RGB") for i in range(len(doc))]
imgs[0].save(out, save_all=True, append_images=imgs[1:], resolution=200)
`,
  join(root, "src-tauri/tests/fixtures/text-pages.pdf"),
  scan,
]);

// A scan, as the extractor reports one: pages, and no text on any of them.
const doc = sampleDocument();
doc.pages = doc.pages.map((p) => ({ ...p, text: "", needs_vision: true }));
doc.outline = [];

// ------------------------------------------------------------ the server
const csp = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8")).app.security.csp;
const PORT = 4174;
const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], {
  cwd: root,
  stdio: "ignore",
});
const stop = () => server.kill("SIGTERM");
process.on("exit", stop);
for (let i = 0; i < 60; i++) {
  try {
    await fetch(`http://localhost:${PORT}/`);
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 250));
  }
}

// ------------------------------------------------------------ the model
const chunk = (d, f = null) =>
  `data: ${JSON.stringify({ id: "h", object: "chat.completion.chunk", created: 1, model: "h",
    choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
const toolCall = (name, args) =>
  chunk({ role: "assistant", tool_calls: [{ index: 0, id: `t${Math.floor(Math.random() * 1e6)}`, type: "function",
    function: { name, arguments: "" } }] }) +
  chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }) +
  chunk({}, "tool_calls") + "data: [DONE]\n\n";
const answer = (t) => chunk({ role: "assistant", content: "" }) +
  (t.match(/.{1,7}/gsu) ?? []).map((w) => chunk({ content: w })).join("") + chunk({}, "stop") + "data: [DONE]\n\n";

const ANSWER =
  'Page two carries the filler text〔p2 "sed diam nonumy eirmod tempor invidunt ut labore on page 2"〕, ' +
  'and says revenue fell sharply〔p2 "revenue fell by twelve percent in the second quarter"〕.';

const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
const violations = [];
const consoleLines = [];
p.on("console", (m) => {
  consoleLines.push(`${m.type()}: ${m.text()}`);
  if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
});
const fail = async (what, err) => {
  await p.screenshot({ path: join(shots, "ocr-audit-failure.png") }).catch(() => {});
  log(`FAILED waiting for ${what}: ${err.message.split("\n")[0]}`);
  log(`console:\n  ${consoleLines.slice(-30).join("\n  ")}`);
  await b.close();
  stop();
  process.exit(1);
};
p.on("pageerror", (e) => violations.push(`pageerror: ${e.message}`));
p.on("worker", (w) => consoleLines.push(`worker started: ${w.url()}`));
p.on("requestfinished", (r) => {
  if (r.url().includes("/ocr/")) consoleLines.push(`fetched ${r.url()}`);
});
p.on("requestfailed", (r) => consoleLines.push(`request failed ${r.url()}: ${r.failure()?.errorText}`));

// Every response from the app's origin carries the app's CSP — workers
// included, which is stricter than the webview, where only the page does.
const external = [];
await ctx.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  if (url.host === `localhost:${PORT}`) {
    const res = await route.fetch();
    return route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": csp } });
  }
  if (url.pathname.endsWith("/chat/completions")) return route.fallback();
  external.push(url.href);
  return route.abort();
});

await p.addInitScript(installTauriMock, {
  pdfB64: readFileSync(scan).toString("base64"),
  apiKey: "sk-harness",
  doc,
  runsByPage: {},
  identity: "fnv1a64:0123456789abcdef:4242",
  settings: { llm: { provider: "openai", model: "gpt-4o", connectionVerified: true, apiKeys: { openai: "sk-harness" } } },
});
await p.addInitScript((x) => { window.__HARNESS_OPEN_PATH__ = x; }, scan);

const reqs = [];
let step = 0;
await p.route("**/chat/completions", async (route) => {
  const body = route.request().postDataJSON();
  reqs.push(body);
  const sse = { status: 200, headers: { "content-type": "text/event-stream" } };
  // A vision transcription request carries an image and no tools.
  if (!body.tools) return route.fulfill({ ...sse, body: answer("VISION WAS CALLED") });
  step += 1;
  if (step === 1) return route.fulfill({ ...sse, body: toolCall("read_pdf_page", { page: 2 }) });
  if (step === 2) return route.fulfill({ ...sse, body: answer(ANSWER) });
  return route.fulfill({ ...sse, body: answer("Understood.") });
});

p.setDefaultTimeout(60_000);
await p.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
await p.waitForTimeout(1100);
const opened = Date.now();
await p.getByRole("button", { name: /open document/i }).first().click();
log("opened a three-page scan");

// The page on screen is read first; its hint says so when it is done.
await p.getByText(/Read on this computer/i).first().waitFor({ timeout: 90_000 }).catch((e) => fail("the first page", e));
const firstPage = Date.now() - opened;
log(`first page read in ${(firstPage / 1000).toFixed(1)} s (worker start + model load included)`);
const hint = await p.getByText(/Read on this computer/i).first().textContent();
log(`hint: ${hint?.trim()}`);

const composer = p.getByPlaceholder(/ask about this document/i);
await composer.click();
await composer.fill("What does page two say?");
await p.keyboard.press("Enter");
await p.locator(".cite").nth(1).waitFor({ timeout: 90_000 }).catch((e) => fail("the answer's citations", e));
await p.waitForFunction(() => document.querySelectorAll(".cite-pending").length === 0, null, { timeout: 90_000 });

const chips = await p.locator(".cite").evaluateAll((els) =>
  els.map((e) => ({ cls: e.className, title: e.getAttribute("title") })),
);
const tally = (await p.locator(".citation-tally").first().textContent())?.trim();
await p.screenshot({ path: join(shots, "ocr-audit-answer.png") });

// Clicking the located chip turns to page 2 and lights the recognised words.
await p.locator(".cite-located").first().click();
const lit = await p
  .locator(".citation-highlight")
  .first()
  .waitFor({ timeout: 10_000 })
  .then(() => true, () => false);
await p.waitForTimeout(600);
await p.screenshot({ path: join(shots, "ocr-audit-highlight.png") });

// The tool result the model was handed for page 2.
const toolMsg = JSON.stringify(reqs.find((r) => JSON.stringify(r.messages).includes('"tool"'))?.messages ?? []);
const readByOcr = /\\"source\\":\\"ocr\\"/.test(toolMsg) || /"source":"ocr"/.test(toolMsg);

// Let the sweep finish the remaining page, then the cache flush.
await p.waitForTimeout(8_000);
const cache = await p.evaluate(() => [...window.__HARNESS_OCR_CACHE__.entries()]);
const stored = cache.length ? JSON.parse(cache[0][1]) : null;

const results = {
  located: chips.some((c) => c.cls.includes("cite-located")),
  highlighted: lit,
  unconfirmed: chips.some((c) => c.cls.includes("cite-unconfirmed")),
  neverUnlocated: !chips.some((c) => c.cls.includes("cite-unlocated")),
  readByOcr,
  noVision: !reqs.some((r) => !r.tools),
  noExternalFetch: external.length === 0,
  noCspViolation: violations.length === 0,
  cached: !!stored && stored.pages.length >= 2,
};
log(`chips: ${chips.map((c) => c.cls.replace("cite ", "")).join(", ")}`);
log(`tally: ${tally}`);
if (stored) {
  const ms = stored.pages.map((pg) => pg.ms).sort((a, c) => a - c);
  log(`cached ${stored.pages.length} page(s), confidence ${stored.pages.map((pg) => pg.c).join(" / ")}, ` +
    `per-page ms ${ms.join(" / ")} (median ${ms[Math.floor(ms.length / 2)]})`);
}
if (external.length) log(`external requests: ${external.join(", ")}`);
if (violations.length) log(`CSP/page errors:\n  ${violations.join("\n  ")}`);
for (const [k, v] of Object.entries(results)) log(`${v ? "PASS" : "FAIL"}  ${k}`);

await b.close();
stop();
process.exit(Object.values(results).every(Boolean) ? 0 : 1);
