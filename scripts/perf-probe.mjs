#!/usr/bin/env node
/**
 * The running app's performance, measured the same way every time.
 *
 *   npm run build
 *   npm run perf            # writes .perf/report.json, prints a table
 *
 * What this is: a regression gate, not a benchmark. Every number here was first
 * measured by hand during the 18.0 evaluation (docs/reviews/2026-10-14-pagewise
 * -v18-next-major-review.md §1.2), and the budgets below are those numbers with
 * room for a slower machine — roughly 2.5–3×, because a runner is not this
 * development machine and a gate that flakes is a gate people delete. A real
 * regression (an unvirtualized list, a re-render per stream chunk, a full-page
 * re-raster per scroll tick) is a 5–50× change, not a 20% one.
 *
 * What it measures, and why each one is here:
 *
 *   boot          — first contentful paint and the welcome screen's button, on
 *                   the production build served from disk.
 *   open          — a 120-page text PDF: click "Open document" to the first
 *                   rasterized canvas and to an active text layer.
 *   scrollReading — 80px a frame for 60 frames (reading pace): frame intervals,
 *                   dropped frames, long tasks, mounted page slots.
 *   scrollFling   — 500px a frame (a trackpad fling, ~30,000px/s).
 *   flingSettle   — how long after a fling every mounted page has its raster.
 *   jumpToEnd     — one scroll assignment to the last page, then long tasks.
 *   thumbnails    — first thumbnail painted, and how many of 120 items exist
 *                   (the sidebar is windowed; a regression here mounts 120).
 *   search        — a 500-page document, ⌘F, first hit located.
 *   answer        — a streamed answer over the real transport: time to the tool
 *                   step, to the first characters, frames during the stream,
 *                   long tasks, heap after.
 *   longchat      — 100 turns of history: render on open, scroll frames, and
 *                   the request body the next question sends.
 *   largefile     — a 30-page image-only PDF (the shape of a scan): first
 *                   raster, and the text layer, which is the local OCR path.
 *                   The file is ~2MB rather than tens of megabytes on purpose:
 *                   the mocked shell hands bytes to the page as a JavaScript
 *                   array, not Tauri's raw IPC response, so a 50MB fixture
 *                   would measure the harness. The bounded caches in
 *                   src/lib/pdf.ts (128MB of bitmaps, three documents of
 *                   bytes) still get exercised by the scroll scenarios.
 *   idle          — main-thread work per second with the document open and
 *                   nothing happening, read from the DevTools protocol's
 *                   TaskDuration (22.0), with the probe's own frame recorder
 *                   stopped.
 *   geometry      — `getPageGeometry` calls per mounted page once the open
 *                   settles: each overlay layer asks on its own (22.0).
 *   flingRasters  — pages rasterized from the end of a fling to the settle:
 *                   the end of "hurry" re-renders what was drawn rough, and
 *                   the question is whether it re-renders more (22.0).
 *   outline       — a 1,000-entry outline (the Rust cap on a synthesized
 *                   one): time to the first row, rows mounted, long tasks.
 *   bm25          — `rankPages` over 500 pages, in Node: the first call builds
 *                   the index (what each newly indexed page costs the next
 *                   search), the second reads it.
 *
 * It does NOT measure WebKitGTK, WebView2 or a real window: Chromium here,
 * a mocked Tauri shell (scripts/ui-harness/tauri-mock.mjs), no Rust. The model
 * is a local SSE server, so "time to first token" is transport plus render, not
 * a provider's latency.
 *
 * The document is generated at run time (Chromium's own `page.pdf()` prints it)
 * rather than committed: a 120-page fixture in git would be a binary nobody can
 * read, and its text has to match what the mocked shell reports anyway — one
 * generator produces both, so they cannot drift.
 */
import { chromium } from "playwright";
import { installTauriMock } from "./ui-harness/tauri-mock.mjs";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist");
const OUT_DIR = join(ROOT, ".perf");
const WORK = join(tmpdir(), "pagewise-perf");
const CHROME = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;

