import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Named, not the default glob: with none, any `*.test.ts` left at the
    // repository root (an audit's scratch measurement, say) joined `npm test`.
    // The evaluation suite has its own config (`eval/vitest.config.ts`).
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.mjs"],
  },
});
