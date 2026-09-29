import { defineConfig } from "vitest/config";

/**
 * The evaluation suite: `npm run eval`. Kept out of `npm test` because it
 * builds and runs the Rust extractor over the corpus, which takes a minute the
 * first time and needs a Rust toolchain. It uses vitest only so it can import
 * the app's TypeScript modules as they are, rather than a copy of them.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["eval/**/*.eval.ts"],
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
