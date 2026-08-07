/**
 * output-log-retention.test.ts — candidate selection and marker boundaries.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { chmodSync, existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirFixture } from "../fixtures.ts";
import {
  cleanupOutputRoots,
  MAX_OUTPUT_PARENT_ENTRIES,
  OUTPUT_ROOT_MAX_AGE_MS,
} from "../../src/agents/output-log-retention.js";
import { createOutputRoot, releaseOutputRoot, whenOutputLogsIdle } from "../../src/agents/output-file.js";

const fixture = tempDirFixture("output-retention");

function makeRoot(name: string, modifiedAt: number): string {
  const root = join(fixture.getDir(), name);
  mkdirSync(root);
  chmodSync(root, 0o700);
  const file = join(root, "agent.log");
  writeFileSync(file, "log");
  chmodSync(file, 0o600);
  utimesSync(root, new Date(modifiedAt), new Date(modifiedAt));
  return root;
}

beforeEach(() => fixture.setup());
afterEach(async () => {
  await whenOutputLogsIdle();
  fixture.teardown();
});

describe("output-root retention facade", () => {
  it("bounds candidate selection and closes the parent iterator", async () => {
    const entries = Array.from({ length: MAX_OUTPUT_PARENT_ENTRIES + 40 }, (_, index) => ({
      name: `unrelated-${index}`,
    }));
    let cursor = 0;
    let consumed = 0;
    let closed = false;
    const directory = {
      next: async () => {
        if (cursor >= entries.length) return { value: undefined, done: true };
        consumed++;
        return { value: entries[cursor++], done: false };
      },
      return: async () => ({ value: undefined, done: true }),
      [Symbol.asyncIterator]() { return this; },
      close: async () => { closed = true; },
    };
    const opendir = vi.spyOn(fs.promises, "opendir").mockResolvedValueOnce(directory as any);
    try {
      await expect(cleanupOutputRoots({ parentDir: fixture.getDir() })).resolves.toEqual({
        scannedRoots: 0,
        skippedRoots: 0,
        deletedRoots: [],
      });
      expect(consumed).toBe(MAX_OUTPUT_PARENT_ENTRIES + 1);
      expect(consumed).toBeLessThan(entries.length);
      expect(closed).toBe(true);
    } finally {
      opendir.mockRestore();
    }
  });

  it("protects a live marker until the owned root is released", async () => {
    const now = Date.now();
    const root = createOutputRoot(fixture.getDir());
    utimesSync(root, new Date(now - OUTPUT_ROOT_MAX_AGE_MS - 1), new Date(now - OUTPUT_ROOT_MAX_AGE_MS - 1));

    const whileLive = await cleanupOutputRoots({ parentDir: fixture.getDir(), now: () => now });
    expect(whileLive.deletedRoots).not.toContain(root);
    expect(existsSync(root)).toBe(true);

    await releaseOutputRoot(root);
    utimesSync(root, new Date(now - OUTPUT_ROOT_MAX_AGE_MS - 1), new Date(now - OUTPUT_ROOT_MAX_AGE_MS - 1));
    const afterRelease = await cleanupOutputRoots({ parentDir: fixture.getDir(), now: () => now });
    expect(afterRelease.deletedRoots).toContain(root);
    expect(existsSync(root)).toBe(false);
  });

  it("matches aliases by canonical identity while reporting the supplied parent spelling", async () => {
    const now = Date.now();
    const parent = fixture.getDir();
    const aliasParent = join(parent, "TEMP~1");
    const canonicalizePath = (path: string): string => path.startsWith(aliasParent)
      ? `${parent}${path.slice(aliasParent.length)}`
      : path;
    const protectedName = "pi-subagents-outputs-alias-protected";
    const deleteName = "pi-subagents-outputs-alias-delete";
    const protectedRoot = makeRoot(protectedName, now - OUTPUT_ROOT_MAX_AGE_MS - 1);
    const deleteRoot = makeRoot(deleteName, now - OUTPUT_ROOT_MAX_AGE_MS - 1);

    const result = await cleanupOutputRoots({
      parentDir: aliasParent,
      protectedRoots: [join(aliasParent, protectedName)],
      now: () => now,
      canonicalizePath,
    });

    expect(result.scannedRoots).toBe(2);
    expect(result.skippedRoots).toBe(0);
    expect(result.deletedRoots).toEqual([join(aliasParent, deleteName)]);
    expect(existsSync(protectedRoot)).toBe(true);
    expect(existsSync(deleteRoot)).toBe(false);
  });
});
