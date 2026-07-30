import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

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
    expect(configIo.loadConfig().config).toMatchObject({
      concurrency: { default: 4 },
      agent: { forceBackground: false, graceTurns: 6, widgetMaxLines: 12 },
      thinkingOverrides: {},
    });

    writeFileSync(join(testDir!, "subagents-lean.json"), "{broken", "utf8");
    expect(configIo.loadConfig().config).toMatchObject({ concurrency: { default: 4 }, thinkingOverrides: {} });
  });

  it("atomically saves a config that can be loaded again", async () => {
    const configIo = await loadConfigModule();
    const config = configIo.loadConfig().config;
    config.concurrency.default = 7;
    config.agent.default = "openai/test";

    configIo.saveConfigAtomic(config);

    const configPath = join(testDir!, "subagents-lean.json");
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
      concurrency: { default: 7 },
      agent: { default: "openai/test" },
    });
    expect(existsSync(`${configPath}.tmp`)).toBe(false);
    expect(configIo.loadConfig().config).toMatchObject({ concurrency: { default: 7 } });
  });

  it("normalizes legacy values from a real config file", async () => {
    const configIo = await loadConfigModule();
    writeFileSync(join(testDir!, "subagents-lean.json"), JSON.stringify({
      agent: { Explore: "legacy/scout", defaultThinking: "invalid" },
      concurrency: { default: 2, providers: { local: 1 } },
      thinkingOverrides: { reviewer: "high" },
    }), "utf8");

    expect(configIo.loadConfig().config).toMatchObject({
      concurrency: { default: 2 },
      agent: { scout: "legacy/scout" },
      thinkingOverrides: { reviewer: "high" },
    });
    expect(configIo.loadConfig().config.agent.defaultThinking).toBeUndefined();
  });

  it.each(["{broken", "42", "null", "[]"]) ("reads corrupt config %j as defaults without overwriting its bytes", async (contents) => {
    const configIo = await loadConfigModule();
    const configPath = join(testDir!, "subagents-lean.json");
    writeFileSync(configPath, contents, "utf8");

    expect(configIo.loadConfig().config).toMatchObject({ concurrency: { default: 4 }, thinkingOverrides: {} });
    expect(() => configIo.saveConfigAtomic(configIo.loadConfig().config)).toThrow("primary config is corrupt");
    expect(readFileSync(configPath, "utf8")).toBe(contents);
  });

  it("does not overwrite an unreadable primary", async () => {
    const configIo = await loadConfigModule();
    const config = configIo.loadConfig().config;
    const configPath = join(testDir!, "subagents-lean.json");
    mkdirSync(configPath);

    expect(() => configIo.saveConfigAtomic(config)).toThrow("primary config is corrupt or unreadable");
    expect(existsSync(configPath)).toBe(true);
  });

  it("rotates the last valid primary into .bak before an update", async () => {
    const { createConfigFileIO } = await loadConfigModule();
    const primary = JSON.stringify({ agent: { showCost: false }, concurrency: { default: 4 } });
    const configPath = join(testDir!, "subagents-lean.json");
    writeFileSync(configPath, primary, "utf8");

    createConfigFileIO(testDir!).update((config) => { config.agent.showCost = true; });

    expect(readFileSync(`${configPath}.bak`, "utf8")).toBe(primary);
    expect(JSON.parse(readFileSync(configPath, "utf8")).agent.showCost).toBe(true);
  });

  it("uses a valid backup without overwriting a corrupt primary, then repairs with an archive", async () => {
    const { createConfigFileIO } = await loadConfigModule();
    const configPath = join(testDir!, "subagents-lean.json");
    writeFileSync(configPath, "{broken", "utf8");
    writeFileSync(`${configPath}.bak`, JSON.stringify({ agent: { showCost: true }, concurrency: { default: 4 } }), "utf8");
    const io = createConfigFileIO(testDir!);

    expect(io.load()).toMatchObject({ health: "using-backup", canRepair: true, config: { agent: { showCost: true } } });
    expect(() => io.update(() => undefined)).toThrow("primary config is corrupt");
    expect(readFileSync(configPath, "utf8")).toBe("{broken");

    expect(io.repair()).toMatchObject({ health: "healthy", config: { agent: { showCost: true } } });
    expect(JSON.parse(readFileSync(configPath, "utf8")).agent.showCost).toBe(true);
    const archives = readdirSync(testDir!).filter((name) => name.startsWith("subagents-lean.json.corrupt-"));
    expect(archives).toHaveLength(1);
    expect(readFileSync(join(testDir!, archives[0]!), "utf8")).toBe("{broken");
  });

  it("does not offer repair when no valid backup exists", async () => {
    const { createConfigFileIO } = await loadConfigModule();
    writeFileSync(join(testDir!, "subagents-lean.json"), "{broken", "utf8");
    const io = createConfigFileIO(testDir!);
    expect(io.load()).toMatchObject({ health: "unrecoverable", canRepair: false });
    expect(() => io.repair()).toThrow("Cannot repair config");
  });

  it("uses a backup for an unreadable primary but never offers an overwrite repair", async () => {
    const { createConfigFileIO } = await loadConfigModule();
    const configPath = join(testDir!, "subagents-lean.json");
    mkdirSync(configPath);
    writeFileSync(`${configPath}.bak`, JSON.stringify({ agent: { showCost: true }, concurrency: { default: 4 } }));
    const io = createConfigFileIO(testDir!);
    expect(io.load()).toMatchObject({ health: "using-backup", canRepair: false, config: { agent: { showCost: true } } });
    expect(() => io.repair()).toThrow("Cannot repair config");
    expect(existsSync(configPath)).toBe(true);
  });

  it("ignores incomplete owner-pending directories left by interrupted acquires for update and repair", async () => {
    const { createConfigFileIO } = await loadConfigModule();
    const configPath = join(testDir!, "subagents-lean.json");
    writeFileSync(configPath, JSON.stringify({ agent: { showCost: false }, concurrency: { default: 4 } }));
    const missingOwner = `${configPath}.lock.pending-missing`;
    const brokenOwner = `${configPath}.lock.pending-broken`;
    mkdirSync(missingOwner);
    mkdirSync(brokenOwner);
    writeFileSync(join(brokenOwner, "owner.json"), "{broken");
    const io = createConfigFileIO(testDir!);

    io.update((config) => { config.agent.showCost = true; });
    expect(JSON.parse(readFileSync(configPath, "utf8")).agent.showCost).toBe(true);

    writeFileSync(configPath, "{broken");
    expect(io.repair()).toMatchObject({ health: "healthy", config: { agent: { showCost: false } } });
    expect(existsSync(missingOwner)).toBe(true);
    expect(existsSync(brokenOwner)).toBe(true);
  });

  it("only removes proven-dead local stale locks and times out for foreign locks", async () => {
    const { createConfigFileIO, ConfigLockTimeoutError } = await loadConfigModule();
    const configPath = join(testDir!, "subagents-lean.json");
    const lockPath = `${configPath}.lock`;
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ token: "foreign", pid: 999_999, hostname: "other-host", createdAt: 0 }));
    const foreign = createConfigFileIO(testDir!, { lockTimeoutMs: 0, now: () => 31_000, hostname: () => "local-host", kill: () => { throw Object.assign(new Error(), { code: "ESRCH" }); } });
    expect(() => foreign.update(() => undefined)).toThrow(ConfigLockTimeoutError);
    expect(existsSync(lockPath)).toBe(true);

    rmSync(lockPath, { recursive: true });
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ token: "protected", pid: 999_999, hostname: "local-host", createdAt: 0 }));
    const protectedLock = createConfigFileIO(testDir!, { lockTimeoutMs: 0, now: () => 31_000, hostname: () => "local-host", kill: () => { throw Object.assign(new Error(), { code: "EPERM" }); } });
    expect(() => protectedLock.update(() => undefined)).toThrow(ConfigLockTimeoutError);
    expect(existsSync(lockPath)).toBe(true);

    rmSync(lockPath, { recursive: true });
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ token: "dead", pid: 999_999, hostname: "local-host", createdAt: 0 }));
    const stale = createConfigFileIO(testDir!, { lockTimeoutMs: 0, now: () => 31_000, hostname: () => "local-host", kill: () => { throw Object.assign(new Error(), { code: "ESRCH" }); } });
    stale.update((config) => { config.agent.showCost = true; });
    expect(JSON.parse(readFileSync(configPath, "utf8")).agent.showCost).toBe(true);
  });

  it("allows only one concurrent stale reclaimer into the critical section", async () => {
    const { createConfigFileIO } = await loadConfigModule();
    const configPath = join(testDir!, "subagents-lean.json");
    const lockPath = `${configPath}.lock`;
    const markerPath = join(testDir!, "critical-section.marker");
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
      token: "dead-owner",
      pid: 999_999,
      hostname: hostname(),
      createdAt: Date.now() - 60_000,
    }));
    const moduleUrl = pathToFileURL(resolve("src/config/config-io.ts")).href;
    const script = `import { createConfigFileIO } from ${JSON.stringify(moduleUrl)}; import { closeSync, openSync, unlinkSync } from "node:fs"; const io = createConfigFileIO(process.argv[1]); io.update(() => { const fd = openSync(process.argv[2], "wx"); try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150); } finally { closeSync(fd); unlinkSync(process.argv[2]); } });`;
    const run = () => new Promise<void>((resolveRun, reject) => {
      const bunExecutable = process.env.BUN_EXE ?? (process.platform === "win32" ? "bun.exe" : "bun");
      const child = spawn(bunExecutable, ["-e", script, testDir!, markerPath], { cwd: testDir!, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr?.on("data", (data) => { stderr += data; });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolveRun() : reject(new Error(`reclaimer exited ${code}: ${stderr}`)));
    });

    await Promise.all([run(), run()]);
    expect(existsSync(markerPath)).toBe(false);
    expect(createConfigFileIO(testDir!).load().health).toBe("healthy");
  });

  it("serializes independent updates from real parallel writer processes", async () => {
    await loadConfigModule();
    const configPath = join(testDir!, "subagents-lean.json");
    writeFileSync(configPath, JSON.stringify({ agent: { showCost: false, forceBackground: false }, concurrency: { default: 4 } }));
    const moduleUrl = pathToFileURL(resolve("src/config/config-io.ts")).href;
    const script = `import { createConfigFileIO } from ${JSON.stringify(moduleUrl)}; const io = createConfigFileIO(process.argv[1]); io.update(c => { c.agent[process.argv[2]] = process.argv[3] === 'true'; });`;
    const run = (field: string) => new Promise<void>((resolveRun, reject) => {
      const bunExecutable = process.env.BUN_EXE ?? (process.platform === "win32" ? "bun.exe" : "bun");
      const child = spawn(bunExecutable, ["-e", script, testDir!, field, "true"], { cwd: testDir!, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr?.on("data", (data) => { stderr += data; });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolveRun() : reject(new Error(`writer exited ${code}: ${stderr}`)));
    });

    await Promise.all([run("showCost"), run("forceBackground")]);
    expect(JSON.parse(readFileSync(configPath, "utf8")).agent).toMatchObject({ showCost: true, forceBackground: true });
  });
});
