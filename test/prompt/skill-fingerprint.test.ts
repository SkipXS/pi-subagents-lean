import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  fingerprintResourceTree,
  fingerprintResourceTreeAsync,
} from "../../src/prompt/skill-fingerprint.ts";
import { canCreateSymlinks } from "../fixtures.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("skill resource fingerprints", () => {
  it("keeps sync and async fingerprints byte-for-byte compatible", async () => {
    const root = mkdtempSync(join(tmpdir(), "skill-fingerprint-"));
    roots.push(root);
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "z.md"), "z");
    writeFileSync(join(root, "nested", "a.md"), "a");

    const sync = fingerprintResourceTree(root);
    const asyncResult = await fingerprintResourceTreeAsync(root);
    expect(sync).toEqual(asyncResult);
    expect(sync.stable).toBe(true);
  });

  it("records content-tree metadata changes and stable missing roots", async () => {
    const root = mkdtempSync(join(tmpdir(), "skill-fingerprint-"));
    roots.push(root);
    const file = join(root, "skill.md");
    writeFileSync(file, "before");
    const before = fingerprintResourceTree(root);
    writeFileSync(file, "after-content");
    const changedAt = new Date(Date.now() + 2_000);
    utimesSync(file, changedAt, changedAt);

    expect(fingerprintResourceTree(root).value).not.toBe(before.value);
    const missing = await fingerprintResourceTreeAsync(join(root, "missing"));
    expect(missing.stable).toBe(true);
  });

  it("does not serialize an absolute alias and detects a real symlink retarget", async () => {
    if (!canCreateSymlinks()) return;
    const root = mkdtempSync(join(tmpdir(), "skill-fingerprint-alias-"));
    roots.push(root);
    const targetA = join(root, "target-a.md");
    const targetB = join(root, "target-b.md");
    const link = join(root, "linked.md");
    writeFileSync(targetA, "same bytes");
    writeFileSync(targetB, "same bytes");
    symlinkSync(targetA, link, "file");

    const first = fingerprintResourceTree(root);
    const firstAlias = fingerprintResourceTree(join(root, "."));
    const firstAsync = await fingerprintResourceTreeAsync(root);
    expect(firstAlias.value).toBe(first.value);
    expect(firstAsync.value).toBe(first.value);

    rmSync(link, { force: true });
    symlinkSync(targetB, link, "file");
    expect(fingerprintResourceTree(root).value).not.toBe(first.value);
    expect((await fingerprintResourceTreeAsync(root)).value).not.toBe(first.value);
  });

  it("marks broken descendants unstable and includes symlink targets", async () => {
    if (!canCreateSymlinks()) return;
    const root = mkdtempSync(join(tmpdir(), "skill-fingerprint-"));
    roots.push(root);
    const target = join(root, "target.md");
    const link = join(root, "link.md");
    writeFileSync(target, "target");
    symlinkSync(target, link, "file");
    const linked = fingerprintResourceTree(root);
    expect(linked.stable).toBe(true);
    expect(linked.value).toContain("target");

    rmSync(target, { force: true });
    expect(fingerprintResourceTree(root).stable).toBe(false);
    expect((await fingerprintResourceTreeAsync(root)).stable).toBe(false);
  });

});
