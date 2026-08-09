/**
 * fixtures.ts — Shared test fixtures and helpers for the subagents extension tests.
 *
 * Provides:
 *   - createMockExtensionAPI: mock ExtensionAPI for index test
 *   - hasParam: check TypeBox schema for a parameter
 *   - loadExtension: import and invoke the extension factory
 *   - tempDirFixture: temp directory setup/teardown for filesystem tests
 *   - canCreateSymlinks: detect whether the current host permits file symlink creation
 *   - createDirectoryLink / canCreateDirectoryLinks: portable directory-link fixtures
 *   - makeAgentMd: build agent .md content from frontmatter fields
 *   - tempDirWithFiles: create a temp dir with files for scanAgentFilesInDir tests
 *
 * Shared mock factories (for vi.mock call sites):
 *   - shellMock: ../src/shell.js stubs (parameterized by hoisted fns)
 */

import { vi } from "vitest";
import { acceptResolvedSpawn, snapshotResolvedSpawn } from "../src/spawn/spawn-contract.js";
import type { AcceptedSpawn, ResolvedSpawn } from "../src/spawn/spawn-contract.js";

/* ================================================================== */
/*  Shared mock factories                                             */
/*  These return factory bodies for vi.mock() calls.                  */
/*  Each test file keeps its own vi.mock("path", factory) line;       */
/*  only the factory BODY is deduplicated here.                       */
/* ================================================================== */

/* ------------------------------------------------------------------ */
/*  Per-test-overridable mock builders                                */
/*  These accept hoisted fns from the test file so behavior can be    */
/*  controlled per-test. The test file keeps its own vi.hoisted().    */
/* ------------------------------------------------------------------ */

export interface ShellMockFns {
  manager?: any;
  pi?: any;
  sessionCtx?: any;
  store?: any;
  coordinator?: any;
}

/**
 * ../src/shell.js mock builder.
 * Accepts partial overrides; defaults to no-op stubs.
 * Pass hoisted fns for per-test behavioral control.
 *
 * Usage:
 *   const { mockAbort } = vi.hoisted(() => ({ mockAbort: vi.fn() }));
 *   vi.mock("../src/shell.js", () => shellMock({
 *     manager: { abort: mockAbort, getRecord: vi.fn(), listAgents: vi.fn() },
 *   }));
 */
export function shellMock(fns: ShellMockFns = {}) {
  const manager = fns.manager ?? {
    abort: vi.fn(),
    getRecord: vi.fn(),
    listAgents: vi.fn(() => []),
    spawn: vi.fn(),
    getTotalAgentCost: vi.fn(() => 0),
    getTotalAgentCount: vi.fn(() => 0),
  };
  const pi = fns.pi ?? { exec: vi.fn() };
  const sessionCtx = fns.sessionCtx ?? { cwd: "/home/test" };
  const store = fns.store ?? { agent: { disableDefaultAgents: false } };
  const coordinator = fns.coordinator ?? { spawn: vi.fn() };

  return {
    getManager: () => manager,
    getPiInstance: () => pi,
    getSessionCtx: () => sessionCtx,
    getStore: () => store,
    getCoordinator: () => coordinator,
  };
}

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/* ------------------------------------------------------------------ */
/*  Extension API mock                                                */
/* ------------------------------------------------------------------ */

export interface RegisteredTool {
  name: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string;
  parameters: any; // TypeBox TSchema
  constrainedSampling?: unknown;
  renderCall?: (...args: any[]) => any;
  renderResult?: (...args: any[]) => any;
  execute?: (...args: any[]) => any;
}

export interface ListenerRegistration {
  event: string;
  handler: (...args: any[]) => any;
}

export interface MockExtensionAPI {
  tools: RegisteredTool[];
  listeners: ListenerRegistration[];
  api: {
    registerTool: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    sendUserMessage: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
    exec: ReturnType<typeof vi.fn>;
  };
}

