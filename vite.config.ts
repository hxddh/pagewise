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
    // Keep heavy deferred feature chunks out of `index.html`'s cold-boot
    // `<link rel="modulepreload">` list (27.0–28.0).
    modulePreload: {
      resolveDependencies(_filename, deps) {
        return deps.filter(
          (d) => !/(?:^|\/)(?:ai-sdk|ai-openai|zod|pdfjs|tesseract|markdown)-/.test(d),
        );
      },
    },
    // `rolldownOptions`: Vite 8's bundler is Rolldown. Use native `codeSplitting.groups`
    // with explicit priorities and `includeDependenciesRecursively: false` (28.0):
    // `manualChunks` defaults to `includeDependenciesRecursively: true` at equal
    // priority 0, which caused `markdown` to swallow `react`/`jsx-runtime` and
    // forced cold boot to execute 1.34 MB of deferred chunks before WelcomeView.
    rolldownOptions: {
      output: {
        minify: { compress: { dropConsole: true, dropDebugger: true } },
        codeSplitting: {
          groups: [
            {
              name: "vendor",
              test: /node_modules[\\/](react|react-dom|react-is|scheduler|tslib|use-sync-external-store|@oxc-project)[\\/]/,
              priority: 100,
            },
            {
              name: "pdfjs",
              test: /node_modules[\\/]pdfjs-dist[\\/]/,
              priority: 70,
            },
            {
              name: "zod",
              test: /node_modules[\\/]zod[\\/]/,
              priority: 60,
            },
            {
              name: "ai-openai",
              test: /node_modules[\\/]@ai-sdk[\\/]openai[\\/]/,
              priority: 55,
            },
            {
              name: "ai-sdk",
              test: /node_modules[\\/](ai|@ai-sdk[\\/](react|provider|provider-utils))[\\/]/,
              priority: 50,
            },
            {
              name: "markdown",
              test: /node_modules[\\/](react-markdown|remark-gfm)[\\/]/,
              priority: 40,
            },
            {
              name: "tesseract",
              test: /node_modules[\\/](tesseract\.js|wasm-feature-detect)[\\/]/,
              priority: 20,
            },
          ],
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
