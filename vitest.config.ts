import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      reporter: ["text", "json-summary", "lcov"],
      // Baseline from the full cross-platform suite; raise these as gaps close.
      thresholds: {
        statements: 76,
        branches: 73,
        functions: 72,
        lines: 78,
      },
    },
  },
});
