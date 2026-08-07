import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MAX_SERIALIZED_WORKER_SKILLS,
  MAX_SKILL_DESCRIPTION_BYTES,
  MAX_SKILL_NAME_BYTES,
  MAX_SKILL_PATH_BYTES,
} from "../../src/prompt/skill-limits.ts";
import { MAX_RESOURCE_FINGERPRINT_DEPTH } from "../../src/prompt/skill-fingerprint.ts";
import { loadSkillsFromDirCachedAsync } from "../../src/prompt/skill-cache.ts";

const workerMocks = vi.hoisted(() => {
  type Listener = (...args: any[]) => void;
  const state = {
    mode: "success" as
      | "success"
      | "error"
      | "response-error"
      | "exit"
      | "invalid"
      | "missing-id"
      | "bad-skills"
      | "construct"
      | "listener-error"
      | "post-error"
      | "terminate-error"
      | "hang"
      | "too-many"
      | "long-name"
      | "long-description"
      | "long-path",
    instances: [] as FakeWorker[],
    requests: [] as Array<{ source: string; options: any }>,
    posts: [] as any[],
  };

  class FakeWorker {
    private readonly listeners = new Map<string, Set<Listener>>();
    readonly source: string;
    readonly options: any;
    readonly terminate = vi.fn(() => {
      if (state.mode === "terminate-error") throw new Error("synthetic terminate failure");
      return Promise.resolve(0);
    });
    readonly off = vi.fn((event: string, listener: Listener): this => {
      this.listeners.get(event)?.delete(listener);
      return this;
    });

    constructor(source: string, options: any) {
      if (state.mode === "construct") throw new Error("synthetic constructor failure");
      this.source = source;
      this.options = options;
      state.instances.push(this);
      state.requests.push({ source, options });
    }

    postMessage(request: any): void {
      if (state.mode === "post-error") throw new Error("synthetic post failure");
      state.posts.push(request);
      if (state.mode === "hang") return;
      queueMicrotask(() => {
        if (state.mode === "error") {
          this.emit("error", new Error("synthetic worker discovery failure"));
          return;
        }
        if (state.mode === "response-error") {
          this.emit("message", {
            id: request.id,
            type: "error",
            error: { name: "PiWorkerError", message: "synthetic response failure", stack: "worker-stack" },
          });
          return;
        }
        if (state.mode === "exit") {
          this.emit("exit", 9);
          return;
        }
        if (state.mode === "invalid") {
          this.emit("message", null);
          return;
        }
        if (state.mode === "missing-id") {
          this.emit("message", { type: "skills", skills: [] });
          return;
        }
        if (state.mode === "bad-skills") {
          this.emit("message", { id: request.id, type: "skills", skills: [{}] });
          return;
        }
        if (state.mode === "too-many") {
          this.emit("message", {
            id: request.id,
            type: "skills",
            skills: Array.from({ length: MAX_SERIALIZED_WORKER_SKILLS + 1 }, (_, index) => ({
              name: `skill-${index}`,
              description: "bounded",
              filePath: "/skills/skill/SKILL.md",
              baseDir: "/skills/skill",
              sourceInfo: {},
              disableModelInvocation: false,
            })),
          });
          return;
        }
        if (state.mode === "long-name" || state.mode === "long-description" || state.mode === "long-path") {
          this.emit("message", {
            id: request.id,
            type: "skills",
            skills: [{
              name: state.mode === "long-name" ? "n".repeat(MAX_SKILL_NAME_BYTES + 1) : "worker-skill",
              description: state.mode === "long-description"
                ? "d".repeat(MAX_SKILL_DESCRIPTION_BYTES + 1)
                : "From worker",
              filePath: state.mode === "long-path"
                ? "/skills/" + "p".repeat(MAX_SKILL_PATH_BYTES)
                : "/skills/worker-skill/SKILL.md",
              baseDir: "/skills/worker-skill",
              sourceInfo: {},
              disableModelInvocation: false,
            }],
          });
          return;
        }
        const skills = request.operation === "loadSkills"
          ? [{
            name: "worker-skill",
            description: "From worker",
            filePath: join(request.input.cwd, ".pi", "skills", "worker-skill", "SKILL.md"),
            baseDir: join(request.input.cwd, ".pi", "skills", "worker-skill"),
            sourceInfo: { source: "project", scope: "project" },
            disableModelInvocation: false,
          }]
          : [];
        this.emit("message", { id: request.id, type: "skills", skills });
      });
    }

    on(event: string, listener: Listener): this {
      if (state.mode === "listener-error") throw new Error("synthetic listener failure");
      let listeners = this.listeners.get(event);
      if (!listeners) {
        listeners = new Set();
        this.listeners.set(event, listeners);
      }
      listeners.add(listener);
      return this;
    }

    emit(event: string, ...args: any[]): void {
      for (const fn of this.listeners.get(event) ?? []) fn(...args);
    }

    listenerCount(event: string): number {
      return this.listeners.get(event)?.size ?? 0;
    }
  }

  return { state, Worker: FakeWorker };
});

