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
import { installTauriMock, sampleDocument } from "./ui-harness/tauri-mock.mjs";

// fileURLToPath, not `.pathname` — see scripts/css-hygiene.test.mjs for the two
// Windows release builds that idiom cost.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "docs/ui-shots");
const URL_BASE = process.env.PAGEWISE_DEV_URL ?? "http://localhost:1420/";
const FIXTURE = join(ROOT, "src-tauri/tests/fixtures/text-simple.pdf");

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

await page.keyboard.press("Control+,");
await page.waitForTimeout(1200);
await shoot(page, "03-settings");
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
await shoot(page, "04-answering");
await page.waitForTimeout(4000);
await shoot(page, "05-answered");

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
