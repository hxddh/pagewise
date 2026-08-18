#!/usr/bin/env node
/**
 * Print the request the provider actually receives, so it can be checked
 * against what the code intends to send.
 *
 * Usage:
 *   npm run dev              # in one shell
 *   npm run audit:request    # in another
 *
 * WHY THIS EXISTS. Two defects were found the same way and both were the same
 * shape — a feature wired end to end, dead at a seam, with passing tests on
 * both sides of it:
 *
 *   8.1.8  Page citations. `remarkPageRefs` had nine passing tests and produced
 *          the right link; react-markdown's URL sanitiser blanked the scheme, so
 *          no citation in any answer was ever clickable.
 *   9.1    The per-send hint. `appendContextToLastUserMessage` had eight passing
 *          tests and returned the right array; agent.ts assigned it to
 *          `messages`, and prepareCall reads `prompt`. Every hint — the active
 *          document, the page being viewed, the whole-document instructions —
 *          was built and discarded on every request.
 *
 * Neither is visible from either side's tests, because each side was correct.
 * Both were found by accident. This makes it deliberate.
 *
 * It is NOT a CI check: it needs the dev server and a browser, like ui-shots.
 * It is a thing to run when changing what gets sent, and to read.
 *
 * MEASURE BEFORE CONCLUDING. A message's `content` may be a string or an array
 * of parts. The first version of this script stringified the array, read
 * "[object Object]", and reported the hint as missing when it was there in
 * full — which would have been a false finding of exactly the kind it exists to
 * prevent. `textOf` below is that lesson.
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { installTauriMock, sampleDocument } from "/home/user/pagewise/scripts/ui-harness/tauri-mock.mjs";
const F = "/home/user/pagewise/src-tauri/tests/fixtures/text-pages.pdf";
const chunk = (d, f = null) =>
  `data: ${JSON.stringify({ id: "h", object: "chat.completion.chunk", created: 1, model: "h",
    choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
const toolCall = (name, args) =>
  chunk({ role: "assistant", tool_calls: [{ index: 0, id: `t${Math.floor(Math.random()*1e6)}`, type: "function",
    function: { name, arguments: "" } }] }) +
  chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }) +
  chunk({}, "tool_calls") + "data: [DONE]\n\n";
const answer = (t) => chunk({ role: "assistant", content: "" }) +
  t.split(" ").map((w) => chunk({ content: `${w} ` })).join("") + chunk({}, "stop") + "data: [DONE]\n\n";

const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.addInitScript(installTauriMock, {
  pdfB64: readFileSync(F).toString("base64"), apiKey: "sk-harness",
  doc: (() => {
    const d = sampleDocument();
    // ~6,000 characters, the size the compaction comment is written against.
    for (const pg of d.pages) pg.text = `# Section ${pg.page}\n\n` + "Lorem ipsum dolor sit amet, consetetur sadipscing elitr, sed diam nonumy eirmod tempor invidunt ut labore et dolore magna aliquyam erat. ".repeat(44);
    return d;
  })(),
  settings: { llm: { provider: "openai", model: "gpt-4o", connectionVerified: true, apiKeys: { openai: "sk-harness" } } },
});
await p.addInitScript((x) => { window.__HARNESS_OPEN_PATH__ = x; }, F);

const reqs = [];
let step = 0;
await p.route("**/chat/completions", async (route) => {
  reqs.push({ body: route.request().postDataJSON(), headers: route.request().headers() });
  step += 1;
  // A run long enough to exercise compaction: three page reads, then an answer.
  if (step <= 3) return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" },
    body: toolCall("read_pdf_page", { page: step }) });
  return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: answer("Done.") });
});

await p.goto("http://localhost:1420/", { waitUntil: "networkidle" });
await p.waitForTimeout(1100);
await p.getByRole("button", { name: /open document/i }).first().click();
await p.waitForTimeout(4000);
const composer = p.getByPlaceholder(/ask about this document/i);
await composer.click();
await composer.fill("Summarise pages 1 to 3.");
await p.keyboard.press("Enter");
await p.waitForTimeout(9000);
await b.close();

const first = reqs[0].body;
const last = reqs[reqs.length - 1].body;
console.log(`=== ${reqs.length} requests ===`);
console.log("top-level fields sent:", Object.keys(first).sort().join(", "));
console.log("");

const sys = (first.messages ?? []).filter((m) => m.role === "system");
console.log(`system messages: ${sys.length}`);
console.log(`  starts with "You are PageWise": ${/^You are PageWise/.test(String(sys[0]?.content ?? ""))}`);
console.log(`  length: ${String(sys[0]?.content ?? "").length} chars`);
console.log("");
console.log(`tools sent: ${(first.tools ?? []).length}`);
console.log(`  order: ${(first.tools ?? []).map((t) => t.function?.name).join(" → ")}`);
console.log("");
console.log(`max tokens field: ${["max_tokens","max_completion_tokens","maxOutputTokens"].map((k)=>`${k}=${first[k] ?? "—"}`).join("  ")}`);
console.log(`reasoning field:  ${["reasoning_effort","reasoning","thinking"].map((k)=>`${k}=${JSON.stringify(first[k]) ?? "—"}`).join("  ")}`);
console.log(`stream: ${first.stream}   model: ${first.model}   temperature: ${first.temperature ?? "—"}`);
console.log("");
// content may be a string OR an array of parts — an earlier version of this
// audit stringified the array and read "[object Object]", which looked exactly
// like a missing hint. Check the measurement before calling a defect.
const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((c) => (typeof c === "string" ? c : (c?.text ?? ""))).join("")
      : "";
const userMsgs = (first.messages ?? []).filter((m) => m.role === "user");
const tail = textOf(userMsgs[userMsgs.length - 1]?.content);
console.log(`per-send hint on the last user message: ${/Active document:/.test(tail)}`);
console.log(`  viewing-page line present: ${/viewing page/.test(tail)}`);
console.log(`  whole-document instructions: ${/whole-document request/.test(tail)}`);
console.log(`  hint length: ${Math.max(0, tail.length - "Summarise pages 1 to 3.".length)} chars`);
console.log(`  hint tail: ${JSON.stringify(tail.slice(-260))}`);
reqs.forEach((r, i) => {
  const us = (r.body.messages ?? []).filter((m) => m.role === "user");
  const t = textOf(us[us.length - 1]?.content);
  console.log(`  req${i} last user msg: ${t.length} chars, hasHint=${/Active document:/.test(t)}`);
});
console.log("");
const toolResults = (last.messages ?? []).filter((m) => m.role === "tool").map((m) => textOf(m.content));
console.log(`tool results in the final request: ${toolResults.length}`);
toolResults.forEach((t, i) => console.log(`  [${i}] ${t.length} chars — ${t.slice(0, 60).replace(/\n/g, " ")}`));
console.log("");
console.log(`auth header present: ${!!(reqs[0].headers.authorization || reqs[0].headers.Authorization)}`);