vi.mock("node:worker_threads", () => ({ Worker: workerMocks.Worker }));

let root = "";
let createPiSkillLoaderWorkerAdapter: typeof import("../../src/prompt/skill-loader-worker.ts").createPiSkillLoaderWorkerAdapter;
let loadSkillMetaAsync: typeof import("../../src/prompt/skill-loader.ts").loadSkillMetaAsync;

const input = () => ({
  cwd: join(root, "repo"),
  agentDir: join(root, "agent"),
  skillPaths: [],
  includeDefaults: true,
});

async function runWorkerRequest() {
  const adapter = createPiSkillLoaderWorkerAdapter();
  try {
    return await adapter.run("loadSkills", input());
  } finally {
    await adapter.close();
  }
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "skill-worker-adapter-"));
  mkdirSync(join(root, "repo", ".git"), { recursive: true });
  mkdirSync(join(root, "agent"), { recursive: true });
  workerMocks.state.mode = "success";
  workerMocks.state.instances.length = 0;
  workerMocks.state.requests.length = 0;
  workerMocks.state.posts.length = 0;
  vi.clearAllMocks();
  ({ createPiSkillLoaderWorkerAdapter } = await import("../../src/prompt/skill-loader-worker.ts"));
  ({ loadSkillMetaAsync } = await import("../../src/prompt/skill-loader.ts"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("skill loader worker transport", () => {
  it("resolves a file URL and serializes requests while sharing one worker", async () => {
    const adapter = createPiSkillLoaderWorkerAdapter();
    try {
      const first = await adapter.run("loadSkills", input());
      await expect(adapter.run("loadSkillsFromDir", { dir: join(root, "agent"), source: "user" }))
        .resolves.toEqual([]);
      expect(first[0]?.description).toBe("From worker");
      expect(workerMocks.state.instances).toHaveLength(1);
    } finally {
      await adapter.close();
    }

    for (const request of workerMocks.state.requests) {
      expect(request.options.eval).toBe(true);
      expect(request.options.execArgv).toEqual([]);
      expect(request.options.workerData.moduleUrl).toMatch(/^file:/);
      expect(() => JSON.stringify(request.options.workerData)).not.toThrow();
      expect(request.options.workerData).not.toHaveProperty("worker");
    }
    expect(workerMocks.state.posts).toHaveLength(2);
    for (const request of workerMocks.state.posts) {
      expect(() => JSON.stringify(request)).not.toThrow();
      expect(request).toEqual(expect.objectContaining({ id: expect.any(Number), operation: expect.any(String) }));
    }
  });

  it("does not construct a worker for a warm catalog cache", async () => {
    const cwd = join(root, "repo");
    const first = await loadSkillMetaAsync(["worker-skill"], cwd);
    expect(first[0]?.description).toBe("From worker");
    const workerCount = workerMocks.state.instances.length;

    await expect(loadSkillMetaAsync(["worker-skill"], cwd)).resolves.toEqual(first);
    expect(workerMocks.state.instances).toHaveLength(workerCount);
  });

  it("does not construct a worker after a fingerprint budget failure", async () => {
    const pathological = join(root, "pathological");
    mkdirSync(pathological);
    let current = pathological;
    for (let depth = 1; depth <= MAX_RESOURCE_FINGERPRINT_DEPTH + 1; depth++) {
      current = join(current, "d");
      mkdirSync(current);
    }

    const adapter = createPiSkillLoaderWorkerAdapter();
    try {
      await expect(loadSkillsFromDirCachedAsync(pathological, "agents", adapter.run))
        .rejects.toThrow(`maximum depth ${MAX_RESOURCE_FINGERPRINT_DEPTH}`);
      expect(workerMocks.state.instances).toHaveLength(0);
      expect(workerMocks.state.posts).toHaveLength(0);
    } finally {
      await adapter.close();
    }
  });

  it("times out a hung request with fake time and cleans up exactly once", async () => {
    vi.useFakeTimers();
    const adapter = createPiSkillLoaderWorkerAdapter();
    try {
      workerMocks.state.mode = "hang";
      const request = adapter.run("loadSkills", input());
      const rejection = expect(request).rejects.toThrow("timed out after 15000 ms");
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(15_000);
      await rejection;

      const worker = workerMocks.state.instances[0]!;
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(worker.off).toHaveBeenCalledTimes(3);
      expect(worker.listenerCount("message")).toBe(0);
      expect(worker.listenerCount("error")).toBe(0);
      expect(worker.listenerCount("exit")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);

      await adapter.close();
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(worker.off).toHaveBeenCalledTimes(3);
    } finally {
      await adapter.close();
      vi.useRealTimers();
    }
  });

  it("rejects bounded-result violations before a result can reach a caller", async () => {
    for (const [mode, message] of [
      ["too-many", `maximum ${MAX_SERIALIZED_WORKER_SKILLS} skills`],
      ["long-name", `maximum of ${MAX_SKILL_NAME_BYTES} UTF-8 bytes`],
      ["long-description", `maximum of ${MAX_SKILL_DESCRIPTION_BYTES} UTF-8 bytes`],
      ["long-path", `maximum of ${MAX_SKILL_PATH_BYTES} UTF-8 bytes`],
    ] as const) {
      workerMocks.state.mode = mode;
      await expect(runWorkerRequest()).rejects.toThrow(message);
      const worker = workerMocks.state.instances.at(-1)!;
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(worker.listenerCount("message")).toBe(0);
      expect(worker.listenerCount("error")).toBe(0);
      expect(worker.listenerCount("exit")).toBe(0);
    }
  });

  it("rejects worker errors and always terminates and detaches the worker", async () => {
    workerMocks.state.mode = "error";

    await expect(runWorkerRequest()).rejects.toThrow("synthetic worker discovery failure");

    expect(workerMocks.state.instances).toHaveLength(1);
    const worker = workerMocks.state.instances[0]!;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.listenerCount("message")).toBe(0);
    expect(worker.listenerCount("error")).toBe(0);
    expect(worker.listenerCount("exit")).toBe(0);
  });

  it.each([
    ["response-error", "synthetic response failure"],
    ["exit", "exited with code 9"],
    ["invalid", "invalid message"],
    ["missing-id", "message without an id"],
    ["bad-skills", "invalid skill metadata"],
    ["construct", "synthetic constructor failure"],
    ["listener-error", "synthetic listener failure"],
    ["post-error", "synthetic post failure"],
  ] as const)("fails and cleans up for a %s boundary failure", async (mode, message) => {
    workerMocks.state.mode = mode;

    await expect(runWorkerRequest()).rejects.toThrow(message);
    for (const worker of workerMocks.state.instances) {
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(worker.listenerCount("message")).toBe(0);
      expect(worker.listenerCount("error")).toBe(0);
      expect(worker.listenerCount("exit")).toBe(0);
    }
  });

  it("preserves a successful result when worker termination itself fails", async () => {
    workerMocks.state.mode = "terminate-error";
    const result = await runWorkerRequest();
    expect(result[0]?.name).toBe("worker-skill");
    expect(workerMocks.state.instances[0]?.terminate).toHaveBeenCalledOnce();
  });
});
