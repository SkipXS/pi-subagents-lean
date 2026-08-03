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
      // Global floors plus conservative gates for failure- and race-critical
      // modules. File floors sit below the reproducible Ubuntu baseline.
      thresholds: {
        statements: 79,
        branches: 74,
        functions: 75,
        lines: 81,
        "src/registration.ts": { statements: 80, branches: 70, functions: 95, lines: 80 },
        "src/agents/agent-manager.ts": { statements: 85, branches: 80, functions: 80, lines: 88 },
        "src/config/config-io.ts": { statements: 68, branches: 80, functions: 73, lines: 70 },
        "src/prompt/skill-loader.ts": { statements: 72, branches: 80, functions: 70, lines: 72 },
        "src/spawn/spawn-coordinator.ts": { statements: 74, branches: 70, functions: 80, lines: 74 },
      },
    },
  },
});
