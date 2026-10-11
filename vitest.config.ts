import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["source"],
  },
  test: {
    environment: "node",
    include: ["packages/*/test/**/*.test.ts", "examples/*/test/**/*.test.ts"],
    passWithNoTests: true,
  },
});
