#!/usr/bin/env node
/**
 * Open the app in a browser and photograph the screens a reader actually sees.
 *
 * Usage:
 *   npm run dev            # in one shell
 *   npm run ui:shots       # in another
 *
 * Writes PNGs to docs/ui-shots/. They are not committed and not diffed: this is
 * a way to LOOK at the app, not a pixel-regression gate. Cross-engine and
 * cross-machine rendering differences make pixel baselines flaky enough that
 * they get ignored, and an ignored check is worse than none.
 *
 * What holds the findings instead: the defects this harness turned up are
 * asserted as DOM invariants in the normal test suite (see
 * src/components/WelcomeView.test.tsx and ChatPanel's configure-affordance
 * test). Those run everywhere, cost nothing, and cannot be waved through.
 *
 * See scripts/ui-harness/tauri-mock.mjs for what is faked and what that costs.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { installTauriMock, sampleDocument, PAGE_RUNS } from "./ui-harness/tauri-mock.mjs";

// fileURLToPath, not `.pathname` — see scripts/css-hygiene.test.mjs for the two
// Windows release builds that idiom cost.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "docs/ui-shots");
const URL_BASE = process.env.PAGEWISE_DEV_URL ?? "http://localhost:1420/";
const FIXTURE = join(ROOT, "src-tauri/tests/fixtures/text-pages.pdf");

// The container ships a browser and tells Playwright not to fetch one; honour
// an explicit path when it is set and fall back to Playwright's own lookup.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;

/** One SSE chunk in the shape the OpenAI-compatible providers stream. */
const chunk = (delta, finish = null) =>
  `data: ${JSON.stringify({
    id: "harness",
    object: "chat.completion.chunk",
    created: 1,
    model: "harness",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

const TOOL_CALL_STREAM =
  chunk({
    role: "assistant",
    tool_calls: [
      { index: 0, id: "t1", type: "function", function: { name: "read_pdf_page", arguments: "" } },
    ],
  }) +
  chunk({ tool_calls: [{ index: 0, function: { arguments: '{"page":1}' } }] }) +
  chunk({}, "tool_calls") +
  "data: [DONE]\n\n";

const ANSWER_STREAM =
  chunk({ role: "assistant", content: "" }) +
  "On page 1, the text is the standard Lorem ipsum specimen used for typesetting — it carries no argument of its own."
    .split(" ")
    .map((w) => chunk({ content: `${w} ` }))
    .join("") +
  chunk({}, "stop") +
  "data: [DONE]\n\n";

/*
 * A second turn that writes to the record.
 *
 * `note_finding` carries a claim, the page, and the wording it rests on — and
 * that wording is really on page 1 of the fixture, so the whole chain runs for
 * real: the tool writes, `locateQuote` finds the words among the page's own
 * text runs, and `FindingLayer` underlines them. Nothing about the placement is
 * faked; only the provider is.
 */
const NOTE_CALL_STREAM =
  chunk({
    role: "assistant",
    tool_calls: [
      { index: 0, id: "t2", type: "function", function: { name: "note_finding", arguments: "" } },
    ],
  }) +
  chunk({
    tool_calls: [
      {
        index: 0,
        function: {
          arguments: JSON.stringify({
            pages: [1],
            claim: "Page 1 is filler text, not an argument.",
            evidence: "Lorem ipsum dolor sit amet, consetetur sadipscing",
          }),
        },
      },
    ],
  }) +
  chunk({}, "tool_calls") +
  "data: [DONE]\n\n";

const NOTED_STREAM =
  chunk({ role: "assistant", content: "" }) +
  "Recorded: page 1 is filler text rather than an argument."
    .split(" ")
    .map((w) => chunk({ content: `${w} ` }))
    .join("") +
  chunk({}, "stop") +
  "data: [DONE]\n\n";

const shots = [];

async function shoot(page, name) {
  mkdirSync(OUT, { recursive: true });
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path });
  shots.push(path);
  console.log(`  ${name}.png`);
}

const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const problems = [];
page.on("pageerror", (e) => problems.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") problems.push(m.text());
});

await page.addInitScript(installTauriMock, {
  pdfB64: readFileSync(FIXTURE).toString("base64"),
  doc: sampleDocument(),
  // Passed as data, not closed over: `addInitScript` serializes the function
  // body into the page, so a module-level constant would arrive undefined.
  runs: PAGE_RUNS,
  // A configured provider, so the composer is live rather than showing the
  // "Configure AI" state the other shots exercise.
  apiKey: "sk-harness",
  settings: {
    llm: {
      provider: "openai",
      model: "gpt-4o",
      connectionVerified: true,
      apiKeys: { openai: "sk-harness" },
    },
  },
});
await page.addInitScript((p) => {
  window.__HARNESS_OPEN_PATH__ = p;
}, FIXTURE);

console.log(`Photographing ${URL_BASE}`);
await page.goto(URL_BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await shoot(page, "01-welcome");

await page.getByRole("button", { name: /open document/i }).first().click();
await page.waitForTimeout(4000);
await shoot(page, "02-document");

// The page/outline/marks sidebar. It only exists for a multi-page document —
// PreviewToolbar hides the control behind `totalPages > 1` — which is why the
// harness needed a three-page fixture before this screen could be photographed
// at all.
await page.getByRole("button", { name: /thumbnails/i }).first().click();
await page.waitForTimeout(1500);
await shoot(page, "03-sidebar");
await page.getByRole("button", { name: /thumbnails/i }).first().click();
await page.waitForTimeout(600);

// Search before settings: 8.1.0's bug lived here, and a guard that never opens
// the surface it was written for is a guard in name only.
await page.keyboard.press("Control+f");
await page.waitForTimeout(500);
await page.keyboard.type("lorem");
await page.waitForTimeout(1000);
await shoot(page, "04-search");
await page.keyboard.press("Escape");
await page.waitForTimeout(400);

await page.keyboard.press("Control+,");
await page.waitForTimeout(1200);
await shoot(page, "05-settings");
await page.keyboard.press("Escape");
await page.waitForTimeout(600);

// A real answer, on the screen where the reader spends their time: a tool step,
// streamed prose, the pages-read footer. The provider is faked at the network
// edge rather than in the app, so everything from the transport inward — the
// tool loop, the streaming markdown split, the citation rendering — is the real
// code path.
await page.unroute("**/chat/completions").catch(() => {});
let turn = 0;
await page.route("**/chat/completions", async (route) => {
  turn += 1;
  await route.fulfill({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    body: turn === 1 ? TOOL_CALL_STREAM : ANSWER_STREAM,
  });
});

const composer = page.getByPlaceholder(/ask about this document/i);
await composer.click();
await composer.fill("What does this page say?");
await page.keyboard.press("Enter");
await page.waitForTimeout(1200);
await shoot(page, "06-answering");
await page.waitForTimeout(4000);
await shoot(page, "07-answered");

// The record, written and then placed. Turn 3 calls `note_finding`; turn 4 is
// the sentence that follows it.
await page.unroute("**/chat/completions").catch(() => {});
let noteTurn = 0;
await page.route("**/chat/completions", async (route) => {
  noteTurn += 1;
  await route.fulfill({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    body: noteTurn === 1 ? NOTE_CALL_STREAM : NOTED_STREAM,
  });
});

await composer.click();
await composer.fill("Note that down.");
await page.keyboard.press("Enter");
await page.waitForTimeout(5000);
// The underline on the page, drawn where the quoted words actually are.
await shoot(page, "08-finding-on-page");

await page.getByRole("tab", { name: /record/i }).first().click();
await page.waitForTimeout(1500);
await shoot(page, "09-record");
await page.getByRole("tab", { name: /^chat$/i }).first().click();
await page.waitForTimeout(600);

// The command palette and the marks sidebar. Neither was ever photographed,
// and both carry a "this one is selected" treatment of their own — which is
// the thing 11.0 is collapsing, so they have to be in the before-and-after.
await page.keyboard.press("Control+k");
await page.waitForTimeout(900);
await shoot(page, "10-palette");
await page.keyboard.press("Escape");
await page.waitForTimeout(500);

await page.getByRole("button", { name: /thumbnails/i }).first().click();
await page.waitForTimeout(1200);
await page.getByRole("tab", { name: /outline/i }).first().click();
await page.waitForTimeout(800);
await shoot(page, "11-outline");
await page.getByRole("tab", { name: /marks/i }).first().click();
await page.waitForTimeout(800);
await shoot(page, "12-marks");

await browser.close();

console.log(`\n${shots.length} shots in docs/ui-shots/`);

if (problems.length > 0) {
  // Loud, but not a failure: a console error here may be the harness rather
  // than the app, and a script that exits non-zero for its own mock would stop
  // being run. Read them.
  console.log(`\n${new Set(problems).size} distinct console/page error(s):`);
  for (const p of new Set(problems)) console.log(`  ${p}`);
} else {
  console.log("No console or page errors.");
}
