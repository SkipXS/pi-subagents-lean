import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import {
  discoverAndLoadExtensions,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

describe.sequential("Pi extension contract", () => {
  it("loads through Pi's public loader and runs its session lifecycle", async () => {
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    let projectDir: string | undefined;
    let agentDir: string | undefined;
    let runner: ExtensionRunner | undefined;
    let sessionStarted = false;
    let sessionShutdown = false;

    try {
      projectDir = mkdtempSync(join(tmpdir(), "subagents-pi-project-"));
      agentDir = mkdtempSync(join(tmpdir(), "subagents-pi-agent-"));
      process.env.PI_CODING_AGENT_DIR = agentDir;
      const result = await discoverAndLoadExtensions(
        [resolve("src/index.ts")],
        projectDir,
        agentDir,
      );

      expect(result.errors).toEqual([]);
      expect(result.extensions).toHaveLength(1);
      const extension = result.extensions[0]!;
      expect([...extension.tools.keys()]).toEqual(["Agent", "StopAgent", "AgentStatus"]);
      expect([...extension.commands.keys()]).toEqual(["agents"]);

      runner = new ExtensionRunner(
        result.extensions,
        result.runtime,
        projectDir,
        SessionManager.inMemory(projectDir),
        new ModelRegistry(await ModelRuntime.create({ modelsPath: null })),
      );
      const handlerErrors: unknown[] = [];
      runner.onError((error) => handlerErrors.push(error));

      expect(runner.hasUI()).toBe(false);
      expect(runner.hasHandlers("tool_call")).toBe(true);
      expect(runner.hasHandlers("before_agent_start")).toBe(true);
      expect(runner.hasHandlers("tool_execution_start")).toBe(true);
      expect(runner.hasHandlers("session_start")).toBe(true);
      expect(runner.hasHandlers("session_shutdown")).toBe(true);

      sessionStarted = true;
      await runner.emit({ type: "session_start", reason: "startup" });
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      sessionShutdown = true;

      expect(handlerErrors).toEqual([]);

      const schema = extension.tools.get("Agent")!.definition.parameters as any;
      expect(schema.additionalProperties).toBe(false);
      expect(schema.required).toEqual(expect.arrayContaining(["prompt", "agent"]));
      expect(schema.properties.agent.type).toBe("string");
      expect(schema.properties).not.toHaveProperty("model");
      expect(schema.properties).not.toHaveProperty("thinking");
    } finally {
      try {
        if (runner && sessionStarted && !sessionShutdown) {
          await runner.emit({ type: "session_shutdown", reason: "quit" });
        }
      } finally {
        if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
        try {
          if (agentDir) rmSync(agentDir, { recursive: true, force: true });
        } finally {
          if (projectDir) rmSync(projectDir, { recursive: true, force: true });
        }
      }
    }
  });
});
