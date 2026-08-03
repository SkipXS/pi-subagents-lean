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
  type ExtensionActions,
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
      expect([...extension.tools.keys()]).toEqual(["Agent", "AgentContinue", "StopAgent", "AgentStatus"]);
      expect([...extension.commands.keys()]).toEqual([]);

      runner = new ExtensionRunner(
        result.extensions,
        result.runtime,
        projectDir,
        SessionManager.inMemory(projectDir),
        new ModelRegistry(await ModelRuntime.create({ modelsPath: null })),
      );
      const handlerErrors: unknown[] = [];
      runner.onError((error) => handlerErrors.push(error));

      // Bind through Pi's actual public runtime seam with a complete, usable
      // host action set. The test exercises registration/lifecycle only and
      // intentionally makes no model or provider request.
      let activeToolsReads = 0;
      const hostActions: ExtensionActions = {
        sendMessage: () => {},
        sendUserMessage: () => {},
        appendEntry: () => {},
        setSessionName: () => {},
        getSessionName: () => undefined,
        setLabel: () => {},
        getActiveTools: () => { activeToolsReads++; return ["Agent"]; },
        getAllTools: () => [],
        setActiveTools: () => {},
        refreshTools: () => {},
        getCommands: () => [],
        setModel: async () => true,
        getThinkingLevel: () => "off" as any,
        setThinkingLevel: () => {},
      };
      runner.bindCore(hostActions, {
        getModel: () => undefined,
        isIdle: () => true,
        isProjectTrusted: () => true,
        getSignal: () => undefined,
        abort: () => {},
        hasPendingMessages: () => false,
        shutdown: () => {},
        getContextUsage: () => undefined,
        compact: () => {},
        getSystemPrompt: () => "",
      } as any);
      runner.bindCommandContext();

      const publicContext = runner.createContext();
      expect(publicContext.isIdle()).toBe(true);
      expect(result.runtime.getActiveTools()).toEqual(["Agent"]);
      expect(activeToolsReads).toBe(1);
      expect(runner.getAllRegisteredTools().map((tool) => tool.definition.name).sort())
        .toEqual(["Agent", "AgentContinue", "AgentStatus", "StopAgent"]);
      for (const { definition } of runner.getAllRegisteredTools()) {
        expect(definition.description).toEqual(expect.any(String));
        expect(definition.description.length).toBeGreaterThan(0);
      }
      const contractAbort = new AbortController();
      contractAbort.abort();
      await expect(runner.getToolDefinition("Agent")!.execute(
        "contract-agent", { agent: "scout", prompt: "do not start" }, contractAbort.signal, undefined, publicContext,
      )).rejects.toThrow("Agent execution cancelled");
      await expect(runner.getToolDefinition("AgentStatus")!.execute(
        "contract-status", {}, undefined, undefined, publicContext,
      )).rejects.toThrow("root session is ready");
      await expect(runner.getToolDefinition("StopAgent")!.execute(
        "contract-stop", { agent_id: "missing" }, undefined, undefined, publicContext,
      )).rejects.toThrow("root session is ready");
      await expect(runner.getToolDefinition("AgentContinue")!.execute(
        "contract-continue", { agent_id: "missing", prompt: "wrap up" }, undefined, undefined, publicContext,
      )).rejects.toThrow("root session is ready");
      expect(runner.getMessageRenderer("subagent-result")).toEqual(expect.any(Function));
      expect(runner.hasUI()).toBe(false);
      expect(runner.hasHandlers("tool_call")).toBe(true);
      expect(runner.hasHandlers("before_agent_start")).toBe(true);
      expect(runner.hasHandlers("tool_execution_start")).toBe(true);
      expect(runner.hasHandlers("tool_execution_update")).toBe(true);
      expect(runner.hasHandlers("tool_result")).toBe(true);
      expect(runner.hasHandlers("message_end")).toBe(true);
      expect(runner.hasHandlers("session_start")).toBe(true);
      expect(runner.hasHandlers("session_shutdown")).toBe(true);

      sessionStarted = true;
      await runner.emit({ type: "session_start", reason: "startup" });
      const beforeAgentStart = await runner.emitBeforeAgentStart(
        "Verify the loaded extension lifecycle.",
        undefined,
        "You are a helpful assistant.",
        { cwd: projectDir },
      );
      expect(beforeAgentStart?.systemPrompt).toContain("[subagents-lean orchestration v1]");

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
  }, 15_000);
});
