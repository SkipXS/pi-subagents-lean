import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

let agentDir: string | undefined;

afterEach(() => {
  if (agentDir) rmSync(agentDir, { recursive: true, force: true });
  agentDir = undefined;
});

describe("Pi extension contract", () => {
  it("loads through Pi's public loader with the expected registrations", async () => {
    agentDir = mkdtempSync(join(tmpdir(), "subagents-pi-contract-"));
    const result = await discoverAndLoadExtensions(
      [resolve("src/index.ts")],
      process.cwd(),
      agentDir,
    );

    expect(result.errors).toEqual([]);
    expect(result.extensions).toHaveLength(1);
    const extension = result.extensions[0]!;
    expect([...extension.tools.keys()]).toEqual(["Agent", "StopAgent", "AgentStatus"]);
    expect([...extension.commands.keys()]).toEqual(["agents"]);
    expect([...extension.handlers.keys()]).toEqual(expect.arrayContaining([
      "tool_call",
      "before_agent_start",
      "tool_execution_start",
      "session_start",
      "session_shutdown",
    ]));

    const schema = extension.tools.get("Agent")!.definition.parameters as any;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(expect.arrayContaining(["prompt", "agent"]));
    expect(schema.properties.agent.type).toBe("string");
    expect(schema.properties).not.toHaveProperty("model");
    expect(schema.properties).not.toHaveProperty("thinking");
  });
});