/**
 * Create a mock ExtensionAPI that captures registered tools and listeners.
 */
export function createMockExtensionAPI(): MockExtensionAPI {
  const tools: RegisteredTool[] = [];
  const listeners: ListenerRegistration[] = [];

  return {
    tools,
    listeners,
    api: {
      registerTool: vi.fn((tool: any) => {
        tools.push(tool);
      }),
      on: vi.fn((event: string, handler: any) => {
        listeners.push({ event, handler });
      }),
      sendUserMessage: vi.fn(),
      sendMessage: vi.fn(),
      exec: vi.fn(),
    },
  };
}

/**
 * Check if a specific param exists in a TypeBox schema.
 * The TypeBox mock always produces { type: "object", properties }, so only
 * the `properties` path is tested — no speculative fallbacks needed.
 */
export function hasParam(schema: any, paramName: string): boolean {
  return paramName in (schema?.properties ?? {});
}

/**
 * Import and invoke the extension factory.
 * Returns the factory function for chaining.
 */
export async function loadExtension(api: any) {
  const factory = (await import("../src/index.js")).default;
  return factory(api);
}

/* ------------------------------------------------------------------ */
/*  Temp directory fixture                                            */
/* ------------------------------------------------------------------ */

/**
 * Returns a setup/teardown pair for a temp directory.
 * Call setup() in beforeEach, teardown() in afterEach.
 */
