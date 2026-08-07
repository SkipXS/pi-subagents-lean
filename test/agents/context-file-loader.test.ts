import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadBoundedContextFiles,
  MAX_CONTEXT_ANCESTOR_DIRECTORIES,
  MAX_CONTEXT_FILE_BYTES,
  MAX_CONTEXT_TOTAL_BYTES,
} from "../../src/agents/context-file-loader.js";
import { utf8ByteLength } from "../../src/agents/agent-string-limits.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("bounded context-file loader", () => {
  it("keeps global-first and root-to-cwd Pi candidate ordering", async () => {
    const root = mkdtempSync(join(tmpdir(), "context-loader-order-"));
    roots.push(root);
    const agentDir = join(root, "global");
    const projectRoot = join(root, "project");
    const cwd = join(projectRoot, "src");
    mkdirSync(agentDir);
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(agentDir, "AGENTS.md"), "global");
    writeFileSync(join(projectRoot, "AGENTS.md"), "root");
    writeFileSync(join(projectRoot, "CLAUDE.md"), "not selected");
    writeFileSync(join(cwd, "CLAUDE.md"), "cwd");

    const result = await loadBoundedContextFiles({ cwd, agentDir, projectTrusted: true });
    expect(result.map((file) => file.content)).toEqual(["global", "root", "cwd"]);
  });

  it("does not inspect project ancestors for untrusted calls", async () => {
    const root = mkdtempSync(join(tmpdir(), "context-loader-trust-"));
    roots.push(root);
    const agentDir = join(root, "global");
    const cwd = join(root, "project", "src");
    mkdirSync(agentDir);
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(agentDir, "CLAUDE.md"), "global only");
    writeFileSync(join(root, "project", "AGENTS.md"), "untrusted project");

    const lstat = vi.spyOn(fs.promises, "lstat");
    const result = await loadBoundedContextFiles({ cwd, agentDir, projectTrusted: false });
    expect(result.map((file) => file.content)).toEqual(["global only"]);
    expect(lstat.mock.calls.every(([candidate]) => !String(candidate).startsWith(cwd))).toBe(true);
  });

  it("skips oversized and multibyte files with bounded warnings", async () => {
    const root = mkdtempSync(join(tmpdir(), "context-loader-bytes-"));
    roots.push(root);
    const warnings: string[] = [];
    const agentDir = join(root, "global");
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "AGENTS.md"), "界".repeat(Math.ceil(MAX_CONTEXT_FILE_BYTES / 3) + 1));
    writeFileSync(join(agentDir, "CLAUDE.md"), "fallback");

    const result = await loadBoundedContextFiles({
      cwd: root,
      agentDir,
      projectTrusted: false,
      onWarning: (warning) => warnings.push(warning),
    });
    expect(result.map((file) => file.content)).toEqual(["fallback"]);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.every((warning) => utf8ByteLength(warning) <= 1024)).toBe(true);
  });

  it("enforces the total byte budget without reading a crossing file", async () => {
    const root = mkdtempSync(join(tmpdir(), "context-loader-total-"));
    roots.push(root);
    const agentDir = join(root, "global");
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "AGENTS.md"), "a".repeat(MAX_CONTEXT_FILE_BYTES));
    writeFileSync(join(project, "AGENTS.md"), "b".repeat(MAX_CONTEXT_FILE_BYTES));
    writeFileSync(join(project, "src-placeholder"), "not a candidate");
    const cwd = join(project, "src");
    mkdirSync(cwd);
    writeFileSync(join(cwd, "AGENTS.md"), "c");
    const warnings: string[] = [];

    const result = await loadBoundedContextFiles({
      cwd,
      agentDir,
      projectTrusted: true,
      onWarning: (warning) => warnings.push(warning),
    });
    expect(result.map((file) => file.content)).toEqual([
      "a".repeat(MAX_CONTEXT_FILE_BYTES),
      "b".repeat(MAX_CONTEXT_FILE_BYTES),
    ]);
    expect(warnings.some((warning) => warning.includes("total"))).toBe(true);
    expect(result.reduce((total, file) => total + utf8ByteLength(file.content), 0))
      .toBeLessThanOrEqual(MAX_CONTEXT_TOTAL_BYTES);
  });

  it("stops a deep ancestor walk at the directory bound", async () => {
    const root = mkdtempSync(join(tmpdir(), "context-loader-deep-"));
    roots.push(root);
    let cwd = root;
    for (let index = 0; index < MAX_CONTEXT_ANCESTOR_DIRECTORIES + 2; index++) {
      cwd = join(cwd, `d${index}`);
      mkdirSync(cwd);
    }
    writeFileSync(join(root, "AGENTS.md"), "too far");
    const warnings: string[] = [];
    const result = await loadBoundedContextFiles({
      cwd,
      agentDir: join(root, "global-missing"),
      projectTrusted: true,
      onWarning: (warning) => warnings.push(warning),
    });
    expect(result).toEqual([]);
    expect(warnings.join("\n")).toContain(`${MAX_CONTEXT_ANCESTOR_DIRECTORIES} directories`);
  });

  it("skips a file exchanged between pre-read and post-read lstat", async () => {
    const root = mkdtempSync(join(tmpdir(), "context-loader-race-"));
    roots.push(root);
    const filePath = join(root, "AGENTS.md");
    writeFileSync(filePath, "race");
    const originalLstat = fs.promises.lstat;
    let calls = 0;
    const lstat = vi.spyOn(fs.promises, "lstat").mockImplementation(async (candidate: any) => {
      const stats = await originalLstat(candidate);
      if (candidate === filePath && ++calls === 2) {
        const replacement = {
          isFile: () => true,
          isSymbolicLink: () => false,
          dev: stats.dev,
          ino: stats.ino,
          size: stats.size,
          mtimeMs: stats.mtimeMs + 1,
          ctimeMs: stats.ctimeMs,
          mode: stats.mode,
        } as any;
        return replacement;
      }
      return stats;
    });
    const warnings: string[] = [];

    const result = await loadBoundedContextFiles({
      cwd: root,
      agentDir: join(root, "global-missing"),
      projectTrusted: true,
      onWarning: (warning) => warnings.push(warning),
    });
    expect(result).toEqual([]);
    expect(warnings.join("\n")).toContain("changed during read");
    expect(lstat).toHaveBeenCalled();
  });
});
