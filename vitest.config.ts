import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
    // Skill discovery tests exercise nested node:worker_threads workers; cap
    // the outer fork pool so Windows does not exhaust process/thread handles.
    maxWorkers: 2,
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
        // Manager lifecycle and retained-record paths keep conservative floors
        // while the line floor remains above the measured cross-platform baseline.
        "src/agents/agent-manager.ts": { statements: 85, branches: 80, functions: 80, lines: 87 },
        // Tool execution boundaries retain conservative floors after splitting
        // the former handler; each remains below the measured Windows baseline.
        "src/agents/tool-execution.ts": { statements: 70, branches: 75, functions: 45, lines: 70 },
        "src/agents/agent-tool-results.ts": { statements: 90, branches: 84, functions: 78, lines: 90 },
        "src/agents/agent-control-execution.ts": { statements: 58, branches: 48, functions: 60, lines: 60 },
        // Tool/config policy is unit-tested at its extracted boundary.
        "src/agents/agent-tool-policy.ts": { statements: 90, branches: 90, functions: 80, lines: 90 },
        // Discovery boundaries retain conservative floors after splitting the
        // former monolith; these sit below the measured cross-platform baseline.
        "src/agents/agent-frontmatter.ts": { statements: 75, branches: 74, functions: 85, lines: 78 },
        // The scanner's fail-closed race branches are exercised selectively;
        // retain a measured 85% line floor while keeping statement/function
        // floors high for the bounded discovery path.
        // Streaming iterator close/limit branches differ between native Dir
        // implementations; retain a measured floor for the bounded scanner.
        "src/agents/agent-directory-scan.ts": { statements: 82, branches: 70, functions: 80, lines: 82 },
        "src/agents/agent-discovery.ts": { statements: 83, branches: 84, functions: 85, lines: 90 },
        "src/config/config-io.ts": { statements: 68, branches: 68, functions: 73, lines: 70 },
        "src/prompt/skill-loader.ts": { statements: 85, branches: 78, functions: 90, lines: 85 },
        // Cache/fingerprint resource failures are exercised by integration
        // tests, but V8's Windows async-module map leaves a lower branch floor.
        "src/prompt/skill-cache.ts": { statements: 70, branches: 70, functions: 68, lines: 70 },
        // Sync/async directory adapters expose platform-specific iterator,
        // filesystem, and worker cleanup paths; keep these floors at the
        // measured cross-platform boundary rather than padding tests.
        "src/prompt/skill-catalog.ts": { statements: 60, branches: 40, functions: 64, lines: 62 },
        // The fingerprint facade owns only serialization; the transferred
        // boundary floor belongs to the bounded streaming walker.
        "src/prompt/skill-fingerprint-walk.ts": { statements: 70, branches: 70, functions: 80, lines: 74 },
        "src/prompt/skill-limits.ts": { statements: 78, branches: 70, functions: 65, lines: 80 },
        "src/prompt/skill-loader-worker.ts": { statements: 85, branches: 70, functions: 90, lines: 90 },
        "src/spawn/spawn-coordinator.ts": { statements: 74, branches: 70, functions: 80, lines: 74 },
      },
    },
  },
});
