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
      // Global floors retain implementation freedom while guarding meaningful
      // regressions across the full extension; avoid brittle per-file gates.
      thresholds: {
        statements: 80,
        branches: 74,
        functions: 78,
        lines: 81,
      },
    },
  },
});
