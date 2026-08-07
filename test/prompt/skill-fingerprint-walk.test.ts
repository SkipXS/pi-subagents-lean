import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MAX_RESOURCE_FINGERPRINT_DEPTH,
  MAX_RESOURCE_FINGERPRINT_ENTRIES,
  walkResourceTree,
  walkResourceTreeAsync,
} from "../../src/prompt/skill-fingerprint-walk.js";

const roots: string[] = [];
const options = { allowRootMarkdown: true };

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 30_000);

describe("skill fingerprint walker boundaries", () => {
  it("rejects the same over-deep root synchronously and asynchronously", async () => {
    const root = mkdtempSync(join(tmpdir(), "skill-fingerprint-deep-"));
    roots.push(root);
    let current = root;
    for (let depth = 1; depth <= MAX_RESOURCE_FINGERPRINT_DEPTH + 1; depth++) {
      current = join(current, "d");
      mkdirSync(current);
    }
    const message = `maximum depth ${MAX_RESOURCE_FINGERPRINT_DEPTH}`;

    expect(() => walkResourceTree(root, options)).toThrow(message);
    await expect(walkResourceTreeAsync(root, options)).rejects.toThrow(message);
  });

  it("closes the async iterator at the entry limit without consuming the rest", async () => {
    const root = mkdtempSync(join(tmpdir(), "skill-fingerprint-async-stream-"));
    roots.push(root);
    const entries = Array.from({ length: MAX_RESOURCE_FINGERPRINT_ENTRIES + 40 }, (_, index) => ({
      name: `entry-${index}`,
    }));
    let cursor = 0;
    let consumed = 0;
    let returned = false;
    let closed = false;
    const directory = {
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
    const opendir = vi.spyOn(fs.promises, "opendir").mockResolvedValueOnce(directory as any);
    try {
      await expect(walkResourceTreeAsync(root, options)).rejects.toThrow("maximum");
      expect(consumed).toBe(MAX_RESOURCE_FINGERPRINT_ENTRIES);
      expect(consumed).toBeLessThan(entries.length);
      expect(returned || closed).toBe(true);
      expect(closed).toBe(true);
    } finally {
      opendir.mockRestore();
    }
  });

  it("rejects a wide root after the exact visited-entry budget", async () => {
    const root = mkdtempSync(join(tmpdir(), "skill-fingerprint-wide-"));
    roots.push(root);
    for (let index = 0; index < MAX_RESOURCE_FINGERPRINT_ENTRIES; index++) {
      writeFileSync(join(root, `entry-${String(index).padStart(5, "0")}.md`), "");
    }
    const message = `maximum ${MAX_RESOURCE_FINGERPRINT_ENTRIES} visited entries`;

    expect(() => walkResourceTree(root, options)).toThrow(message);
    await expect(walkResourceTreeAsync(root, options)).rejects.toThrow(message);
  }, 30_000);
});
