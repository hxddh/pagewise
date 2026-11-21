import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  // React Compiler (1.0) through the Rust transform, which is the path
  // @vitejs/plugin-react 6 documents for Vite 8 / Rolldown. It memoizes what
  // the codebase used to do by hand: the comparison functions on PageSlot,
  // MessageContent and the memo boundaries that three refs existed to work
  // around. 18.0 deleted those by hand first, so the compiler has less to
  // correct — what it adds is the next component that would have needed one.
  plugins: [react({ compiler: true }), silenceTesseractLog()],

  build: {
    // The app ships inside macOS WKWebView (minimumSystemVersion ~ macOS 12,
    // i.e. Safari 15), NOT Chrome. Targeting chrome110 emits syntax WKWebView
    // can't parse and white-screens on the minimum supported OS.
    target: "safari15",
    // Keep heavy deferred feature chunks (`ai-*`, `zod-*`, `ocr-*`, `markdown-*`, `motion-*`)
    // out of `index.html`'s cold-boot `<link rel="modulepreload">` list (27.0).
    modulePreload: {
      resolveDependencies(_filename, deps) {
        return deps.filter((d) => !/(?:^|\/)(?:ai|zod|ocr|markdown|motion)-/.test(d));
      },
    },
    // `rolldownOptions`: Vite 8's bundler is Rolldown, and `rollupOptions` is
    // its deprecated alias.
    rolldownOptions: {
      output: {
        minify: { compress: { dropConsole: true, dropDebugger: true } },
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          // `tslib` and `@ai-sdk/react`'s hook glue share CJS/React runtime helpers
          // with `react-dom`; keeping them in `vendor` prevents entry chunks from
          // acquiring a reverse static import on `ai-*` or `zod-*`.
          if (
            /node_modules\/(react|react-dom|scheduler|tslib|@ai-sdk\/react|swr|use-sync-external-store)\//.test(id)
          ) {
            return "vendor";
          }
          if (/node_modules\/zod\//.test(id)) return "zod";
          if (/node_modules\/(ai|@ai-sdk)\//.test(id)) return "ai";
          if (/node_modules\/(tesseract\.js|wasm-feature-detect)\//.test(id)) return "ocr";
          if (/node_modules\/(motion|framer-motion|motion-dom|motion-utils)\//.test(id)) return "motion";
          if (
            /node_modules\/(react-markdown|remark-|rehype-|micromark|mdast|hast|unist|vfile|character-entities|decode-named-character-reference|property-information|space-separated-tokens|comma-separated-tokens|html-url-attributes|zwitch|longest-streak|ccount|markdown-table|escape-string-regexp|bail|trough|unified|is-plain-obj|devlop|estree|style-to-js|style-to-object|inline-style-parser)/.test(id)
          ) {
            return "markdown";
          }
          return undefined;
        },
      },
    },
  },

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));

/**
 * tesseract.js logs through `console.log.apply(...)`, a form the minifier's
 * console stripping does not recognise, so it survives into the bundle (and
 * `check-bundle.mjs` rightly refuses it). PageWise never turns that logging
 * on; the module is replaced with one that cannot log at all.
 */
function silenceTesseractLog(): Plugin {
  return {
    name: "pagewise:silence-tesseract-log",
    transform(code, id) {
      if (!/[\\/]tesseract\.js[\\/]src[\\/]utils[\\/]log\.js$/.test(id)) return null;
      return {
        code: "'use strict';\nexports.logging = false;\nexports.setLogging = () => {};\nexports.log = () => null;\n",
        map: null,
      };
    },
  };
}
