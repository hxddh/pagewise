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

/** The document the mock shell reports. Long enough page text to matter. */
export function sampleDocument(pageCount = 3) {
  return {
    page_count: pageCount,
    title: "Sample document",
    pages: Array.from({ length: pageCount }, (_, i) => ({
      page: i + 1,
      // `isRasterHeavyPage` treats a page under 48 characters as a scan and
      // shows the "Image-based PDF" hint. A short stub therefore produces a
      // banner that looks like a rendering bug and is the heuristic working
      // correctly on fake input — it cost one wrong finding already.
      text:
        `# Section ${i + 1}\n\nLorem ipsum dolor sit amet, consetetur sadipscing ` +
        `elitr, sed diam nonumy eirmod tempor invidunt ut labore et dolore magna ` +
        `aliquyam erat, sed diam voluptua on page ${i + 1}.`,
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
export function installTauriMock({ pdfB64, doc, apiKey, settings }) {
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
        case "page_text_items_cmd":
          return [];
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