/** Budgets: the measured value with room for a slower machine. See the header. */
const BUDGETS = {
  bootAppReadyMs: 800,
  openFirstRasterMs: 2000,
  openFirstTextLayerMs: 2600,
  scrollP95Ms: 25,
  scrollFramesOver50: 1,
  scrollLongTasks: 1,
  // A fling is allowed to drop a frame or two on a busy machine — 33ms is two
  // refresh intervals, not a stall. The regression this catches is a page
  // rasterized on the scroll path: 100ms+ frames, or a settle that never ends.
  flingP95Ms: 40,
  flingFramesOver50: 1,
  settleMs: 1500,
  jumpLongTasks: 1,
  thumbFirstMs: 600,
  thumbItemsMax: 40,
  searchFirstHitMs: 1200,
  answerFirstTextMs: 1200,
  answerP95Ms: 25,
  answerLongTasks: 3,
  longchatRenderMs: 3000,
  // 200 messages scrolled by rAF: the same one-or-two-dropped-frames allowance
  // as the fling. Measured 16.8ms on an idle machine, 33.2ms once when the
  // probe's four scenarios shared it — a gate that fails on that is a gate
  // someone deletes.
  longchatScrollP95Ms: 40,
  longchatRequestBytesMax: 40_000,
  largeFileFirstRasterMs: 6000,
  // The image-only document's text layer only activates once local OCR has
  // read the page — 13s for the first page here. That is the OCR path, not the
  // raster path, and it is budgeted so a change that makes OCR never finish
  // (the failure mode: a text layer that waits forever) fails the gate.
  largeFileFirstTextLayerMs: 40_000,
  heapAfterAnswerMb: 120,
  // 22.0's measurements, each recorded first (docs/reviews/2026-10-15-pagewise
  // -v22-evaluation.md §3.3 item 12) and given the same room. None was over
  // what it is compared with, so none was "fixed".
  //
  // Measured 2.3ms/s with the recorder stopped: nothing polls or animates
  // while a document sits open. A spinner or an interval left running is
  // tens of ms/s.
  idleCpuMsPerS: 8,
  // 1.5 with one overlay (a link) on every page: 3 calls for 2 mounted pages.
  // Each layer with something to draw asks once; a layer asking per render
  // is the regression.
  geometryPerPageMax: 3,
  // 1.0: the end of "hurry" re-renders each mounted page once, at full
  // quality — the pages it drew rough. Twice is the waste the 20.0 review
  // feared and the effect deps would allow.
  flingRastersPerSlotMax: 2,
  // 1,000 rows mounted, not windowed: 243–337ms to the first row and one
  // long task (186ms). Under the thumbnails' 600ms, so windowing waits.
  outlineFirstRowMs: 900,
  outlineLongTasks: 2,
  // 130–157ms to build the index over 500 pages; 1.4ms to read it. Every
  // newly indexed page makes the next agent search build it again.
  bm25BuildMs: 450,
};

// ---------------------------------------------------------------- fixtures
const WORDS =
  "the quick brown fox jumps over a lazy dog while readers annotate margins and researchers verify claims against the page they came from a table of measurements records each run and the method stays visible so anyone can reproduce it".split(
    " ",
  );

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** One page of prose, deterministic per page number. */
function pageProse(page) {
  const rng = makeRng(42 + page * 7919);
  const paragraphs = [];
  for (let p = 0; p < 6; p++) {
    const words = [];
    for (let i = 0; i < 64; i++) words.push(WORDS[Math.floor(rng() * WORDS.length)]);
    paragraphs.push(words.join(" "));
  }
  return `Section ${page} — working notes\n\n${paragraphs.join("\n\n")}`;
}

function pageHtml(page) {
  const paragraphs = pageProse(page)
    .split("\n\n")
    .map((t, i) => (i === 0 ? `<h2>${t}</h2>` : `<p>${t}</p>`))
    .join("");
  return `<section style="page-break-after: always">${paragraphs}</section>`;
}

/** The mocked shell's document for a text fixture. */
function textDoc(pageCount, title) {
  return {
    page_count: pageCount,
    title,
    pages: Array.from({ length: pageCount }, (_, i) => ({
      page: i + 1,
      text: pageProse(i + 1),
      needs_vision: false,
      has_table: false,
    })),
    outline: Array.from({ length: Math.min(pageCount, 60) }, (_, i) => ({
      title: `Section ${i + 1}`,
      page: i + 1,
      level: 1,
    })),
    links: [],
    figures: [],
  };
}

/** An image-only page, the shape of a scan: no text, one full-page raster. */
function scanDoc(pageCount, title) {
  return {
    page_count: pageCount,
    title,
    pages: Array.from({ length: pageCount }, (_, i) => ({
      page: i + 1,
      text: "",
      needs_vision: true,
      has_table: false,
    })),
    outline: [],
    links: [],
    figures: [],
  };
}

// ---------------------------------------------------------------- servers
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".wasm": "application/wasm",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
};

