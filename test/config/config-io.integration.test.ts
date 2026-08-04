import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createConfigFileIO } from "../../src/config/config-io.ts";

let testDir: string | undefined;

// Hosted Windows runners can take several seconds just to cold-start Bun.
// The process deadline remains below the explicit test deadlines below.
const PROCESS_TIMEOUT_MS = 10_000;

function runBunScript(script: string, args: string[], label: string, timeoutMs = PROCESS_TIMEOUT_MS): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const bunExecutable = process.env.BUN_EXE ?? (process.platform === "win32" ? "bun.exe" : "bun");
    const child = spawn(bunExecutable, ["-e", script, ...args], { cwd: testDir!, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let spawnError: Error | undefined;
    let timedOut = false;
    child.stderr?.on("data", (data) => { stderr += data; });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once("error", (error) => { spawnError = error; });
    // `close`, unlike `exit`, waits for all child stdio handles to close. In the
    // timeout case this also keeps Windows cleanup from racing the killed child.
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) reject(new Error(`${label} timed out after ${timeoutMs}ms: ${stderr}`));
      else if (spawnError) reject(spawnError);
      else if (code === 0) resolveRun();
      else reject(new Error(`${label} exited ${code}: ${stderr}`));
    });
  });
}

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
  it("kills a hung child and waits for it to close", async () => {
    await loadConfigModule();
    const script = "setInterval(() => {}, 1_000);";

    await expect(runBunScript(script, [], "hung child", 100)).rejects.toThrow("hung child timed out after 100ms");
  });

  it("loads complete defaults when the file is missing or invalid", async () => {
    const configIo = await loadConfigModule();
    expect(configIo.loadConfig().config).toMatchObject({
      concurrency: { default: 4 },
      agent: { orchestrationPrompt: true },
    });

    writeFileSync(join(testDir!, "subagents-lean.json"), "{broken", "utf8");
    expect(configIo.loadConfig().config).toMatchObject({ concurrency: { default: 4 }, agent: { orchestrationPrompt: true } });
  });

  it("atomically saves a config that can be loaded again", async () => {
    const configIo = await loadConfigModule();
    const config = configIo.loadConfig().config;
    config.concurrency.default = 7;
    config.agent.includeContextFiles = false;
    (config as any).agent.ignoredRole = "openai/test";
    (config as any).ignoredRoot = { scout: "high" };

    configIo.saveConfigAtomic(config);

    const configPath = join(testDir!, "subagents-lean.json");
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
      concurrency: { default: 7 },
      agent: { includeContextFiles: false }
    });
    expect(existsSync(`${configPath}.tmp`)).toBe(false);
    expect(configIo.loadConfig().config).toMatchObject({ concurrency: { default: 7 }, agent: { includeContextFiles: false } });
  });

  it("covers shape, update, recovery, and stale-lock paths on one static module instance", () => {
    const directory = mkdtempSync(join(tmpdir(), "subagents-config-static-"));
    testDir = directory;
    const configPath = join(directory, "subagents-lean.json");
    const lockPath = `${configPath}.lock`;
    const killCalls: Array<[number, 0]> = [];
    const kill = (pid: number, signal: 0): void => {
      killCalls.push([pid, signal]);
      throw Object.assign(new Error("stale owner is gone"), { code: "ESRCH" });
    };
    const io = createConfigFileIO(directory, {
      lockTimeoutMs: 0,
      staleLockMs: 10,
      now: () => 31_000,
      hostname: () => "static-test-host",
      kill,
    });

    expect(io.load().health).toBe("healthy");
    for (const [contents, healthy] of [
      ["null", false],
      [JSON.stringify({ agent: "not-an-object" }), false],
      [JSON.stringify({ concurrency: "not-an-object" }), false],
      [JSON.stringify({}), true],
      [JSON.stringify({ agent: {}, concurrency: {} }), true]
    ] as const) {
      writeFileSync(configPath, contents, "utf8");
      expect(io.load().health).toBe(healthy ? "healthy" : "unrecoverable");
    }

    const primary = JSON.stringify({ agent: {}, concurrency: { default: 4 } });
    writeFileSync(configPath, primary, "utf8");
    io.update((config) => { config.agent.orchestrationPrompt = true; });
    expect(readFileSync(`${configPath}.bak`, "utf8")).toBe(primary);
    expect(JSON.parse(readFileSync(configPath, "utf8")).agent.orchestrationPrompt).toBe(true);

    writeFileSync(configPath, "{broken", "utf8");
    writeFileSync(`${configPath}.bak`, JSON.stringify({ agent: {}, concurrency: { default: 9 } }), "utf8");
    expect(io.load()).toMatchObject({ health: "using-backup", canRepair: true });
    expect(io.repair()).toMatchObject({ health: "healthy", config: { concurrency: { default: 9 } } });
    expect(readdirSync(directory).some((name) => name.startsWith("subagents-lean.json.corrupt-"))).toBe(true);

    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
      token: "stale-owner",
      pid: 321,
      hostname: "static-test-host",
      createdAt: 0,
    }), "utf8");
    io.update((config) => { config.agent.orchestrationPrompt = true; });
    expect(killCalls).toEqual([[321, 0]]);
    expect(existsSync(lockPath)).toBe(false);
  });

  it.each(["{broken", "42", "null", "[]"]) ("reads corrupt config %j as defaults without overwriting its bytes", async (contents) => {
    const configIo = await loadConfigModule();
    const configPath = join(testDir!, "subagents-lean.json");
    writeFileSync(configPath, contents, "utf8");

    expect(configIo.loadConfig().config).toMatchObject({ concurrency: { default: 4 }, agent: { orchestrationPrompt: true } });
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
    const primary = JSON.stringify({ agent: {}, concurrency: { default: 4 } });
    const configPath = join(testDir!, "subagents-lean.json");
    writeFileSync(configPath, primary, "utf8");

    createConfigFileIO(testDir!).update((config) => { config.agent.orchestrationPrompt = true; });

    expect(readFileSync(`${configPath}.bak`, "utf8")).toBe(primary);
    expect(JSON.parse(readFileSync(configPath, "utf8")).agent.orchestrationPrompt).toBe(true);
  });

  it("uses a valid backup without overwriting a corrupt primary, then repairs with an archive", async () => {
    const { createConfigFileIO } = await loadConfigModule();
    const configPath = join(testDir!, "subagents-lean.json");
    writeFileSync(configPath, "{broken", "utf8");
    writeFileSync(`${configPath}.bak`, JSON.stringify({
      agent: {
        dynamicModel: "provider/model",
        dynamicNumber: 42,
        dynamicBoolean: true,
      },
      concurrency: { default: 4 },
    }), "utf8");
    const io = createConfigFileIO(testDir!);

    expect(io.load()).toMatchObject({ health: "using-backup", canRepair: true, config: { agent: {} } });
    expect(() => io.update(() => undefined)).toThrow("primary config is corrupt");
    expect(readFileSync(configPath, "utf8")).toBe("{broken");

    expect(io.repair()).toMatchObject({ health: "healthy", config: { agent: {} } });
    const repairedAgent = JSON.parse(readFileSync(configPath, "utf8")).agent;
    expect(repairedAgent).toEqual({
      includeContextFiles: true,
      disableDefaultAgents: false,
      orchestrationPrompt: true,
    });
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
    writeFileSync(`${configPath}.bak`, JSON.stringify({ agent: {}, concurrency: { default: 4 } }));
    const io = createConfigFileIO(testDir!);
    expect(io.load()).toMatchObject({ health: "using-backup", canRepair: false, config: { agent: {} } });
    expect(() => io.repair()).toThrow("Cannot repair config");
    expect(existsSync(configPath)).toBe(true);
  });

  it("ignores incomplete owner-pending directories left by interrupted acquires for update and repair", async () => {
    const { createConfigFileIO } = await loadConfigModule();
    const configPath = join(testDir!, "subagents-lean.json");
    writeFileSync(configPath, JSON.stringify({ agent: {}, concurrency: { default: 4 } }));
    const missingOwner = `${configPath}.lock.pending-missing`;
    const brokenOwner = `${configPath}.lock.pending-broken`;
    mkdirSync(missingOwner);
    mkdirSync(brokenOwner);
    writeFileSync(join(brokenOwner, "owner.json"), "{broken");
    const io = createConfigFileIO(testDir!);

    io.update((config) => { config.agent.orchestrationPrompt = true; });
    expect(JSON.parse(readFileSync(configPath, "utf8")).agent.orchestrationPrompt).toBe(true);

    writeFileSync(configPath, "{broken");
    expect(io.repair()).toMatchObject({ health: "healthy", config: { agent: {} } });
    expect(existsSync(missingOwner)).toBe(true);
    expect(existsSync(brokenOwner)).toBe(true);
  });

  it("retains a lock whose owner token changes while an update holds it", async () => {
    const { createConfigFileIO } = await loadConfigModule();
    const configPath = join(testDir!, "subagents-lean.json");
    const lockPath = `${configPath}.lock`;
    const replacement = { token: "replacement-owner", pid: 1234, hostname: "replacement-host", createdAt: 0 };

    createConfigFileIO(testDir!).update(() => {
      writeFileSync(join(lockPath, "owner.json"), JSON.stringify(replacement), "utf8");
    });

    expect(existsSync(lockPath)).toBe(true);
    expect(JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"))).toEqual(replacement);
  });

  it("fails config persistence immediately when another live host owns the config lock", async () => {
    const { updateConfigAtomic, ConfigLockTimeoutError, CONFIG_LOCK_TIMEOUT_MS } = await loadConfigModule();
    const configPath = join(testDir!, "subagents-lean.json");
    const lockPath = `${configPath}.lock`;
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
      token: "other-process", pid: 999_999, hostname: "other-host", createdAt: Date.now(),
    }));

    expect(CONFIG_LOCK_TIMEOUT_MS).toBe(0);
    expect(() => updateConfigAtomic(() => undefined)).toThrow(ConfigLockTimeoutError);
    expect(existsSync(lockPath)).toBe(true);
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
    stale.update((config) => { config.agent.orchestrationPrompt = true; });
    expect(JSON.parse(readFileSync(configPath, "utf8")).agent.orchestrationPrompt).toBe(true);
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
    const run = () => runBunScript(script, [testDir!, markerPath], "reclaimer");

    await Promise.all([run(), run()]);
    expect(existsSync(markerPath)).toBe(false);
    expect(createConfigFileIO(testDir!).load().health).toBe("healthy");
  }, 15_000);

  it("serializes independent updates from real parallel writer processes", async () => {
    await loadConfigModule();
    const configPath = join(testDir!, "subagents-lean.json");
    writeFileSync(configPath, JSON.stringify({ agent: { orchestrationPrompt: true }, concurrency: { default: 4 } }));
    const moduleUrl = pathToFileURL(resolve("src/config/config-io.ts")).href;
    const script = `import { createConfigFileIO } from ${JSON.stringify(moduleUrl)}; const io = createConfigFileIO(process.argv[1]); io.update(c => { c.agent[process.argv[2]] = process.argv[3] === 'true'; });`;
    const run = (field: string) => runBunScript(script, [testDir!, field, "true"], "writer");

    await Promise.all([run("includeContextFiles"), run("orchestrationPrompt")]);
    expect(JSON.parse(readFileSync(configPath, "utf8")).agent).toMatchObject({ includeContextFiles: true, orchestrationPrompt: true });
  }, 15_000);
});
