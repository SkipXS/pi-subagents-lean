import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  capUtf8Strings,
  capUtf8StringsToBudget,
  isUnsafeName,
  isSymlink,
  safeReadFile,
  summarizeToolArgs,
  truncateUtf8,
  utf8ByteLength,
} from "../src/utils.ts";
import { canCreateSymlinks, tempDirFixture } from "./fixtures";

const itWithSymlinkSupport = it.skipIf(!canCreateSymlinks());

describe("bounded UTF-8 text", () => {
  it("truncates deterministic multibyte text without splitting a code point", () => {
    const value = truncateUtf8("😀界".repeat(100), 32);

    expect(utf8ByteLength(value)).toBeLessThanOrEqual(32);
    expect(value).toContain("[TRUNCATED]");
    expect(value.endsWith("[TRUNCATED]")).toBe(true);
    expect([...value.slice(0, -"[TRUNCATED]".length)].every((character) => character !== "\uFFFD")).toBe(true);
    expect(truncateUtf8("short", 32)).toBe("short");
  });

  it("handles zero and marker-only budgets byte-safely", () => {
    expect(truncateUtf8("😀", 0)).toBe("");
    const markerPrefix = truncateUtf8("😀😀", 4);
    expect(utf8ByteLength(markerPrefix)).toBeLessThanOrEqual(4);
    expect(markerPrefix).toBe("[TRU");
  });

  it("recursively caps only string fields and preserves metadata shape", () => {
    const huge = "界".repeat(5_000);
    const value = { text: huge, nested: [{ summary: huge, count: 3 }], flag: true };
    const capped = capUtf8Strings(value, 8 * 1024);

    expect(capped).not.toBe(value);
    expect(capped.nested).not.toBe(value.nested);
    expect(utf8ByteLength(capped.text)).toBeLessThanOrEqual(8 * 1024);
    expect(utf8ByteLength(capped.nested[0]!.summary)).toBeLessThanOrEqual(8 * 1024);
    expect(capped.text).toContain("[TRUNCATED]");
    expect(capped.nested[0]!.count).toBe(3);
    expect(capped.flag).toBe(true);
  });

  it("shares a total budget across details fields and leaves non-plain values alone", () => {
    const value = { first: "a".repeat(100), second: "界".repeat(100), date: new Date(0) };
    const capped = capUtf8StringsToBudget(value, 32);

    const textBytes = utf8ByteLength(capped.first) + utf8ByteLength(capped.second);
    expect(textBytes).toBeLessThanOrEqual(32);
    expect(capped.first).toContain("[TRUNCATED]");
    expect(capped.date).toBe(value.date);
  });

  it("does not loop on a cyclic plain metadata object", () => {
    const value: { text: string; self?: unknown } = { text: "界".repeat(5_000) };
    value.self = value;
    const capped = capUtf8Strings(value, 8 * 1024);

    expect(capped.self).toBe(capped);
    expect(capped.text).toContain("[TRUNCATED]");
  });
});

describe("summarizeToolArgs", () => {
  it("keeps log summaries neutral and compact for common tools", () => {
    expect(summarizeToolArgs("read", { path: "src/index.ts" })).toBe('("src/index.ts")');
    expect(summarizeToolArgs("write", { file_path: "out.txt", content: "hello" })).toBe('("out.txt", 5 chars)');
    expect(summarizeToolArgs("edit", { path: "out.txt", edits: [{ oldText: "a", newText: "b" }] })).toBe('("out.txt", 1 edits)');
    expect(summarizeToolArgs("bash", { command: "cat <<EOF\\nbody\\nEOF" })).toBe('("cat")');
    expect(summarizeToolArgs("rg", { pattern: "Agent", path: "src" })).toBe('("Agent", "src")');
  });

  it("falls back to bounded JSON for unknown tools", () => {
    expect(summarizeToolArgs("custom", { value: "ok" })).toBe('("ok")');
    expect(summarizeToolArgs("custom", {})).toBe("");
  });
});

/* ------------------------------------------------------------------ */
/*  isUnsafeName                                                      */
/* ------------------------------------------------------------------ */

describe("isUnsafeName", () => {
  it("allows simple alphanumeric names", () => {
    expect(isUnsafeName("scout")).toBe(false);
    expect(isUnsafeName("architect")).toBe(false);
    expect(isUnsafeName("myAgent42")).toBe(false);
  });

  it("allows names with dots, hyphens, underscores", () => {
    expect(isUnsafeName("my.agent")).toBe(false);
    expect(isUnsafeName("code_review-v2")).toBe(false);
  });

  it("rejects names starting with a dot", () => {
    expect(isUnsafeName(".hidden")).toBe(true);
  });

  it("rejects path traversal (../)", () => {
    expect(isUnsafeName("../etc")).toBe(true);
  });

  it("rejects path traversal (..\\\\)", () => {
    expect(isUnsafeName("..\\etc")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isUnsafeName("")).toBe(true);
  });

  it("rejects names longer than 128 characters", () => {
    expect(isUnsafeName("a".repeat(129))).toBe(true);
  });

  it("allows exactly 128 characters", () => {
    expect(isUnsafeName("a".repeat(128))).toBe(false);
  });

  it("rejects names with spaces", () => {
    expect(isUnsafeName("my agent")).toBe(true);
  });

  it("rejects names with slashes", () => {
    expect(isUnsafeName("a/b")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  isSymlink                                                         */
/* ------------------------------------------------------------------ */

describe("isSymlink", () => {
  const { setup, getDir, teardown } = tempDirFixture("isSymlink-test");

  beforeEach(() => setup());
  afterEach(() => teardown());

  it("returns false for a regular file", () => {
    const file = join(getDir(), "regular.txt");
    writeFileSync(file, "hello", "utf-8");
    expect(isSymlink(file)).toBe(false);
  });

  itWithSymlinkSupport("returns true for a symlink", () => {
    const target = join(getDir(), "target.txt");
    writeFileSync(target, "target content", "utf-8");
    const link = join(getDir(), "link.txt");
    symlinkSync(target, link);
    expect(isSymlink(link)).toBe(true);
  });

  it("returns false for a non-existent file", () => {
    expect(isSymlink(join(getDir(), "nonexistent.txt"))).toBe(false);
  });

  it("returns false for a directory", () => {
    expect(isSymlink(getDir())).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  safeReadFile                                                      */
/* ------------------------------------------------------------------ */

describe("safeReadFile", () => {
  const { setup, getDir, teardown } = tempDirFixture("safeReadFile-test");

  beforeEach(() => setup());
  afterEach(() => teardown());

  it("reads a normal file", () => {
    const file = join(getDir(), "normal.txt");
    writeFileSync(file, "file content", "utf-8");
    expect(safeReadFile(file)).toBe("file content");
  });

  itWithSymlinkSupport("returns undefined for a symlink", () => {
    const target = join(getDir(), "target.txt");
    writeFileSync(target, "secret", "utf-8");
    const link = join(getDir(), "link.txt");
    symlinkSync(target, link);
    expect(safeReadFile(link)).toBeUndefined();
  });

  it("returns undefined for a missing file", () => {
    expect(safeReadFile(join(getDir(), "missing.txt"))).toBeUndefined();
  });

  it("returns undefined for a directory", () => {
    expect(safeReadFile(getDir())).toBeUndefined();
  });
});