/** `dist/` over HTTP. One file per request; no caching needed. */
function serveDist(port) {
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const file = join(DIST, path === "/" ? "index.html" : decodeURIComponent(path));
    if (!file.startsWith(DIST) || !existsSync(file)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

/** An OpenAI-compatible endpoint that streams a canned answer word by word. */
function serveModel(port, answer) {
  let calls = 0;
  const log = [];
  const server = createServer((req, res) => {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls += 1;
      log.push({ call: calls, bytes: body.length });
      res.writeHead(200, { ...cors, "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (delta, finish = null) =>
        res.write(
          `data: ${JSON.stringify({
            id: "perf",
            object: "chat.completion.chunk",
            created: 1,
            model: "perf",
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`,
        );
      if (calls === 1) {
        // One tool step first, so the run exercises the real tool loop.
        chunk({
          role: "assistant",
          tool_calls: [
            { index: 0, id: "t1", type: "function", function: { name: "read_pdf_page", arguments: "" } },
          ],
        });
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"page":1}' } }] });
        chunk({}, "tool_calls");
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      chunk({ role: "assistant", content: "" });
      const words = answer.split(" ");
      let i = 0;
      const timer = setInterval(() => {
        if (i >= words.length) {
          clearInterval(timer);
          chunk({}, "stop");
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        chunk({ content: `${words[i]} ` });
        i += 1;
      }, 6);
      res.on("close", () => clearInterval(timer));
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, log })));
}

// ---------------------------------------------------------------- measuring
const results = { measuredAt: new Date().toISOString(), stages: {}, notes: [] };

/** rAF frame recorder plus long-task observer, installed in the page. */
async function installProbes(page) {
  await page.evaluate(() => {
    window.__perf = { frames: [], long: [] };
    const tick = (t) => {
      if (window.__perf.paused) {
        window.__perf.ticking = false;
        return;
      }
      window.__perf.frames.push(t);
      requestAnimationFrame(tick);
    };
    window.__perf.ticking = true;
    window.__perf.resume = () => {
      window.__perf.paused = false;
      if (!window.__perf.ticking) {
        window.__perf.ticking = true;
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__perf.long.push(Math.round(e.duration));
      }).observe({ entryTypes: ["longtask"] });
    } catch {
      // longtask is Chromium-only; the rest of the probe still works.
    }
  });
}

async function frameStats(page, from) {
  const frames = await page.evaluate((f) => window.__perf.frames.slice(f), from);
  const deltas = [];
  for (let i = 1; i < frames.length; i++) deltas.push(frames[i] - frames[i - 1]);
  deltas.sort((a, b) => a - b);
  const at = (p) => (deltas.length ? Math.round(deltas[Math.min(deltas.length - 1, Math.floor(p * deltas.length))] * 10) / 10 : null);
  return {
    frames: frames.length,
    p50: at(0.5),
    p95: at(0.95),
    max: deltas.length ? Math.round(deltas[deltas.length - 1] * 10) / 10 : null,
    over50: deltas.filter((x) => x > 50).length,
  };
}

async function state(page) {
  return page.evaluate(() => ({
    slots: document.querySelectorAll(".pdf-page-slot").length,
    nodes: document.getElementsByTagName("*").length,
    heapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    scrollTop: Math.round(document.querySelector(".pdf-scroller")?.scrollTop ?? -1),
  }));
}

/** The app's own counts (`src/lib/perf-counters.ts`). */
async function counters(page) {
  return page.evaluate(() => ({ raster: 0, geometry: 0, ...(globalThis.__pagewiseCounters ?? {}) }));
}

/** Open the mocked document and wait for the first rasterized page. */
async function openDocument(page) {
  const mark = await page.evaluate(() => performance.now());
  await page.getByRole("button", { name: /open document/i }).first().click();
  await page.waitForFunction(
    () => {
      const c = document.querySelector(".pdf-page-slot canvas");
      return c && c.width > 0;
    },
    null,
    { timeout: 120_000, polling: 16 },
  );
  const firstRasterMs = Math.round((await page.evaluate(() => performance.now())) - mark);
  await page.waitForFunction(() => document.querySelector(".pdf-text-layer-active"), null, {
    timeout: 120_000,
    polling: 16,
  });
  const firstTextLayerMs = Math.round((await page.evaluate(() => performance.now())) - mark);
  return { firstRasterMs, firstTextLayerMs };
}

/** A page wired to the mocked shell, the model server and the dist server. */
async function newPage(browser, { pdf, doc, appPort, modelPort, settings, files }) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const problems = [];
  page.on("pageerror", (e) => problems.push(String(e)));
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  await page.addInitScript(installTauriMock, {
    pdfB64: pdf.toString("base64"),
    doc,
    apiKey: "sk-perf",
    files,
    settings: settings ?? {
      llm: {
        version: 2,
        activeProvider: "custom",
        profiles: {
          custom: { model: "perf-model", baseURL: `http://127.0.0.1:${modelPort}/v1`, connectionVerified: true },
        },
        apiKeys: { custom: "sk-perf" },
      },
    },
  });
  await page.addInitScript((p) => {
    window.__HARNESS_OPEN_PATH__ = p;
  }, doc.path ?? `/perf/${doc.title}.pdf`);
  await page.goto(`http://127.0.0.1:${appPort}/`, { waitUntil: "load" });
  await installProbes(page);
  return { page, problems };
}

// ---------------------------------------------------------------- scenarios
async function scenarioReader(browser, ctx) {
  const { page, problems } = await newPage(browser, ctx);
  const out = {};

  await page.getByRole("button", { name: /open document/i }).first().waitFor({ timeout: 30_000 });
  out.boot = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const fcp = performance.getEntriesByName("first-contentful-paint")[0];
    return {
      fcpMs: fcp ? Math.round(fcp.startTime) : null,
      appReadyMs: Math.round(performance.now()),
      domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd),
    };
  });

  await page.evaluate(() => {
    window.__perf.long.length = 0;
  });
  Object.assign(out, await openDocument(page));
  out.openLongTasks = await page.evaluate(() => window.__perf.long.slice());
  await page.waitForTimeout(2000);
  out.open = { ...(await state(page)), ...(await counters(page)) };
  out.geometryPerPage = out.open.slots ? Math.round((out.open.geometry / out.open.slots) * 10) / 10 : null;

  // Nothing happening: what the open document costs the main thread anyway.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const taskSeconds = async () =>
    (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === "TaskDuration")?.value ?? 0;
  // The frame recorder stops for it: an rAF loop is exactly the idle work
  // this is meant to find, and the probe's own would be all it found.
  await page.evaluate(() => {
    window.__perf.paused = true;
  });
  await page.waitForTimeout(100);
  const idleFrom = await taskSeconds();
  const idleStart = Date.now();
  await page.waitForTimeout(5000);
  out.idleCpuMsPerS = Math.round((((await taskSeconds()) - idleFrom) * 1000 * 10) / ((Date.now() - idleStart) / 1000)) / 10;
  await page.evaluate(() => window.__perf.resume());

  const scroll = async (pxPerFrame, frames) => {
    const meta = await page.evaluate(
      async ([px, n]) => {
        const sc = document.querySelector(".pdf-scroller");
        const f0 = window.__perf.frames.length;
        window.__perf.long.length = 0;
        await new Promise((resolve) => {
          let i = 0;
          const step = () => {
            sc.scrollTop += px;
            i += 1;
            if (i >= n) {
              resolve();
              return;
            }
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        });
        return { f0 };
      },
      [pxPerFrame, frames],
    );
    const stats = await frameStats(page, meta.f0);
    return { ...stats, longTasks: await page.evaluate(() => window.__perf.long.length) };
  };

  out.scrollReading = await scroll(80, 60);
  await page.waitForTimeout(800);
  out.scrollFling = await scroll(500, 40);
  const afterFling = await counters(page);

  const settleStart = Date.now();
  await page.waitForTimeout(300);
  await page.waitForFunction(
    () => [...document.querySelectorAll(".pdf-page-slot")].every((s) => (s.querySelector("canvas")?.width ?? 0) > 0),
    null,
    { timeout: 30_000, polling: 32 },
  );
  await page.waitForTimeout(300);
  out.flingSettleMs = Date.now() - settleStart;
  const settled = { ...(await counters(page)), ...(await state(page)) };
  out.flingRasters = { rasters: settled.raster - afterFling.raster, slots: settled.slots };
  out.flingRastersPerSlot = settled.slots ? Math.round((out.flingRasters.rasters / settled.slots) * 10) / 10 : null;

  await page.evaluate(() => {
    window.__perf.long.length = 0;
    const sc = document.querySelector(".pdf-scroller");
    sc.scrollTop = sc.scrollHeight - sc.clientHeight;
  });
  await page.waitForTimeout(1500);
  out.jumpToEnd = { longTasks: await page.evaluate(() => window.__perf.long.length), ...(await state(page)) };

  const thumbStart = Date.now();
  // 19.0 merged the two header strips and moved the page sidebar into the
  // overflow menu; the shortcut-free path to it is the menu.
  await page.getByRole("button", { name: /more actions/i }).first().click().catch(async () => {
    await page.locator(".workspace-header-actions button").last().click();
  });
  await page.waitForTimeout(250);
  await page.getByRole("menuitem", { name: /thumbnails/i }).first().click();
  await page.waitForFunction(() => document.querySelectorAll(".thumb-item").length > 0, null, {
    timeout: 30_000,
    polling: 16,
  });
  out.thumbFirstMs = Date.now() - thumbStart;
  await page.waitForTimeout(1200);
  out.thumbItems = await page.evaluate(() => document.querySelectorAll(".thumb-item").length);
  // Closing goes through the same menu item.
  await page.getByRole("button", { name: /more actions/i }).first().click();
  await page.waitForTimeout(200);
  await page.getByRole("menuitem", { name: /thumbnails/i }).first().click();
  await page.waitForTimeout(400);

  // The streamed answer, over the real transport (the local SSE server).
  const sendMark = await page.evaluate(() => {
    window.__perf.long.length = 0;
    return performance.now();
  });
  const composer = page.getByPlaceholder(/ask about this document/i);
  await composer.click();
  await composer.fill("What does this page say?");
  const sendButton = page.getByRole("button", { name: /^send$/i });
  if (await sendButton.isEnabled().catch(() => false)) await sendButton.click();
  else await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => !!document.querySelector(".tool-fold, .tool-chip") || (document.querySelector(".markdown")?.textContent ?? "").trim().length > 0,
    null,
    { timeout: 60_000, polling: 16 },
  );
  const toolStepMs = Math.round((await page.evaluate(() => performance.now())) - sendMark);
  await page.waitForFunction(() => (document.querySelector(".markdown")?.textContent ?? "").trim().length > 0, null, {
    timeout: 60_000,
    polling: 16,
  });
  const firstTextMs = Math.round((await page.evaluate(() => performance.now())) - sendMark);
  const streamFrom = await page.evaluate(() => window.__perf.frames.length);
  await page.waitForFunction(
    () => !/^\s*stop\s*$/i.test(document.querySelector(".composer-footer")?.textContent ?? ""),
    null,
    { timeout: 120_000, polling: 64 },
  );
  await page.waitForTimeout(300);
  out.answer = {
    toolStepMs,
    firstTextMs,
    streamMs: Math.round((await page.evaluate(() => performance.now())) - sendMark),
    ...(await frameStats(page, streamFrom)),
    longTasks: await page.evaluate(() => window.__perf.long.length),
    heapMb: (await state(page)).heapMb,
  };

  out.problems = problems;
  return out;
}

