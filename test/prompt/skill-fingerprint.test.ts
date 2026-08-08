import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fingerprintResourceTreeAsync } from "../../src/prompt/skill-fingerprint.ts";
import { canCreateSymlinks } from "../fixtures.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("skill resource fingerprints", () => {
  it("fingerprints a resource tree asynchronously", async () => {
    const root = mkdtempSync(join(tmpdir(), "skill-fingerprint-"));
    roots.push(root);
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "z.md"), "z");
    writeFileSync(join(root, "nested", "a.md"), "a");

    const result = await fingerprintResourceTreeAsync(root);
    expect(result.stable).toBe(true);
    expect(result.value).not.toContain(root);
  });

  it("records content-tree metadata changes and stable missing roots", async () => {
    const root = mkdtempSync(join(tmpdir(), "skill-fingerprint-"));
    roots.push(root);
    const file = join(root, "skill.md");
    writeFileSync(file, "before");
    const before = await fingerprintResourceTreeAsync(root);
    writeFileSync(file, "after-content");
    const changedAt = new Date(Date.now() + 2_000);
    utimesSync(file, changedAt, changedAt);

    expect((await fingerprintResourceTreeAsync(root)).value).not.toBe(before.value);
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

    const first = await fingerprintResourceTreeAsync(root);
    const firstAlias = await fingerprintResourceTreeAsync(join(root, "."));
    expect(firstAlias.value).toBe(first.value);

    rmSync(link, { force: true });
    symlinkSync(targetB, link, "file");
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
    const linked = await fingerprintResourceTreeAsync(root);
    expect(linked.stable).toBe(true);
    expect(linked.value).toContain("target");

    rmSync(target, { force: true });
    expect((await fingerprintResourceTreeAsync(root)).stable).toBe(false);
  });

});
