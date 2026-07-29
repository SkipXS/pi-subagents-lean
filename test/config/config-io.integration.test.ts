import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let testDir: string | undefined;

async function loadConfigModule() {
  testDir = mkdtempSync(join(tmpdir(), "subagents-config-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", testDir);
  vi.resetModules();
  return import("../../src/config/config-io.ts");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  testDir = undefined;
});

describe("config I/O with the real filesystem", () => {
  it("loads complete defaults when the file is missing or invalid", async () => {
    const configIo = await loadConfigModule();
    expect(configIo.loadConfig()).toMatchObject({
      concurrency: { default: 4 },
      agent: { forceBackground: false, graceTurns: 6, widgetMaxLines: 12 },
      thinkingOverrides: {},
    });

    writeFileSync(join(testDir!, "subagents-lean.json"), "{broken", "utf8");
    expect(configIo.loadConfig()).toMatchObject({ concurrency: { default: 4 }, thinkingOverrides: {} });
  });

  it("atomically saves a config that can be loaded again", async () => {
    const configIo = await loadConfigModule();
    const config = configIo.loadConfig();
    config.concurrency.default = 7;
    config.agent.default = "openai/test";

    configIo.saveConfigAtomic(config);

    const configPath = join(testDir!, "subagents-lean.json");
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
      concurrency: { default: 7 },
      agent: { default: "openai/test" },
    });
    expect(existsSync(`${configPath}.tmp`)).toBe(false);
    expect(configIo.loadConfig()).toMatchObject({ concurrency: { default: 7 } });
  });

  it("normalizes legacy values from a real config file", async () => {
    const configIo = await loadConfigModule();
    writeFileSync(join(testDir!, "subagents-lean.json"), JSON.stringify({
      agent: { Explore: "legacy/scout", defaultThinking: "invalid" },
      concurrency: { default: 2, providers: { local: 1 } },
      thinkingOverrides: { reviewer: "high" },
    }), "utf8");

    expect(configIo.loadConfig()).toMatchObject({
      concurrency: { default: 2 },
      agent: { scout: "legacy/scout" },
      thinkingOverrides: { reviewer: "high" },
    });
    expect(configIo.loadConfig().agent.defaultThinking).toBeUndefined();
  });

  it.each(["{broken", "42", "null", "[]"]) ("reads corrupt config %j as defaults without overwriting its bytes", async (contents) => {
    const configIo = await loadConfigModule();
    const configPath = join(testDir!, "subagents-lean.json");
    writeFileSync(configPath, contents, "utf8");

    expect(configIo.loadConfig()).toMatchObject({ concurrency: { default: 4 }, thinkingOverrides: {} });
    expect(() => configIo.saveConfigAtomic(configIo.loadConfig())).toThrow("primary config is corrupt");
    expect(readFileSync(configPath, "utf8")).toBe(contents);
  });

  it("throws for a failed rename and removes only its unique temporary file", async () => {
    const configIo = await loadConfigModule();
    const config = configIo.loadConfig();
    const configPath = join(testDir!, "subagents-lean.json");
    mkdirSync(configPath);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() => configIo.saveConfigAtomic(config)).toThrow();

    expect(error).toHaveBeenCalledWith(expect.stringContaining("Failed to save config"));
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(`${configPath}.tmp`)).toBe(false);
  });
});
