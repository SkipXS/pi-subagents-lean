import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { validateWorktreePath, WORKTREE_VALIDATION_ERRORS } from "../../src/spawn/worktree-validator.js";

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Thin Pi exec adapter: command plus argument vector only, never a shell string. */
function createPiExec() {
  return {
    exec(command: string, args: string[], options?: { cwd?: string; timeout?: number }): Promise<ExecResult> {
      return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
          cwd: options?.cwd,
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = options?.timeout == null ? undefined : setTimeout(() => {
          timedOut = true;
          child.kill();
        }, options.timeout);
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.once("error", (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        });
        child.once("close", (code) => {
          if (timer) clearTimeout(timer);
          if (timedOut) reject(new Error("git command timed out"));
          else resolve({ code: code ?? 1, stdout, stderr });
        });
      });
    },
  };
}

async function git(pi: ReturnType<typeof createPiExec>, cwd: string, ...args: string[]): Promise<void> {
  const result = await pi.exec("git", args, { cwd, timeout: 10_000 });
  expect(result.code, result.stderr).toBe(0);
}

describe("validateWorktreePath real git integration", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    root = undefined;
  });

  it("accepts a main checkout and linked worktree, and rejects an independent repository", { timeout: 30_000 }, async () => {
    root = mkdtempSync(join(tmpdir(), "pi-worktree-validator-"));
    const main = join(root, "main");
    const linked = join(root, "linked");
    const foreign = join(root, "foreign");
    const pi = createPiExec();

    await git(pi, root, "init", main);
    writeFileSync(join(main, "README.md"), "initial\n");
    await git(pi, main, "add", "README.md");
    await git(pi, main, "-c", "user.name=Validator Test", "-c", "user.email=validator@example.test", "commit", "-m", "initial");
    await git(pi, main, "worktree", "add", "-b", "validator-linked", linked);

    await git(pi, root, "init", foreign);
    writeFileSync(join(foreign, "README.md"), "foreign\n");
    await git(pi, foreign, "add", "README.md");
    await git(pi, foreign, "-c", "user.name=Validator Test", "-c", "user.email=validator@example.test", "commit", "-m", "initial");

    const linkedFromMain = await validateWorktreePath(pi, linked, main);
    expect(linkedFromMain.ok).toBe(true);
    const mainFromLinked = await validateWorktreePath(pi, main, linked);
    expect(mainFromLinked.ok).toBe(true);

    // A validated nested directory must retain the linked worktree root rather
    // than treating an arbitrary descendant as an independent checkout.
    const nested = join(linked, "packages", "worker");
    mkdirSync(nested, { recursive: true });
    const nestedValidation = await validateWorktreePath(pi, nested, main);
    expect(nestedValidation).toMatchObject({ ok: true });
    if (nestedValidation.ok) {
      // realpath may use Windows' equivalent short path, so assert the
      // canonical relation rather than the input spelling.
      expect(nestedValidation.resolvedPath).toMatch(/\/linked\/packages\/worker$/);
      expect(nestedValidation.worktreeRoot).toMatch(/\/linked$/);
    }

    const notDirectory = join(root, "not-a-worktree");
    writeFileSync(notDirectory, "not a directory");
    expect(await validateWorktreePath(pi, notDirectory, main))
      .toEqual({ ok: false, error: WORKTREE_VALIDATION_ERRORS.NOT_A_DIRECTORY });

    const otherRepo = await validateWorktreePath(pi, foreign, main);
    expect(otherRepo).toEqual({ ok: false, error: WORKTREE_VALIDATION_ERRORS.DIFFERENT_REPO });
  });
});
