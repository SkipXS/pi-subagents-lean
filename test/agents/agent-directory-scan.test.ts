/**
 * agent-directory-scan.test.ts — Filesystem discovery/cache boundary tests.
 */

import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import {
  MAX_AGENT_FILES_PER_SOURCE,
  scanAgentFilesInDir,
} from "../../src/agents/agent-directory-scan.js";
import { MAX_AGENT_MARKDOWN_BYTES } from "../../src/agents/agent-string-limits.js";
import { mergeAgents } from "../../src/agents/agent-discovery.js";
import { makeAgentMd, tempDirWithFiles } from "../fixtures.ts";

describe("scanAgentFilesInDir", () => {
  it("coalesces identical concurrent scans without using access", async () => {
    const { dir, cleanup } = tempDirWithFiles([
      { name: "alpha.md", content: makeAgentMd({ name: "alpha" }) },
      { name: "beta.md", content: makeAgentMd({ name: "beta" }) },
    ], "agent-discovery-coalescing");
    const originalOpendir = fs.promises.opendir;
    let release!: () => void;
    const opendirGate = new Promise<void>((resolve) => { release = resolve; });
    const opendir = vi.spyOn(fs.promises, "opendir").mockImplementation(async (...args) => {
      await opendirGate;
      return originalOpendir(...args) as any;
    });
    const access = vi.spyOn(fs.promises, "access");

    try {
      const first = scanAgentFilesInDir(dir, "user");
      expect(opendir).toHaveBeenCalledOnce();
      const second = scanAgentFilesInDir(dir, "user");
      expect(opendir).toHaveBeenCalledOnce();

      release();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult).toEqual(secondResult);
      expect(firstResult).not.toBe(secondResult);
      expect(access).not.toHaveBeenCalled();
    } finally {
      opendir.mockRestore();
      access.mockRestore();
      cleanup();
    }
  });

  it("rescans for a refresh that starts after an in-flight snapshot was captured", async () => {
    const { dir, cleanup } = tempDirWithFiles([
      { name: "first.md", content: makeAgentMd({ name: "first" }) },
    ], "agent-discovery-late-refresh");
    const originalLstat = fs.promises.lstat;
    let release!: () => void;
    const lstatGate = new Promise<void>((resolve) => { release = resolve; });
    let snapshotObserved!: () => void;
    const observed = new Promise<void>((resolve) => { snapshotObserved = resolve; });
    const lstat = vi.spyOn(fs.promises, "lstat").mockImplementation(async (...args: any[]) => {
      snapshotObserved();
      await lstatGate;
      return originalLstat(...args as Parameters<typeof originalLstat>);
    });

    try {
      const first = scanAgentFilesInDir(dir, "user");
      await observed;
      fs.writeFileSync(join(dir, "second.md"), makeAgentMd({ name: "second" }));
      const second = scanAgentFilesInDir(dir, "user");
      release();

      expect((await first).map(({ name }) => name)).toEqual(["first"]);
      expect((await second).map(({ name }) => name)).toEqual(["first", "second"]);
    } finally {
      release();
      lstat.mockRestore();
      cleanup();
    }
  });

  it("rejects oversized Markdown from lstat without reading or caching it", async () => {
    const oversizedPath = "oversized.md";
    const { dir, cleanup } = tempDirWithFiles([
      { name: oversizedPath, content: "x".repeat(MAX_AGENT_MARKDOWN_BYTES + 1) },
    ], "agent-discovery-oversized");
    const readFile = vi.spyOn(fs.promises, "readFile");

    try {
      expect(await scanAgentFilesInDir(dir, "user")).toEqual([]);
      expect(readFile).not.toHaveBeenCalledWith(join(dir, oversizedPath), "utf-8");
      // A second scan must still reject the file without a stale parsed cache.
      expect(await scanAgentFilesInDir(dir, "user")).toEqual([]);
      expect(readFile).not.toHaveBeenCalledWith(join(dir, oversizedPath), "utf-8");
    } finally {
      readFile.mockRestore();
      cleanup();
    }
  });

  it("skips an unstable file when lstat fails and retries on the next scan", async () => {
    const { dir, cleanup } = tempDirWithFiles([
      { name: "unstable.md", content: makeAgentMd({ name: "unstable" }) },
    ], "agent-discovery-unstable");
    const filePath = join(dir, "unstable.md");
    const originalLstat = fs.promises.lstat;
    const lstat = vi.spyOn(fs.promises, "lstat").mockImplementationOnce(async (candidate: any) => {
      if (candidate === filePath) throw new Error("disappeared");
      return originalLstat(candidate);
    });

    try {
      expect(await scanAgentFilesInDir(dir, "user")).toEqual([]);
      expect((await scanAgentFilesInDir(dir, "user"))[0]?.name).toBe("unstable");
    } finally {
      lstat.mockRestore();
      cleanup();
    }
  });

  it("does not publish a file replaced during read", async () => {
    const { dir, cleanup } = tempDirWithFiles([
      { name: "changing.md", content: makeAgentMd({ name: "changing" }) },
    ], "agent-discovery-changing");
    const filePath = join(dir, "changing.md");
    const originalLstat = fs.promises.lstat;
    let targetCalls = 0;
    const lstat = vi.spyOn(fs.promises, "lstat").mockImplementation(async (candidate: any) => {
      const stats = await originalLstat(candidate);
      if (candidate === filePath && ++targetCalls === 2) {
        return { ...stats, size: stats.size + 1 } as any;
      }
      return stats;
    });

    try {
      expect(await scanAgentFilesInDir(dir, "user")).toEqual([]);
      expect(targetCalls).toBe(2);
    } finally {
      lstat.mockRestore();
      cleanup();
    }
  });

  it("rejects an overlong filename fallback without caching it", async () => {
    const longName = `${"a".repeat(129)}.md`;
    const { dir, cleanup } = tempDirWithFiles([
      { name: longName, content: "Instructions without frontmatter" },
    ], "agent-discovery-long-name");
    const readFile = vi.spyOn(fs.promises, "readFile");

    try {
      expect(await scanAgentFilesInDir(dir, "user")).toEqual([]);
      expect(readFile).toHaveBeenCalledTimes(1);
    } finally {
      readFile.mockRestore();
      cleanup();
    }
  });

  it("fails closed at the 256-file source limit before metadata collection", async () => {
    const fileCount = MAX_AGENT_FILES_PER_SOURCE + 17;
    const { dir, cleanup } = tempDirWithFiles(
      Array.from({ length: fileCount }, (_, index) => ({
        name: `agent-${String(index).padStart(3, "0")}.md`,
        content: makeAgentMd({ name: `agent-${String(index).padStart(3, "0")}` }),
      })),
      "agent-discovery-many-files",
    );
    const readFile = vi.spyOn(fs.promises, "readFile");

    try {
      const agents = await scanAgentFilesInDir(dir, "user");
      expect(agents).toEqual([]);
      expect(readFile).not.toHaveBeenCalled();
    } finally {
      readFile.mockRestore();
      cleanup();
    }
  });

  it("closes the async directory iterator at the Markdown source limit without consuming the rest", async () => {
    const entries = Array.from({ length: MAX_AGENT_FILES_PER_SOURCE + 40 }, (_, index) => ({
      name: `agent-${index}.md`,
      isFile: () => true,
    }));
    let cursor = 0;
    let consumed = 0;
    let returned = false;
    let closed = false;
    const iterator = {
      next: async () => {
        if (cursor >= entries.length) return { value: undefined, done: true };
        consumed++;
        return { value: entries[cursor++], done: false };
      },
      return: async () => {
        returned = true;
        return { value: undefined, done: true };
      },
      [Symbol.asyncIterator]() { return this; },
      close: async () => { closed = true; },
    };
    const opendir = vi.spyOn(fs.promises, "opendir").mockResolvedValueOnce(iterator as any);
    try {
      await expect(scanAgentFilesInDir("/virtual-agent-source-limit", "project")).resolves.toEqual([]);
      expect(consumed).toBe(MAX_AGENT_FILES_PER_SOURCE + 1);
      expect(consumed).toBeLessThan(entries.length);
      expect(returned || closed).toBe(true);
      expect(closed).toBe(true);
    } finally {
      opendir.mockRestore();
    }
  });

  it("closes the async directory iterator at the total-entry limit without consuming the rest", async () => {
    const entries = Array.from({ length: 10_000 + 40 }, (_, index) => ({
      name: `entry-${index}`,
      isFile: () => false,
    }));
    let cursor = 0;
    let consumed = 0;
    let returned = false;
    let closed = false;
    const iterator = {
      next: async () => {
        if (cursor >= entries.length) return { value: undefined, done: true };
        consumed++;
        return { value: entries[cursor++], done: false };
      },
      return: async () => {
        returned = true;
        return { value: undefined, done: true };
      },
      [Symbol.asyncIterator]() { return this; },
      close: async () => { closed = true; },
    };
    const opendir = vi.spyOn(fs.promises, "opendir").mockResolvedValueOnce(iterator as any);
    try {
      await expect(scanAgentFilesInDir("/virtual-agent-entry-limit", "project")).resolves.toEqual([]);
      expect(consumed).toBe(10_001);
      expect(consumed).toBeLessThan(entries.length);
      expect(returned || closed).toBe(true);
      expect(closed).toBe(true);
    } finally {
      opendir.mockRestore();
    }
  });

  it("bounds concurrent metadata collection", async () => {
    const { dir, cleanup } = tempDirWithFiles(
      Array.from({ length: 16 }, (_, index) => ({
        name: `agent-${index}.md`,
        content: makeAgentMd({ name: `agent-${index}` }),
      })),
      "agent-discovery-metadata-bound",
    );
    const originalLstat = fs.promises.lstat;
    let active = 0;
    let maximum = 0;
    const lstat = vi.spyOn(fs.promises, "lstat").mockImplementation(async (filePath: any, options?: any) => {
      active++;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      try {
        return options === undefined
          ? await originalLstat(filePath)
          : await originalLstat(filePath, options);
      } finally {
        active--;
      }
    });

    try {
      await scanAgentFilesInDir(dir, "user");
      expect(maximum).toBeGreaterThan(1);
      expect(maximum).toBeLessThanOrEqual(8);
    } finally {
      lstat.mockRestore();
      cleanup();
    }
  });

  it("reuses unchanged files and notices create, change, delete, and rename", async () => {
    const { dir, cleanup } = tempDirWithFiles([], "agent-discovery-cache");
    const readFile = vi.spyOn(fs.promises, "readFile");
    const firstPath = join(dir, "first.md");
    const renamedPath = join(dir, "renamed.md");

    try {
      // A cached negative directory result must not hide a later creation.
      expect(await scanAgentFilesInDir(dir)).toEqual([]);
      expect(readFile).not.toHaveBeenCalled();

      fs.writeFileSync(firstPath, makeAgentMd({ name: "first", description: "Initial" }));
      expect((await scanAgentFilesInDir(dir)).map(({ description }) => description)).toEqual(["Initial"]);
      expect(readFile).toHaveBeenCalledTimes(1);

      // An unchanged fingerprint reuses the parsed definition.
      await scanAgentFilesInDir(dir);
      expect(readFile).toHaveBeenCalledTimes(1);

      // Adding a later file invalidates only the directory snapshot; the
      // unchanged first file is then served from its direct-file cache.
      fs.writeFileSync(renamedPath, makeAgentMd({ name: "later", description: "Later" }));
      await scanAgentFilesInDir(dir);
      expect(readFile).toHaveBeenCalledTimes(2);
      fs.unlinkSync(renamedPath);

      fs.writeFileSync(firstPath, makeAgentMd({ name: "first", description: "Changed" }));
      // Coarse timestamps on coverage hosts can otherwise hide a same-length
      // replacement from the metadata cache.
      const changedAt = new Date(Date.now() + 2_000);
      fs.utimesSync(firstPath, changedAt, changedAt);
      expect((await scanAgentFilesInDir(dir))[0]?.description).toBe("Changed");
      expect(readFile).toHaveBeenCalledTimes(3);

      fs.unlinkSync(firstPath);
      expect(await scanAgentFilesInDir(dir)).toEqual([]);

      fs.writeFileSync(renamedPath, makeAgentMd({ description: "Renamed", _skip: ["name"] }));
      expect((await scanAgentFilesInDir(dir))[0]).toMatchObject({
        name: "renamed",
        description: "Renamed",
      });
      expect(readFile).toHaveBeenCalledTimes(4);
      await scanAgentFilesInDir(dir);
      expect(readFile).toHaveBeenCalledTimes(4);
    } finally {
      readFile.mockRestore();
      cleanup();
    }
  });

  it("bounds path caches while retaining recent entries", async () => {
    const { dir, cleanup } = tempDirWithFiles([], "agent-discovery-lru");
    const readFile = vi.spyOn(fs.promises, "readFile");
    const directories = Array.from({ length: 256 }, (_, index) => join(dir, `agent-${index}`));

    try {
      for (const [index, child] of directories.entries()) {
        fs.mkdirSync(child);
        fs.writeFileSync(join(child, "agent.md"), makeAgentMd({ name: `agent-${index}` }));
        await scanAgentFilesInDir(child);
      }

      // A hit refreshes recency, so adding one more path evicts agent-1 rather
      // than the recently used agent-0 entry.
      const readsBeforeHit = readFile.mock.calls.length;
      await scanAgentFilesInDir(directories[0]!);
      expect(readFile).toHaveBeenCalledTimes(readsBeforeHit);
      const readsBeforeEviction = readFile.mock.calls.length;
      const extra = join(dir, "agent-extra");
      fs.mkdirSync(extra);
      fs.writeFileSync(join(extra, "agent.md"), makeAgentMd({ name: "agent-extra" }));
      await scanAgentFilesInDir(extra);
      await scanAgentFilesInDir(directories[0]!);
      expect(readFile).toHaveBeenCalledTimes(readsBeforeEviction + 1);
      await scanAgentFilesInDir(directories[1]!);
      expect(readFile).toHaveBeenCalledTimes(readsBeforeEviction + 2);
    } finally {
      readFile.mockRestore();
      cleanup();
    }
  });

  it("does not resolve an empty source path to the process working directory", async () => {
    const opendir = vi.spyOn(fs.promises, "opendir");
    try {
      expect(await scanAgentFilesInDir("", "project")).toEqual([]);
      expect(opendir).not.toHaveBeenCalled();
    } finally {
      opendir.mockRestore();
    }
  });

  it("returns empty array for non-existent directory", async () => {
    const result = await scanAgentFilesInDir("/tmp/nonexistent-sdf9asdf", "user");
    expect(result).toEqual([]);
  });

  it("treats a readable but unlistable directory as empty", async () => {
    const { dir, cleanup } = tempDirWithFiles([{ name: "agent.md", content: makeAgentMd({ name: "agent" }) }]);
    const opendir = vi.spyOn(fs.promises, "opendir").mockRejectedValueOnce(new Error("EACCES"));
    try {
      await expect(scanAgentFilesInDir(dir, "user")).resolves.toEqual([]);
    } finally {
      opendir.mockRestore();
      cleanup();
    }
  });

  it("parses all .md files in a directory", async () => {
    const { dir, cleanup } = tempDirWithFiles([
      { name: "alpha.md", content: makeAgentMd({ name: "alpha", model: "model/a" }) },
      { name: "beta.md", content: makeAgentMd({ name: "beta", model: "model/b" }) },
      { name: "gamma.md", content: makeAgentMd({ name: "gamma", _skip: ["model"] }) },
      { name: "readme.txt", content: "not an agent file" },
    ]);

    try {
      const agents = await scanAgentFilesInDir(dir, "user");
      expect(agents).toHaveLength(3);
      expect(agents.find((a) => a.name === "alpha")?.model).toBe("model/a");
      expect(agents.find((a) => a.name === "beta")?.model).toBe("model/b");
      expect(agents.find((a) => a.name === "gamma")?.model).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("processes Markdown files in deterministic filename order", async () => {
    const firstContent = makeAgentMd({ name: "same", description: "First" });
    const lastContent = makeAgentMd({ name: "same", description: "Last" });
    const { dir, cleanup } = tempDirWithFiles([
      { name: "a-first.md", content: firstContent },
      { name: "z-last.md", content: lastContent },
    ]);
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const readdir = vi.spyOn(fs.promises, "readdir").mockResolvedValue([...entries].reverse() as never);

    try {
      const agents = await scanAgentFilesInDir(dir, "user");
      // Later filenames win same-layer merges, regardless of filesystem order.
      expect(agents.map((agent) => agent.description)).toEqual(["First", "Last"]);
      const merged = mergeAgents(new Map(), agents, [], []);
      expect(merged.get("same")?.description).toBe("Last");
    } finally {
      readdir.mockRestore();
      cleanup();
    }
  });

  it("uses the filename when frontmatter omits name", async () => {
    const { dir, cleanup } = tempDirWithFiles([
      { name: "reviewer.md", content: "---\ndescription: Reviews changes\n---\nInstructions" },
    ]);

    try {
      const agents = await scanAgentFilesInDir(dir, "user");
      expect(agents).toHaveLength(1);
      expect(agents[0]?.name).toBe("reviewer");
      expect(agents[0]?.description).toBe("Reviews changes");
    } finally {
      cleanup();
    }
  });

  it("skips an unreadable agent file while discovering readable filename-fallback agents", async () => {
    const { dir, cleanup } = tempDirWithFiles([
      { name: "broken.md", content: makeAgentMd({ name: "broken" }) },
      { name: "reviewer.md", content: "---\ndescription: Reviews changes\n---\nInstructions" },
    ]);
    const brokenPath = join(dir, "broken.md");
    const originalReadFile = fs.promises.readFile;
    const readFile = vi.spyOn(fs.promises, "readFile").mockImplementation(async (filePath, options) => {
      if (filePath === brokenPath) throw new Error("simulated read failure");
      return originalReadFile(filePath, options as "utf-8");
    });

    try {
      const agents = await scanAgentFilesInDir(dir, "user");
      expect(agents).toEqual([expect.objectContaining({ name: "reviewer", description: "Reviews changes" })]);
    } finally {
      readFile.mockRestore();
      cleanup();
    }
  });

  it("returns empty array when no .md files", async () => {
    const { dir, cleanup } = tempDirWithFiles([
      { name: "data.json", content: "{}" },
    ]);

    try {
      const agents = await scanAgentFilesInDir(dir, "user");
      expect(agents).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("assigns source to all parsed agents", async () => {
    const { dir, cleanup } = tempDirWithFiles([
      { name: "agent1.md", content: makeAgentMd({ name: "agent1" }) },
    ]);

    try {
      const agents = await scanAgentFilesInDir(dir, "project");
      expect(agents).toHaveLength(1);
      expect(agents[0]?.source).toBe("project");
    } finally {
      cleanup();
    }
  });
});
