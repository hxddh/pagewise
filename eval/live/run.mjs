#!/usr/bin/env node
/**
 * Ask a real model the evaluation's questions, through the app as it ships.
 *
 *   npm run dev                                  # in one shell
 *   npm run eval                                 # once, to extract the corpus
 *   PW_EVAL_BASE_URL=https://api.openai.com/v1 \
 *   PW_EVAL_API_KEY=sk-… PW_EVAL_MODEL=gpt-4o-mini \
 *   npm run eval:live -- --docs=contract-zh,paper-en --limit=10
 *
 * Then `npm run eval` scores every recording under eval/out/live/.
 *
 * WHY THROUGH THE APP. The agent is not a function that can be called: its
 * system prompt, tools, read budget, record note and citation feedback are
 * assembled across a dozen modules at send time, and a harness that rebuilt
 * that assembly would measure the harness. So this drives the real UI in
 * Chromium, with the Tauri shell mocked from `eval/extract`'s output for the
 * document — its page text AND its text runs, so citations are checked
 * against the same runs the desktop app would use — and forwards the app's
 * model requests to the provider named in the environment.
 *
 * With no API key it runs a scripted model instead, which cites the right
 * page correctly once and a wrong quote once, so the whole path — stream,
 * chips, recording, scoring — can be checked without spending anything.
 *
 * The key is read from the environment only, sent only to PW_EVAL_BASE_URL,
 * and never written to a recording.
 */
import { chromium } from "playwright";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installTauriMock } from "../../scripts/ui-harness/tauri-mock.mjs";
import { QUESTIONS } from "../questions.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const BASE = (process.env.PW_EVAL_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
const KEY = process.env.PW_EVAL_API_KEY ?? "";
const MODEL = process.env.PW_EVAL_MODEL ?? (KEY ? "gpt-4o-mini" : "scripted");
const SCRIPTED = !KEY;
const APP = process.env.PW_EVAL_APP ?? "http://localhost:1420/";
const PER_QUESTION_MS = Number(arg("timeout") ?? 240_000);

const docsFilter = arg("docs")?.split(",");
const limit = Number(arg("limit") ?? (SCRIPTED ? 3 : Infinity));
const questions = QUESTIONS.filter((q) => !docsFilter || docsFilter.includes(q.doc)).slice(0, limit);

const outDir = join(root, "eval/out/live");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outFile = arg("out") ?? join(outDir, `${MODEL.replace(/[^\w.-]+/g, "_")}-${stamp}.jsonl`);

function pdfFor(doc) {
  for (const dir of ["eval/corpus", "eval/corpus/fetched"]) {
    const f = join(root, dir, `${doc}.pdf`);
    if (existsSync(f)) return f;
  }
  return null;
}

function dumpFor(doc) {
  const f = join(root, "eval/out", `${doc}.dump.json`);
  if (!existsSync(f)) throw new Error(`${f} is missing — run \`npm run eval\` first to extract the corpus.`);
  return JSON.parse(readFileSync(f, "utf8"));
}

/** The document the mocked shell reports, and the runs of every page. */
function mockDocument(dump) {
  const doc = {
    page_count: dump.page_count,
    title: null,
    pages: dump.pages.map((p) => ({ page: p.page, text: p.text, needs_vision: p.needs_vision, has_table: /\n\|/.test(p.text) })),
    outline: [],
    structure_outline: [],
    links: [],
    figures: [],
  };
  const runsByPage = Object.fromEntries(dump.pages.map((p) => [p.page, p.items]));
  return { doc, runsByPage };
}

// ---- the scripted model, for a run with no key --------------------------------

