import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, lstatSync, mkdirSync, promises as fsPromises, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirFixture } from "../fixtures.ts";
import {
  consumeGlobalJanitorBudget,
  createGlobalJanitorBudget,
  deleteVerifiedOutputRoot,
  inspectOutputTree,
  MAX_OUTPUT_GLOBAL_PASS_ENTRIES,
} from "../../src/agents/output-log-retention-tree.js";
import { directoryIdentity } from "../../src/agents/output-log-constants.js";

const fixture = tempDirFixture("output-retention-tree");

beforeEach(() => fixture.setup());
afterEach(() => fixture.teardown());

describe("bounded output retention tree", () => {
  it("keeps the pass budget exact and fail-closed", () => {
    const budget = createGlobalJanitorBudget();
    consumeGlobalJanitorBudget(budget, MAX_OUTPUT_GLOBAL_PASS_ENTRIES);
    expect(budget).toMatchObject({ used: MAX_OUTPUT_GLOBAL_PASS_ENTRIES, remaining: 0 });
    expect(() => consumeGlobalJanitorBudget(budget)).toThrow("budget exhausted");
    expect(budget.exhausted).toBe(true);
  });

  it("inspects a complete tree and deletes only after a reserved second pass", async () => {
    const root = join(fixture.getDir(), "root");
    mkdirSync(root);
    chmodSync(root, 0o700);
    const file = join(root, "agent.log");
    writeFileSync(file, "entry");
    chmodSync(file, 0o600);

    const inspectionBudget = { entries: 0 };
    await expect(inspectOutputTree(root, root, inspectionBudget)).resolves.toBe(5);
    expect(inspectionBudget.entries).toBe(2);
    const global = createGlobalJanitorBudget();
    await expect(deleteVerifiedOutputRoot(
      root,
      directoryIdentity(lstatSync(root)),
      inspectionBudget.entries,
      global,
    )).resolves.toBe(true);
    expect(existsSync(root)).toBe(false);
  });

  it("skips the complete delete when the tree grows after inspection", async () => {
    const root = join(fixture.getDir(), "growing-root");
    mkdirSync(root);
    chmodSync(root, 0o700);
    const original = fsPromises.opendir;
    const file = join(root, "agent.log");
    writeFileSync(file, "entry");
    chmodSync(file, 0o600);

    const inspectionBudget = { entries: 0 };
    await expect(inspectOutputTree(root, root, inspectionBudget)).resolves.toBe(5);
    expect(inspectionBudget.entries).toBe(2);
    const opendir = vi.spyOn(fsPromises, "opendir").mockImplementation(async (path: any, ...args: any[]) => {
      // This is the first directory opened by the second traversal. The new
      // file is therefore visible to its reserved-entry-count validation.
      if (path === root) writeFileSync(join(root, "grown.log"), "growth");
      return original.call(fsPromises, path, ...args) as any;
    });
    try {
      const global = createGlobalJanitorBudget();
      await expect(deleteVerifiedOutputRoot(
        root,
        directoryIdentity(lstatSync(root)),
        inspectionBudget.entries,
        global,
      )).resolves.toBe(false);
      expect(existsSync(root)).toBe(true);
      expect(existsSync(file)).toBe(true);
      expect(existsSync(join(root, "grown.log"))).toBe(true);
      expect(global.used).toBe(inspectionBudget.entries);
    } finally {
      opendir.mockRestore();
    }
  });
});