async function scenarioSearch(browser, ctx) {
  const { page, problems } = await newPage(browser, ctx);
  const out = {};
  await openDocument(page);
  await page.waitForTimeout(1500);
  const mark = await page.evaluate(() => performance.now());
  await page.keyboard.press("Control+f");
  await page.waitForFunction(() => !!document.querySelector(".doc-search-input"), null, {
    timeout: 30_000,
    polling: 16,
  });
  await page.keyboard.type("measurements records");
  await page.waitForFunction(() => document.querySelectorAll(".doc-search-hit").length > 0, null, {
    timeout: 60_000,
    polling: 32,
  });
  out.searchFirstHitMs = Math.round((await page.evaluate(() => performance.now())) - mark);
  out.hits = await page.evaluate(() => document.querySelectorAll(".doc-search-hit").length);
  out.problems = problems;
  return out;
}

async function scenarioLongChat(browser, ctx) {
  // 100 turns of history, persisted the way the app persists chats.
  const history = [];
  for (let i = 1; i <= 100; i++) {
    history.push({ id: `u${i}`, role: "user", parts: [{ type: "text", text: `Question ${i}: what does section ${i} say?` }] });
    history.push({
      id: `a${i}`,
      role: "assistant",
      parts: [
        {
          type: "text",
          text: `Section ${i} states the pattern in its own words 〔p${i} "working notes"〕. The prose is filler.`,
        },
      ],
    });
  }
  const { page, problems } = await newPage(browser, {
    ...ctx,
    settings: ctx.settings,
    files: { "pagewise-v3-chats.json": { [ctx.doc.path ?? "/perf/longchat.pdf"]: history } },
  });
  const out = {};
  const mark = await page.evaluate(() => performance.now());
  await page.getByRole("button", { name: /open document/i }).first().click();
  await page.waitForFunction(() => document.querySelectorAll(".message").length >= 200, null, {
    timeout: 120_000,
    polling: 32,
  });
  out.renderMs = Math.round((await page.evaluate(() => performance.now())) - mark);
  await page.waitForTimeout(1500);
  out.nodes = (await state(page)).nodes;
  out.heapMb = (await state(page)).heapMb;

  const from = await page.evaluate(() => window.__perf.frames.length);
  await page.evaluate(async () => {
    const list = document.querySelector(".messages");
    await new Promise((resolve) => {
      let i = 0;
      const step = () => {
        list.scrollTop = Math.max(0, list.scrollHeight - list.clientHeight - i * 200);
        i += 1;
        if (i >= 40) {
          resolve();
          return;
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  });
  out.scroll = await frameStats(page, from);

  const composer = page.getByPlaceholder(/ask about this document/i);
  await composer.click();
  await composer.fill("And the last section?");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => (document.querySelector(".markdown")?.textContent ?? "").trim().length > 0 || !!document.querySelector(".tool-fold"),
    null,
    { timeout: 60_000, polling: 16 },
  );
  out.problems = problems;
  return out;
}

async function scenarioOutline(browser, ctx) {
  const { page, problems } = await newPage(browser, ctx);
  const out = {};
  await openDocument(page);
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: /more actions/i }).first().click();
  await page.waitForTimeout(250);
  await page.getByRole("menuitem", { name: /thumbnails/i }).first().click();
  await page.waitForTimeout(600);
  const mark = await page.evaluate(() => {
    window.__perf.long.length = 0;
    return performance.now();
  });
  await page.getByRole("tab", { name: /outline/i }).first().click();
  await page.waitForFunction(() => document.querySelectorAll(".outline-item").length > 0, null, {
    timeout: 30_000,
    polling: 16,
  });
  out.firstRowMs = Math.round((await page.evaluate(() => performance.now())) - mark);
  await page.waitForTimeout(1000);
  out.rows = await page.evaluate(() => document.querySelectorAll(".outline-item").length);
  out.entries = ctx.doc.outline.length;
  out.longTasks = await page.evaluate(() => window.__perf.long.slice());
  out.problems = problems;
  return out;
}

/**
 * BM25 over 500 pages of the reader's prose, in Node through Vite's SSR
 * loader — the module as the app compiles it. The first call builds the index;
 * every newly indexed page makes the next search do that again.
 */
async function measureBm25() {
  const { createServer: createVite } = await import("vite");
  const vite = await createVite({ root: ROOT, logLevel: "error", server: { middlewareMode: true }, appType: "custom" });
  try {
    const { rankPages } = await vite.ssrLoadModule("/src/lib/ranked-search.ts");
    const pages = Array.from({ length: 500 }, (_, i) => ({ page: i + 1, text: pageProse(i + 1) }));
    const time = (fn) => {
      const t0 = performance.now();
      fn();
      return Math.round((performance.now() - t0) * 10) / 10;
    };
    const builds = [];
    for (let i = 0; i < 3; i++) builds.push(time(() => rankPages([...pages], "measurements records")));
    const cached = pages.slice();
    rankPages(cached, "measurements records");
    return {
      pages: pages.length,
      buildMs: Math.min(...builds),
      cachedMs: time(() => rankPages(cached, "measurements records")),
    };
  } finally {
    await vite.close();
  }
}

async function scenarioLargeFile(browser, ctx) {
  const { page, problems } = await newPage(browser, ctx);
  const out = {};
  await page.evaluate(() => {
    window.__perf.long.length = 0;
  });
  Object.assign(out, await openDocument(page));
  await page.waitForTimeout(2500);
  out.longTasks = await page.evaluate(() => window.__perf.long.slice());
  out.heapMb = (await state(page)).heapMb;
  out.problems = problems;
  return out;
}

// ---------------------------------------------------------------- fixtures on disk
async function buildFixtures(browser) {
  mkdirSync(WORK, { recursive: true });
  const textPath = join(WORK, "reader-120.pdf");
  const searchPath = join(WORK, "search-500.pdf");
  const scanPath = join(WORK, "scan-30.pdf");
  const page = await browser.newPage();
  const MARGIN = { top: "68px", bottom: "68px", left: "72px", right: "72px" };
  const STYLE = "font-family: Georgia, serif; font-size: 10.5pt; line-height: 1.45; color: #111;";
  const print = async (path, body) => {
    await page.setContent(`<!doctype html><html><head><style>body{${STYLE}}</style></head><body>${body}</body></html>`, {
      waitUntil: "load",
    });
    await page.pdf({ path, format: "Letter", margin: MARGIN, printBackground: false });
  };
  await print(textPath, Array.from({ length: 120 }, (_, i) => pageHtml(i + 1)).join(""));
  await print(searchPath, Array.from({ length: 500 }, (_, i) => pageHtml(i + 1)).join(""));

  // A scan-shaped file: one full-page JPEG per page, drawn by the same browser
  // that prints it, so the probe has no image dependencies of its own.
  await page.setContent("<!doctype html><html><body><canvas id='c' width='1700' height='2200'></canvas></body></html>");
  const jpeg = await page.evaluate(() => {
    const c = document.getElementById("c");
    const g = c.getContext("2d");
    g.fillStyle = "#fdfcf8";
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#333";
    g.font = "28px serif";
    for (let y = 120; y < 2000; y += 44) {
      g.fillText("the quick brown fox jumps over a lazy dog 0123456789", 120, y);
    }
    // Noise, so the JPEG cannot compress the page away: a scan-shaped file has
    // to be tens of megabytes for the byte and bitmap caches to mean anything.
    const img = g.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = Math.floor(Math.random() * 48);
      img.data[i] -= n;
      img.data[i + 1] -= n;
      img.data[i + 2] -= n;
    }
    g.putImageData(img, 0, 0);
    return c.toDataURL("image/jpeg", 0.9);
  });
  await print(scanPath, Array.from({ length: 30 }, () => `<section style="page-break-after: always"><img src="${jpeg}" style="width:100%"></section>`).join(""));
  await page.close();

  const sizes = {
    reader: readFileSync(textPath).byteLength,
    search: readFileSync(searchPath).byteLength,
    scan: readFileSync(scanPath).byteLength,
  };
  return { textPath, searchPath, scanPath, sizes };
}

