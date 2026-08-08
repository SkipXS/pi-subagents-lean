import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigFileIO } from "../../src/config/config-io.ts";
import { MAX_SUBAGENTS_CONFIG_BYTES } from "../../src/config/types.ts";

let testDirs: string[] = [];

function makeDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "subagents-config-"));
  testDirs.push(directory);
  return directory;
}

function configPath(directory: string): string {
  return join(directory, "subagents-lean.json");
}

afterEach(() => {
  for (const directory of testDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("read-only config I/O with the real filesystem", () => {
  it("loads and normalizes a valid primary without changing it", () => {
    const directory = makeDir();
    const path = configPath(directory);
    const contents = JSON.stringify({
      agent: { includeContextFiles: false, ignored: true },
      agents: { Scout: { thinking: "high", ignored: true } },
      concurrency: { default: 2 },
    });
    writeFileSync(path, contents, "utf8");

    expect(createConfigFileIO(directory).load()).toEqual({
      agent: { includeContextFiles: false, disableDefaultAgents: false, orchestrationPrompt: true },
      agents: { scout: { thinking: "high" } },
      concurrency: { default: 2 },
    });
    expect(readFileSync(path, "utf8")).toBe(contents);
  });

  it("uses defaults for a missing primary even when a backup exists", () => {
    const directory = makeDir();
    const path = configPath(directory);
    const backup = `${path}.bak`;
    const backupContents = JSON.stringify({ concurrency: { default: 9 } });
    writeFileSync(backup, backupContents, "utf8");

    expect(createConfigFileIO(directory).load()).toEqual({
      agent: { includeContextFiles: true, disableDefaultAgents: false, orchestrationPrompt: true },
      concurrency: { default: 4 },
    });
    expect(readFileSync(backup, "utf8")).toBe(backupContents);
  });

  it("uses a valid backup for an invalid primary and preserves both files", () => {
    const directory = makeDir();
    const path = configPath(directory);
    const primaryContents = "{broken";
    const backupContents = JSON.stringify({ agent: {}, concurrency: { default: 7 } });
    writeFileSync(path, primaryContents, "utf8");
    writeFileSync(`${path}.bak`, backupContents, "utf8");

    expect(createConfigFileIO(directory).load().concurrency).toEqual({ default: 7 });
    expect(readFileSync(path, "utf8")).toBe(primaryContents);
    expect(readFileSync(`${path}.bak`, "utf8")).toBe(backupContents);
  });

  it("uses a valid backup when the primary is unreadable", () => {
    const directory = makeDir();
    const path = configPath(directory);
    const backup = `${path}.bak`;
    writeFileSync(backup, JSON.stringify({ concurrency: { default: 3 } }), "utf8");
    // A directory at the primary path is readable by lstat but not as a JSON file.
    const primaryDirectory = path;
    const nestedEntry = join(primaryDirectory, "keep");
    mkdirSync(primaryDirectory);
    writeFileSync(nestedEntry, "fixture", "utf8");

    expect(createConfigFileIO(directory).load().concurrency).toEqual({ default: 3 });
    expect(existsSync(primaryDirectory)).toBe(true);
    expect(readFileSync(nestedEntry, "utf8")).toBe("fixture");
  });

  it("uses a valid backup when the primary exceeds the one MiB read bound", () => {
    const directory = makeDir();
    const path = configPath(directory);
    const oversized = Buffer.alloc(MAX_SUBAGENTS_CONFIG_BYTES + 1, 0x7b);
    const backupContents = JSON.stringify({ concurrency: { default: 6 } });
    writeFileSync(path, oversized);
    writeFileSync(`${path}.bak`, backupContents, "utf8");

    expect(createConfigFileIO(directory).load().concurrency).toEqual({ default: 6 });
    expect(readFileSync(path)).toEqual(oversized);
    expect(readFileSync(`${path}.bak`, "utf8")).toBe(backupContents);
  });

  it.each(["{broken", "null", "42", "[]"])("returns defaults for invalid primary %j without replacing it", (contents) => {
    const directory = makeDir();
    const path = configPath(directory);
    writeFileSync(path, contents, "utf8");

    expect(createConfigFileIO(directory).load().concurrency).toEqual({ default: 4 });
    expect(readFileSync(path, "utf8")).toBe(contents);
  });

  it("does not create a missing config directory while loading defaults", () => {
    const parent = makeDir();
    const missingDirectory = join(parent, "not-created");

    expect(createConfigFileIO(missingDirectory).load().concurrency).toEqual({ default: 4 });
    expect(existsSync(missingDirectory)).toBe(false);
  });

  it("does not add files or change bytes during a load", () => {
    const directory = makeDir();
    const path = configPath(directory);
    const contents = JSON.stringify({ agent: {}, concurrency: { default: 4 } });
    writeFileSync(path, contents, "utf8");
    const beforeNames = readdirSync(directory).sort();

    createConfigFileIO(directory).load();

    expect(readdirSync(directory).sort()).toEqual(beforeNames);
    expect(readFileSync(path, "utf8")).toBe(contents);
  });
});
