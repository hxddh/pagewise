import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],

  build: {
    // The app ships inside macOS WKWebView (minimumSystemVersion ~ macOS 12,
    // i.e. Safari 15), NOT Chrome. Targeting chrome110 emits syntax WKWebView
    // can't parse and white-screens on the minimum supported OS.
    target: "safari15",
    rollupOptions: {
      output: {
        // Console stripping, stated to the minifier that actually runs.
        //
        // This used to be `minify: "esbuild"` plus a top-level `esbuild: {
        // drop: [...] }`, and that pair really did strip them — `vite build`
        // sets NODE_ENV, so the array was populated, and esbuild's minifier
        // honoured it. Vite 8.2.2 with @vitejs/plugin-react 6.1.0 can no
        // longer load esbuild at all: it is not bundled any more and
        // `transformWithEsbuild` is deprecated, so `minify: "esbuild"` fails
        // the build outright. The minifier is oxc now, it has its own switch,
        // and it does not drop console by default — five console.error calls
        // reached the vendor chunk the moment the old pair stopped working,
        // and `scripts/check-bundle.mjs` is what caught them.
        minify: { compress: { dropConsole: true, dropDebugger: true } },
        // Rolldown (Vite 8) takes only the function form. The object form used
        // to say "these packages and whatever they exclusively pull in"; a
        // function sees one module id at a time, so the transitive tail has to
        // be named. react-markdown's tail is the awkward one — micromark,
        // mdast, hast, unist, vfile and friends are all its dependencies and
        // belong with it rather than in the catch-all.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "vendor";
          if (/node_modules\/(ai|@ai-sdk)\//.test(id)) return "ai";
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