// ---------------------------------------------------------------- run
async function main() {
  if (!existsSync(join(DIST, "index.html"))) {
    console.error("dist/index.html is missing — run `npm run build` first.");
    process.exit(2);
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const appPort = 4173;
  const modelPort = 4174;
  const appServer = await serveDist(appPort);
  const answer = (
    "The page is a set of working notes rather than an argument, so the answer is what the record shows: " +
    "each section restates the same measurement pattern in different words, and the prose is generated filler. "
  ).repeat(12);
  const { server: modelServer, log: modelLog } = await serveModel(modelPort, answer);

  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ["--enable-precise-memory-info", "--disable-dev-shm-usage"],
  });

  const fixtures = await buildFixtures(browser);
  results.fixtures = fixtures.sizes;

  const textSettings = {
    llm: {
      version: 2,
      activeProvider: "custom",
      profiles: {
        custom: { model: "perf-model", baseURL: `http://127.0.0.1:${modelPort}/v1`, connectionVerified: true },
      },
      apiKeys: { custom: "sk-perf" },
    },
  };

  const readerDoc = {
    ...textDoc(120, "Reader 120"),
    path: fixtures.textPath,
    // One link a page, so every mounted page has an overlay that asks for its
    // geometry (22.0): without one the layers ask for nothing, and the count
    // would say nothing.
    links: Array.from({ length: 120 }, (_, i) => ({
      page: i + 1,
      url: `https://example.org/section-${i + 1}`,
      context: `Section ${i + 1}`,
      rect: { x: 72, y: 700, width: 200, height: 14 },
    })),
  };
  const searchDoc = { ...textDoc(500, "Search 500"), path: fixtures.searchPath };
  const scan = { ...scanDoc(30, "Scan 30"), path: fixtures.scanPath };

  try {
    results.stages.reader = await scenarioReader(browser, {
      pdf: readFileSync(fixtures.textPath),
      doc: readerDoc,
      appPort,
      modelPort,
      settings: textSettings,
    });
    results.stages.search = await scenarioSearch(browser, {
      pdf: readFileSync(fixtures.searchPath),
      doc: searchDoc,
      appPort,
      modelPort,
      settings: textSettings,
    });
    const callsBeforeLongChat = modelLog.length;
    results.stages.longchat = await scenarioLongChat(browser, {
      pdf: readFileSync(fixtures.textPath),
      doc: readerDoc,
      appPort,
      modelPort,
      settings: textSettings,
    });
    // The first request the question after 100 turns sends: its body is the
    // history the app chose to resend, which is what this budget is about.
    results.stages.longchat.requestBytes = modelLog[callsBeforeLongChat]?.bytes ?? null;
    results.stages.outline = await scenarioOutline(browser, {
      pdf: readFileSync(fixtures.textPath),
      doc: {
        ...readerDoc,
        // The Rust cap on a synthesized outline, pointing round the 120 pages.
        outline: Array.from({ length: 1000 }, (_, i) => ({ title: `Heading ${i + 1}`, page: (i % 120) + 1, level: 1 + (i % 3) })),
      },
      appPort,
      modelPort,
      settings: textSettings,
    });
    results.stages.bm25 = await measureBm25();
    results.stages.largefile = await scenarioLargeFile(browser, {
      pdf: readFileSync(fixtures.scanPath),
      doc: scan,
      appPort,
      modelPort,
      settings: textSettings,
    });
  } finally {
    results.modelCalls = modelLog.length;
    writeFileSync(join(OUT_DIR, "report.json"), JSON.stringify(results, null, 2));
    await browser.close();
    appServer.close();
    modelServer.close();
  }

  // ------------------------------------------------------------ verdicts
  const checks = [];
  const check = (name, value, budget, unit = "ms", max = true) => {
    const ok = value === null || value === undefined ? false : max ? value <= budget : value >= budget;
    checks.push({ name, value, budget, unit, ok });
  };
  const reader = results.stages.reader ?? {};
  const answerStage = reader.answer ?? {};
  const search = results.stages.search ?? {};
  const longchat = results.stages.longchat ?? {};
  const large = results.stages.largefile ?? {};
  const outline = results.stages.outline ?? {};
  const bm25 = results.stages.bm25 ?? {};

  check("boot.appReadyMs", reader.boot?.appReadyMs, BUDGETS.bootAppReadyMs);
  check("open.firstRasterMs", reader.firstRasterMs, BUDGETS.openFirstRasterMs);
  check("open.firstTextLayerMs", reader.firstTextLayerMs, BUDGETS.openFirstTextLayerMs);
  check("scrollReading.p95", reader.scrollReading?.p95, BUDGETS.scrollP95Ms);
  check("scrollReading.over50", reader.scrollReading?.over50, BUDGETS.scrollFramesOver50, "frames");
  check("scrollReading.longTasks", reader.scrollReading?.longTasks, BUDGETS.scrollLongTasks, "tasks");
  check("scrollFling.p95", reader.scrollFling?.p95, BUDGETS.flingP95Ms);
  check("scrollFling.over50", reader.scrollFling?.over50, BUDGETS.flingFramesOver50, "frames");
  check("flingSettleMs", reader.flingSettleMs, BUDGETS.settleMs);
  check("jumpToEnd.longTasks", reader.jumpToEnd?.longTasks, BUDGETS.jumpLongTasks, "tasks");
  check("thumbnails.firstMs", reader.thumbFirstMs, BUDGETS.thumbFirstMs);
  check("thumbnails.items", reader.thumbItems, BUDGETS.thumbItemsMax, "items");
  check("search.firstHitMs", search.searchFirstHitMs, BUDGETS.searchFirstHitMs);
  check("answer.firstTextMs", answerStage.firstTextMs, BUDGETS.answerFirstTextMs);
  check("answer.p95", answerStage.p95, BUDGETS.answerP95Ms);
  check("answer.longTasks", answerStage.longTasks, BUDGETS.answerLongTasks, "tasks");
  check("answer.heapMb", answerStage.heapMb, BUDGETS.heapAfterAnswerMb, "MB");
  check("longchat.renderMs", longchat.renderMs, BUDGETS.longchatRenderMs);
  check("longchat.scroll.p95", longchat.scroll?.p95, BUDGETS.longchatScrollP95Ms);
  // Written into the budgets since the long-chat scenario was added and never
  // compared until 21.0: the probe recorded each body's length and nothing
  // read it against 40,000.
  check("longchat.requestBytes", longchat.requestBytes, BUDGETS.longchatRequestBytesMax, "B");
  check("largefile.firstRasterMs", large.firstRasterMs, BUDGETS.largeFileFirstRasterMs);
  check("largefile.firstTextLayerMs", large.firstTextLayerMs, BUDGETS.largeFileFirstTextLayerMs);
  check("idle.cpuMsPerS", reader.idleCpuMsPerS, BUDGETS.idleCpuMsPerS, "ms/s");
  check("open.geometryPerPage", reader.geometryPerPage, BUDGETS.geometryPerPageMax, "calls");
  check("fling.rastersPerSlot", reader.flingRastersPerSlot, BUDGETS.flingRastersPerSlotMax, "x");
  check("outline.firstRowMs", outline.firstRowMs, BUDGETS.outlineFirstRowMs);
  check("outline.longTasks", outline.longTasks?.length, BUDGETS.outlineLongTasks, "tasks");
  check("bm25.buildMs", bm25.buildMs, BUDGETS.bm25BuildMs);

  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\nfixtures: ${JSON.stringify(results.fixtures)} (bytes)\n`);
  console.log(`${pad("check", 28)} ${pad("value", 10)} ${pad("budget", 10)} ok`);
  for (const c of checks) {
    console.log(`${pad(c.name, 28)} ${pad(c.value ?? "-", 10)} ${pad(c.budget, 10)} ${c.ok ? "yes" : "NO"}`);
  }
  const problems = Object.values(results.stages).flatMap((s) => s.problems ?? []);
  if (problems.length > 0) {
    console.log(`\n${new Set(problems).size} distinct console/page error(s):`);
    for (const p of new Set(problems)) console.log(`  ${p}`);
  }
  console.log(`\nreport: ${join(OUT_DIR, "report.json")}`);

  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    console.error(`\n${failed.length} budget(s) exceeded.`);
    process.exit(1);
  }
  console.log("\nall budgets hold.");
}

await main();
