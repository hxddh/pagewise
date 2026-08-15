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
    minify: "esbuild",
    rollupOptions: {
      output: {
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

  /*
   * Console calls are stripped from production builds.
   *
   * Vite 8 warns on every dev start that this is ignored, because the React
   * plugin sets oxc options and oxc wins over esbuild. The warning is accurate
   * about dev and misleading about build: `vite build` sets NODE_ENV, the array
   * below is populated, and the calls really are removed. The dev warning
   * prints `drop: []` precisely because in dev the array is empty.
   *
   * I read that warning as proof the option had never worked and deleted it.
   * Five console.error calls immediately appeared in the vendor chunk. What
   * caught it was scripts/check-bundle.mjs, written minutes earlier on that
   * same mistaken premise — the check failed the change that created it, which
   * is the only reason this line is still here.
   */
  esbuild: {
    drop: process.env.NODE_ENV === "production" ? ["console", "debugger"] : [],
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
