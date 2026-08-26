/**
 * A fake Tauri shell, so the app can be opened in a browser and looked at.
 *
 * Every UI review of PageWise up to 7.8 was done by reading code. The 5.3 one
 * said so in its first paragraph — it tried this exact thing, got a blank page
 * and `Cannot read properties of undefined (reading 'invoke')`, and concluded
 * "视觉设计我评不了". That is why "the UI is coarse" kept being raised and never
 * resolved: nobody could see it.
 *
 * The app checks for `__TAURI_INTERNALS__` and calls six Rust commands. That is
 * a small enough surface to fake, and faking it is worth more than any amount
 * of further reading.
 *
 * This runs as a Playwright init script — it is never imported by the app and
 * never reaches a bundle. The production code is untouched by it, which is the
 * point: a harness that required a code path in the app would be a harness that
 * could ship.
 *
 * Three things about Tauri v2 that are not obvious and cost an hour each:
 *
 *   1. `Store.get` destructures a `[value, exists]` tuple. Returning the bare
 *      value gives "(intermediate value) is not iterable" from inside the
 *      plugin, nowhere near the store call.
 *   2. `unlisten` reads `window.__TAURI_EVENT_PLUGIN_INTERNALS__`, a different
 *      global from `__TAURI_INTERNALS__`. Without it every listener teardown
 *      throws.
 *   3. `@tauri-apps/api/window` needs `metadata.currentWindow` present before
 *      the first import, or the module throws at load and the whole app is a
 *      blank page with no useful error.
 *
 * WHAT THIS IS NOT: the real thing. Chromium here, WebKitGTK / WebView2 /
 * WKWebView there. Font rasterization and a few CSS behaviours differ, so this
 * settles layout, empty states, duplicated copy and dead space — not pixels.
 * Do not assert a colour or a font metric from it.
 */

/**
 * Pages in the fixture the harness opens.
 *
 * It has to match, and it is not a detail. The mock reports the page count and
 * page text while pdf.js renders the real file, so a mock that claims more
 * pages than the PDF has produces "Invalid page request." on the canvas the
 * moment anything navigates past the end — which looks exactly like a
 * rendering bug and is the app reporting the truth about a lie it was told.
 *
 * That is the second false finding this harness produced. The first was page
 * text too short for `isRasterHeavyPage`, which raised the "Image-based PDF"
 * hint. Both come from the same mistake: fake data that is not internally
 * consistent with the real file underneath it. Anything surprising in a
 * screenshot gets checked against the fixture before it gets called a defect.
 *
 * The fixture is `text-pages.pdf`, three pages, generated for this harness
 * rather than borrowed from the Rust tests. The one-page fixture used before it
 * made the thumbnail, outline and marks sidebar impossible to photograph:
 * PreviewToolbar hides that whole control behind `totalPages > 1`, correctly,
 * so the sidebar simply did not exist to open. It nearly got reported as a
 * missing button — the fifth false finding this harness would have produced.
 */
export const FIXTURE_PAGE_COUNT = 3;

/** The document the mock shell reports. Long enough page text to matter. */
/**
 * The text runs `text-pages.pdf` really has on a page, with their rectangles.
 *
 * Dumped from `inspect::page_text_items` against the fixture itself, not
 * invented: bottom-left origin, PDF points, a Letter page. `FindingLayer` looks
 * the assistant's quoted wording up in these, so runs that are merely plausible
 * would place a finding somewhere the reader can see is wrong — and a
 * screenshot of that is worse than no screenshot.
 */
export const PAGE_RUNS = [
  { text: "# Section {page}", rect: { x: 72, y: 700, width: 100.06, height: 24 } },
  {
    text: "Lorem ipsum dolor sit amet, consetetur sadipscing elitr,",
    rect: { x: 72, y: 660, width: 293.44, height: 12 },
  },
  {
    text: "sed diam nonumy eirmod tempor invidunt ut labore on page {page}.",
    rect: { x: 72, y: 640, width: 330.16, height: 12 },
  },
];

/** The runs as one page of Markdown, the way the extractor reports them. */
export function pageText(page) {
  const [heading, ...body] = PAGE_RUNS.map((r) => r.text.replace("{page}", String(page)));
  return `${heading}\n\n${body.join(" ")}`;
}

export function sampleDocument(pageCount = FIXTURE_PAGE_COUNT) {
  return {
    page_count: pageCount,
    title: "Sample document",
    pages: Array.from({ length: pageCount }, (_, i) => ({
      page: i + 1,
      // `isRasterHeavyPage` treats a page under 48 characters as a scan and
      // shows the "Image-based PDF" hint. A short stub therefore produces a
      // banner that looks like a rendering bug and is the heuristic working
      // correctly on fake input — it cost one wrong finding already.
      // Word for word what `text-pages.pdf` actually renders, taken from the
      // extractor rather than approximated. It used to carry an extra clause
      // the fixture does not contain, which meant the mocked page text and the
      // page on screen disagreed — invisible until a feature started matching
      // one against the other.
      text: pageText(i + 1),
      needs_vision: false,
      has_table: false,
    })),
    outline: [],
    links: [],
    figures: [],
  };
}

/**
 * The init script body, as a function Playwright serializes into the page.
 *
 * Takes its data as one argument because `addInitScript` passes exactly one.
 */
export function installTauriMock({ pdfB64, doc, apiKey, settings, runs }) {
  const store = new Map(Object.entries(settings ?? {}));

  // Tauri v2 routes unlisten through its own global, not through INTERNALS.
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };

  const bytes = (b64) => {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  };

  window.__TAURI_INTERNALS__ = {
    // Must exist before @tauri-apps/api/window is imported.
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { windowLabel: "main", label: "main" },
    },
    transformCallback: (cb) => {
      const id = Math.floor(Math.random() * 1e9);
      window[`_tauriCb${id}`] = cb;
      return id;
    },
    convertFileSrc: (p) => `about:blank#${p}`,
    invoke: async (cmd, args) => {
      switch (cmd) {
        case "open_document_cmd":
          return doc;
        case "page_text_items_cmd": {
          /*
           * Real text runs, so a located finding is exercised rather than
           * mocked away. `FindingLayer` looks the assistant's own wording up in
           * these; returning [] made every claim unlocatable, which is exactly
           * the state the feature exists to distinguish from a bad quote.
           */
          const page = args?.page ?? 1;
          if (page < 1 || page > (doc.page_count ?? 0)) return [];
          return (runs ?? []).map(({ text, rect }) => ({
            text: text.replace(/^#+\s*/, "").replace("{page}", String(page)),
            rect,
          }));
        }
        case "read_file_bytes":
          return Array.from(bytes(pdfB64));
        case "file_stamp_cmd":
          return "harness-stamp";
        case "extract_region_cmd":
          return { text: "", table: null };
        case "get_api_key":
          return apiKey ?? "";
        default:
          break;
      }
      if (cmd === "plugin:dialog|open") return window.__HARNESS_OPEN_PATH__ ?? null;
      // [value, exists] — see the note at the top of this file.
      if (cmd?.startsWith("plugin:store|get")) {
        return [store.get(args?.key) ?? null, store.has(args?.key)];
      }
      if (cmd?.startsWith("plugin:store|set")) {
        store.set(args?.key, args?.value);
        return null;
      }
      if (cmd?.startsWith("plugin:store|keys")) return [...store.keys()];
      if (cmd === "plugin:app|version") return "0.0.0-harness";
      if (cmd === "plugin:app|name") return "PageWise";
      return null;
    },
  };
}
