import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["@core/source"],
  },
  ssr: {
    resolve: {
      conditions: ["@core/source"],
    },
  },
  test: {
    environment: "node",
    include: ["packages/*/test/**/*.test.ts", "examples/*/test/**/*.test.ts"],
    passWithNoTests: true,
    // At most two test workers, so a test run never takes over the machine (owner, 2026-10-17).
    maxWorkers: 2,
  },
});