export function tempDirFixture(prefix = "subagents-test") {
  let tmpDir: string;

  return {
    setup: () => {
      tmpDir = join(
        tmpdir(),
        `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      mkdirSync(tmpDir, { recursive: true });
      return tmpDir;
    },
    getDir: () => tmpDir,
    teardown: () => {
      if (tmpDir) {
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    },
  };
}

/** Create a directory link, using a junction on Windows to avoid the symlink privilege. */
export function createDirectoryLink(target: string, link: string): void {
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

/** Return whether this host currently permits creating file symlinks. */
export function canCreateSymlinks(): boolean {
  return canCreateLink("file");
}

/** Return whether this host currently permits creating directory links. */
export function canCreateDirectoryLinks(): boolean {
  return canCreateLink("dir");
}

function canCreateLink(type: "dir" | "file"): boolean {
  const dir = mkdtempSync(join(tmpdir(), "pi-symlink-capability-"));
  try {
    const target = join(dir, "target");
    if (type === "dir") {
      mkdirSync(target);
      createDirectoryLink(target, join(dir, "link"));
    } else {
      writeFileSync(target, "target");
      symlinkSync(target, join(dir, "link"), "file");
    }
    return true;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (["EACCES", "ENOSYS", "ENOTSUP", "EPERM"].includes(code ?? "")) {
      return false;
    }
    throw error;
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/* ------------------------------------------------------------------ */
/*  Agent markdown helpers                                            */
/* ------------------------------------------------------------------ */

/**
 * Build a minimal agent .md content string with frontmatter.
 * Fields are snake_case as they would appear in frontmatter.
 * Pass `_skip: string[]` to omit any fields from the defaults.
 */
export function makeAgentMd(overrides: Record<string, unknown> = {}): string {
  const skipFields = (overrides._skip as string[]) ?? [];
  const defaults: Record<string, string> = {
    name: "test-agent",
    description: "A test agent",
    model: "anthropic/claude-sonnet-4-6",
    tools: "read, bash, edit",
    extensions: "true",
    skills: "true",
    thinking: "off",
    disallowed_tools: "",
    enabled: "true",
  };
  const fm: Record<string, string> = { ...defaults };
  for (const [key, val] of Object.entries(overrides)) {
    if (key === "_skip") continue;
    if (val === undefined) {
      delete fm[key];
    } else {
      fm[key] = String(val);
    }
  }
  for (const key of skipFields) {
    delete fm[key];
  }
  const yaml = Object.entries(fm)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `---\n${yaml}\n---\n\nSystem prompt body text.`;
}

/**
 * Create a temp directory with agent .md files for scanAgentFilesInDir tests.
 * Returns { dir, cleanup } — call cleanup() in afterEach.
 */
export function tempDirWithFiles(
  files: Array<{ name: string; content: string }>,
  prefix = "agent-test",
): { dir: string; cleanup: () => void } {
  const dir = join(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  for (const file of files) {
    writeFileSync(join(dir, file.name), file.content);
  }
  return {
    dir,
    cleanup: () => {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

/*  Fake context / pi                                                 */
/* ------------------------------------------------------------------ */

/**
 * Create a minimal fake pi context for agent tests.
 */
export function fakeCtx(): any {
  return {
    cwd: "/home/test/project",
    modelRegistry: { find: vi.fn() },
    model: { provider: "test", id: "model" },
    getSystemPrompt: vi.fn(),
  };
}

/**
 * Create a minimal fake pi instance for agent tests.
 */
export function fakePi(): any {
  return { exec: vi.fn() };
}

/** Build the immutable preflight contract used by manager/coordinator tests. */
export function resolvedSpawnFixture(overrides: Partial<ResolvedSpawn> = {}): ResolvedSpawn {
  const {
    type = "test-agent",
    prompt = "test task",
    description = prompt.split("\n")[0]!.slice(0, 80),
    agentConfig = {
      name: type,
      description,
      systemPrompt: "Test agent instructions.",
    },
    projectTrusted = false,
    ...rest
  } = overrides;
  return snapshotResolvedSpawn({
    type,
    prompt,
    description,
    agentConfig,
    projectTrusted,
    ...rest,
  });
}

/** Build the immutable contract carried from manager acceptance to the runner. */
export function acceptedSpawnFixture(overrides: Partial<ResolvedSpawn> = {}): AcceptedSpawn {
  return acceptResolvedSpawn(resolvedSpawnFixture(overrides));
}

/** Invoke the production manager with a real resolved contract fixture. */
export function spawnWithResolvedFixture(
  manager: { spawn: (pi: any, ctx: any, resolved: ResolvedSpawn) => string },
  pi: any,
  ctx: any,
  typeOrResolved: string | ResolvedSpawn,
  promptOrOptions?: string | Record<string, unknown>,
  legacyOptions?: Record<string, unknown>,
): string {
  if (typeof typeOrResolved !== "string") return manager.spawn(pi, ctx, typeOrResolved);
  const prompt = typeof promptOrOptions === "string" ? promptOrOptions : "test task";
  const options = (legacyOptions ?? (typeof promptOrOptions === "object" ? promptOrOptions : {})) as Record<string, unknown>;
  const {
    description,
    ...contractFields
  } = options;
  return manager.spawn(pi, ctx, resolvedSpawnFixture({
    ...(contractFields as Partial<ResolvedSpawn>),
    type: typeOrResolved,
    prompt,
    description: typeof description === "string" ? description : undefined,
  }));
}

/**
 * Create a resolvable promise for async concurrency tests.
 */
export function makeResolvablePromise() {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/* ------------------------------------------------------------------ */
/*  Skill file helpers                                                */
/* ------------------------------------------------------------------ */

/**
 * Create a skill directory with SKILL.md in <tmpDir>/.pi/skills/<name>/.
 */
export function createSkillDir(tmpDir: string, name: string, description: string, body: string) {
  const skillDir = join(tmpDir, ".pi", "skills", name);
  mkdirSync(skillDir, { recursive: true });
  const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
  writeFileSync(join(skillDir, "SKILL.md"), content);
}

/**
 * Create a flat skill file in <tmpDir>/.pi/skills/<name>.md.
 */
export function createFlatSkill(tmpDir: string, name: string, description: string, body: string) {
  const skillsDir = join(tmpDir, ".pi", "skills");
  mkdirSync(skillsDir, { recursive: true });
  const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
  writeFileSync(join(skillsDir, `${name}.md`), content);
}
