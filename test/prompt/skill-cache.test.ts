import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Skill } from "@earendil-works/pi-coding-agent";
import {
  loadPiDefaultSkillsCachedAsync,
  loadSkillsFromDirCachedAsync,
} from "../../src/prompt/skill-cache.ts";
import {
  MAX_RESOURCE_FINGERPRINT_DEPTH,
  MAX_SKILL_IGNORE_BYTES,
  MAX_SKILL_MARKDOWN_BYTES,
  MAX_SKILL_RELEVANT_BYTES_PER_ROOT,
} from "../../src/prompt/skill-fingerprint.ts";
import { MAX_SKILL_METADATA_PAYLOAD_BYTES } from "../../src/prompt/skill-limits.ts";
import { canCreateDirectoryLinks, createDirectoryLink } from "../fixtures.ts";

let root = "";

function makeSkill(name: string, description: string, filePath: string): Skill {
  return {
    name,
    description,
    filePath,
    baseDir: join(filePath, ".."),
    sourceInfo: {} as Skill["sourceInfo"],
    disableModelInvocation: false,
  };
}

beforeEach(() => {
  root = join(tmpdir(), `skill-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.clearAllMocks();
});

describe("skill source caches", () => {
  it("reuses detached entries and invalidates them when a tree changes", async () => {
    const dir = join(root, "skills");
    const file = join(dir, "cached", "SKILL.md");
    let loaded: Skill[] = [];
    const runPiSkillLoader = vi.fn(async () => loaded);

    await expect(loadSkillsFromDirCachedAsync(dir, "agents", runPiSkillLoader)).resolves.toEqual([]);
    await expect(loadSkillsFromDirCachedAsync(dir, "agents", runPiSkillLoader)).resolves.toEqual([]);
    expect(runPiSkillLoader).toHaveBeenCalledOnce();

    mkdirSync(join(dir, "cached"), { recursive: true });
    writeFileSync(file, "initial");
    loaded = [makeSkill("cached", "Initial", file)];
    await expect(loadSkillsFromDirCachedAsync(dir, "agents", runPiSkillLoader)).resolves.toEqual(loaded);
    const result = await loadSkillsFromDirCachedAsync(dir, "agents", runPiSkillLoader);
    result[0]!.description = "caller mutation";
    await expect(loadSkillsFromDirCachedAsync(dir, "agents", runPiSkillLoader)).resolves.toEqual(loaded);
    expect(runPiSkillLoader).toHaveBeenCalledTimes(2);

    writeFileSync(file, "changed");
    const changedAt = new Date(Date.now() + 2_000);
    utimesSync(file, changedAt, changedAt);
    loaded = [makeSkill("cached", "Changed", file)];
    await expect(loadSkillsFromDirCachedAsync(dir, "agents", runPiSkillLoader)).resolves.toEqual(loaded);
    expect(runPiSkillLoader).toHaveBeenCalledTimes(3);
  });

  it("does not retain an uncertain broken-link snapshot", async () => {
    if (!canCreateDirectoryLinks()) return;
    const dir = join(root, "skills");
    const target = join(root, "target");
    const link = join(dir, "broken");
    mkdirSync(dir, { recursive: true });
    mkdirSync(target);
    createDirectoryLink(target, link);
    rmSync(target, { recursive: true, force: true });

    const runPiSkillLoader = vi.fn(async () => [] as Skill[]);
    await expect(loadSkillsFromDirCachedAsync(dir, "agents", runPiSkillLoader)).resolves.toEqual([]);
    await expect(loadSkillsFromDirCachedAsync(dir, "agents", runPiSkillLoader)).resolves.toEqual([]);
    expect(runPiSkillLoader).toHaveBeenCalledTimes(2);
  });

  it("reuses stable source entries between async callers", async () => {
    const dir = join(root, "skills");
    const skillPath = join(dir, "async", "SKILL.md");
    const skill = makeSkill("async", "From async cache", skillPath);
    const runPiSkillLoader = vi.fn(async () => [skill]);

    await expect(loadSkillsFromDirCachedAsync(dir, "agents", runPiSkillLoader)).resolves.toEqual([skill]);
    await expect(loadSkillsFromDirCachedAsync(dir, "agents", runPiSkillLoader)).resolves.toEqual([skill]);
    expect(runPiSkillLoader).toHaveBeenCalledOnce();
  });

  it("rejects an oversized relevant Markdown file before the Pi worker", async () => {
    const dir = join(root, "oversized-skill");
    const file = join(dir, "large", "SKILL.md");
    mkdirSync(join(dir, "large"), { recursive: true });
    writeFileSync(file, "x");
    truncateSync(file, MAX_SKILL_MARKDOWN_BYTES + 1);
    const runPiSkillLoader = vi.fn(async () => [] as Skill[]);

    await expect(loadSkillsFromDirCachedAsync(dir, "agents", runPiSkillLoader))
      .rejects.toThrow(`maximum ${MAX_SKILL_MARKDOWN_BYTES} bytes`);
    expect(runPiSkillLoader).not.toHaveBeenCalled();
  });

  it("charges direct agents-root Markdown to the pre-worker file budget", async () => {
    const dir = join(root, "oversized-agents-root");
    const file = join(dir, "root.md");
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, "x");
    truncateSync(file, MAX_SKILL_MARKDOWN_BYTES + 1);
    const runPiSkillLoader = vi.fn(async () => [] as Skill[]);

    await expect(loadSkillsFromDirCachedAsync(dir, "agents", runPiSkillLoader))
      .rejects.toThrow(`maximum ${MAX_SKILL_MARKDOWN_BYTES} bytes`);
    expect(runPiSkillLoader).not.toHaveBeenCalled();
  });

  it("rejects an oversized worker metadata payload before caching", async () => {
    const dir = join(root, "oversized-worker-result");
    mkdirSync(dir, { recursive: true });
    const skills = Array.from({ length: 10_000 }, (_, index) => makeSkill(
      `skill-${index}`,
      "😀".repeat(256),
      join(dir, `skill-${index}`, "SKILL.md"),
    ));
    const runPiSkillLoader = vi.fn(async () => skills);

    await expect(loadSkillsFromDirCachedAsync(dir, "agents", runPiSkillLoader))
      .rejects.toThrow(`maximum of ${MAX_SKILL_METADATA_PAYLOAD_BYTES} UTF-8 bytes`);
    expect(runPiSkillLoader).toHaveBeenCalledOnce();
    await expect(loadSkillsFromDirCachedAsync(dir, "agents", runPiSkillLoader))
      .rejects.toThrow(`maximum of ${MAX_SKILL_METADATA_PAYLOAD_BYTES} UTF-8 bytes`);
    expect(runPiSkillLoader).toHaveBeenCalledTimes(2);
  });

  it("rejects an oversized ignore file before the Pi worker", async () => {
    const dir = join(root, "oversized-ignore");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, ".gitignore");
    writeFileSync(file, "x");
    truncateSync(file, MAX_SKILL_IGNORE_BYTES + 1);
    const runPiSkillLoader = vi.fn(async () => [] as Skill[]);

    await expect(loadSkillsFromDirCachedAsync(dir, "agents", runPiSkillLoader))
      .rejects.toThrow(`maximum ${MAX_SKILL_IGNORE_BYTES} bytes`);
    expect(runPiSkillLoader).not.toHaveBeenCalled();
  });

  it("charges the aggregate byte budget for direct agents-root Markdown", async () => {
    const dir = join(root, "oversized-agents-total");
    mkdirSync(dir, { recursive: true });
    const fileCount = Math.floor(MAX_SKILL_RELEVANT_BYTES_PER_ROOT / MAX_SKILL_MARKDOWN_BYTES) + 1;
    for (let index = 0; index < fileCount; index++) {
      const file = join(dir, `root-${index}.md`);
      writeFileSync(file, "x");
      truncateSync(file, MAX_SKILL_MARKDOWN_BYTES);
    }
    const runPiSkillLoader = vi.fn(async () => [] as Skill[]);

    await expect(loadSkillsFromDirCachedAsync(dir, "agents", runPiSkillLoader))
      .rejects.toThrow(`maximum ${MAX_SKILL_RELEVANT_BYTES_PER_ROOT} relevant bytes`);
    expect(runPiSkillLoader).not.toHaveBeenCalled();
  });

  it("fails closed when relevant bytes exceed the per-root budget", async () => {
    const dir = join(root, "oversized-total");
    const fileCount = Math.floor(MAX_SKILL_RELEVANT_BYTES_PER_ROOT / MAX_SKILL_MARKDOWN_BYTES) + 1;
    for (let index = 0; index < fileCount; index++) {
      const skillDir = join(dir, `skill-${index}`);
      mkdirSync(skillDir, { recursive: true });
      const file = join(skillDir, "SKILL.md");
      writeFileSync(file, "x");
      truncateSync(file, MAX_SKILL_MARKDOWN_BYTES);
    }
    const runPiSkillLoader = vi.fn(async () => [] as Skill[]);

    await expect(loadSkillsFromDirCachedAsync(dir, "agents", runPiSkillLoader))
      .rejects.toThrow(`maximum ${MAX_SKILL_RELEVANT_BYTES_PER_ROOT} relevant bytes`);
    expect(runPiSkillLoader).not.toHaveBeenCalled();
  });

  it("fails closed when a stable source changes during worker discovery", async () => {
    const dir = join(root, "worker-race", "race");
    const file = join(dir, "SKILL.md");
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, "before");
    const runPiSkillLoader = vi.fn(async () => {
      writeFileSync(file, "after");
      utimesSync(file, new Date(Date.now() + 2_000), new Date(Date.now() + 2_000));
      return [] as Skill[];
    });

    await expect(loadSkillsFromDirCachedAsync(join(root, "worker-race"), "agents", runPiSkillLoader))
      .rejects.toThrow("changed during Pi discovery");
  });

  it("fails closed before either Pi loader when the fingerprint depth budget is exceeded", async () => {
    const dir = join(root, "pathological");
    mkdirSync(dir);
    let current = dir;
    for (let depth = 1; depth <= MAX_RESOURCE_FINGERPRINT_DEPTH + 1; depth++) {
      current = join(current, "d");
      mkdirSync(current);
    }
    const runPiSkillLoader = vi.fn(async () => [] as Skill[]);
    const message = `maximum depth ${MAX_RESOURCE_FINGERPRINT_DEPTH}`;

    await expect(loadSkillsFromDirCachedAsync(dir, "agents", runPiSkillLoader)).rejects.toThrow(message);
    expect(runPiSkillLoader).not.toHaveBeenCalled();
  });

  it("bounds both async source caches with LRU retention", async () => {
    const agentDir = join(root, "agent");
    const runPiSkillLoader = vi.fn(async () => [] as Skill[]);
    const cwdPaths = Array.from({ length: 128 }, (_, index) => join(root, `cwd-${index}`));
    for (const cwd of cwdPaths) await loadPiDefaultSkillsCachedAsync(cwd, agentDir, true, runPiSkillLoader);
    const defaultCalls = runPiSkillLoader.mock.calls.length;
    await loadPiDefaultSkillsCachedAsync(cwdPaths[0]!, agentDir, true, runPiSkillLoader);
    expect(runPiSkillLoader).toHaveBeenCalledTimes(defaultCalls);
    await loadPiDefaultSkillsCachedAsync(join(root, "cwd-extra"), agentDir, true, runPiSkillLoader);
    await loadPiDefaultSkillsCachedAsync(cwdPaths[0]!, agentDir, true, runPiSkillLoader);
    expect(runPiSkillLoader).toHaveBeenCalledTimes(defaultCalls + 1);

    const dirs = Array.from({ length: 128 }, (_, index) => join(root, `source-${index}`));
    for (const dir of dirs) await loadSkillsFromDirCachedAsync(dir, "agents", runPiSkillLoader);
    const sourceCalls = runPiSkillLoader.mock.calls.length;
    await loadSkillsFromDirCachedAsync(dirs[0]!, "agents", runPiSkillLoader);
    expect(runPiSkillLoader).toHaveBeenCalledTimes(sourceCalls);
    await loadSkillsFromDirCachedAsync(join(root, "source-extra"), "agents", runPiSkillLoader);
    await loadSkillsFromDirCachedAsync(dirs[0]!, "agents", runPiSkillLoader);
    expect(runPiSkillLoader).toHaveBeenCalledTimes(sourceCalls + 1);
  });
});