const chunk = (d, f = null) =>
  `data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 1, model: "scripted",
    choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
const toolCallSse = (name, args) =>
  chunk({ role: "assistant", tool_calls: [{ index: 0, id: `t${Math.floor(Math.random() * 1e6)}`, type: "function",
    function: { name, arguments: JSON.stringify(args) } }] }) + chunk({}, "tool_calls") + "data: [DONE]\n\n";
const answerSse = (t) => chunk({ role: "assistant", content: t }) + chunk({}, "stop") + "data: [DONE]\n\n";

function scriptedReply(step, q, dump) {
  if (step === 1) return toolCallSse("search_in_document", { query: q.query });
  const squash = (s) => s.normalize("NFKC").toLowerCase().replace(/[\s\-­‐-—'"‘’“”]/g, "");
  const page = dump.pages.find((p) => squash(p.text).includes(squash(q.answer)))?.page ?? 1;
  return answerSse(
    `From the document: ${q.answer}〔p${page} "${q.answer}"〕. ` +
      `It does not say the moon is made of cheese〔p${page} "the moon is made of cheese"〕.`,
  );
}

// ---- one question ----------------------------------------------------------------

/** The assistant text an SSE body carries. */
function textOfSse(body) {
  let out = "";
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
    try {
      const j = JSON.parse(line.slice(6));
      out += j.choices?.[0]?.delta?.content ?? "";
    } catch {
      /* a keep-alive or a partial line */
    }
  }
  return out;
}

function usageOfSse(body) {
  let usage = null;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
    try {
      const j = JSON.parse(line.slice(6));
      if (j.usage) usage = j.usage;
    } catch {
      /* ignore */
    }
  }
  return usage;
}

async function ask(browser, q) {
  const pdf = pdfFor(q.doc);
  if (!pdf) return null;
  const dump = dumpFor(q.doc);
  const { doc, runsByPage } = mockDocument(dump);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await context.newPage();
  await p.addInitScript(installTauriMock, {
    pdfB64: readFileSync(pdf).toString("base64"),
    apiKey: "sk-eval-placeholder",
    doc,
    runsByPage,
    settings: {
      llm: { provider: "openai", model: SCRIPTED ? "gpt-4o" : MODEL, connectionVerified: true, apiKeys: { openai: "sk-eval-placeholder" } },
    },
  });
  await p.addInitScript((x) => { window.__HARNESS_OPEN_PATH__ = x; }, pdf);

  const steps = [];
  let answered = null;
  const done = new Promise((resolve) => (answered = resolve));
  await p.route("**/chat/completions", async (route) => {
    const body = route.request().postDataJSON();
    const step = steps.length + 1;
    let sse;
    if (SCRIPTED) {
      sse = scriptedReply(step, q, dump);
    } else {
      body.model = MODEL;
      body.stream_options = { include_usage: true };
      const res = await route.fetch({
        url: `${BASE}/chat/completions`,
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
        postData: JSON.stringify(body),
        timeout: PER_QUESTION_MS,
      });
      sse = await res.text();
      if (!res.ok()) {
        steps.push({ error: `HTTP ${res.status()}`, body: sse.slice(0, 500) });
        await route.fulfill({ status: res.status(), headers: { "content-type": "application/json" }, body: sse });
        answered({ error: `HTTP ${res.status()}` });
        return;
      }
    }
    const text = textOfSse(sse);
    steps.push({ step, text: text.slice(0, 20_000), usage: usageOfSse(sse), toolCall: /"tool_calls"/.test(sse) });
    await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: sse });
    if (/"finish_reason":"stop"/.test(sse)) answered({ text });
  });

  await p.goto(APP, { waitUntil: "load" });
  await p.waitForTimeout(1000);
  await p.getByRole("button", { name: /open document/i }).first().click();
  await p.waitForTimeout(2500);
  const composer = p.getByPlaceholder(/ask about this document|询问这份文档/i);
  await composer.click();
  await composer.fill(q.question);
  await p.keyboard.press("Enter");

  let timer;
  const result = await Promise.race([
    done,
    new Promise((r) => (timer = setTimeout(() => r({ error: "timeout" }), PER_QUESTION_MS))),
  ]);
  clearTimeout(timer);
  // Give the chips their checks.
  await p.waitForTimeout(2000);
  const chips = await p.$$eval("button.cite", (els) => els.map((e) => ({ label: e.textContent, status: e.className.replace(/^cite cite-/, ""), title: e.title })));
  const tally = await p.$eval(".citation-tally", (e) => e.textContent).catch(() => null);
  await context.close();
  return {
    doc: q.doc,
    question: q.question,
    answerWording: q.answer,
    model: MODEL,
    answer: result.text ?? "",
    error: result.error ?? null,
    steps: steps.length,
    usage: steps.map((s) => s.usage).filter(Boolean),
    chips,
    tally,
  };
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium" });
const lines = [];
for (const q of questions) {
  process.stderr.write(`[${lines.length + 1}/${questions.length}] ${q.doc}: ${q.question}\n`);
  const rec = await ask(browser, q);
  if (!rec) {
    process.stderr.write(`  skipped — ${q.doc}.pdf not present (run npm run eval:fetch)\n`);
    continue;
  }
  lines.push(JSON.stringify(rec));
  process.stderr.write(`  ${rec.error ?? `${rec.chips.length} citations: ${rec.chips.map((c) => c.status).join(", ") || "none"}`}\n`);
  writeFileSync(outFile, lines.join("\n") + "\n");
}
await browser.close();
console.log(`recorded ${lines.length} answers to ${outFile}`);
