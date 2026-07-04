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
        manualChunks: {
          vendor: ["react", "react-dom"],
          ai: ["ai", "@ai-sdk/react", "@ai-sdk/openai"],
          markdown: ["react-markdown", "remark-gfm"],
        },
      },
    },
  },

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
