/**
 * Worker transport for Pi skill discovery.
 *
 * Pi's public skill loaders are synchronous. Async callers use one short-lived
 * worker per catalog load so the event loop is not blocked and the host's Pi
 * module instance is never passed through structured clone.
 */

import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { Skill } from "@earendil-works/pi-coding-agent";
import {
  assertBoundedSkillResult,
  MAX_SERIALIZED_WORKER_SKILLS,
  MAX_SKILL_METADATA_PAYLOAD_BYTES,
  MAX_SKILL_DESCRIPTION_BYTES,
  MAX_SKILL_NAME_BYTES,
  MAX_SKILL_PATH_BYTES,
} from "./skill-limits.js";

export {
  MAX_SERIALIZED_WORKER_SKILLS,
  MAX_SKILL_METADATA_PAYLOAD_BYTES,
  MAX_SKILL_DESCRIPTION_BYTES,
  MAX_SKILL_NAME_BYTES,
  MAX_SKILL_PATH_BYTES,
} from "./skill-limits.js";

const PI_CODING_AGENT_MODULE = "@earendil-works/pi-coding-agent";
/** Hard production timeout for one Pi skill-loader request. */
export const PI_SKILL_LOADER_TIMEOUT_MS = 15_000;

export type PiSkillLoaderOperation = "loadSkills" | "loadSkillsFromDir";

export type PiSkillLoaderInput =
  | { cwd: string; agentDir: string; skillPaths: string[]; includeDefaults: boolean }
  | { dir: string; source: string };

type WorkerSkill = Pick<
  Skill,
  "name" | "description" | "filePath" | "baseDir" | "sourceInfo" | "disableModelInvocation"
>;

interface WorkerErrorMessage {
  name: string;
  message: string;
  stack?: string;
}

interface WorkerSkillsMessage {
  id: number;
  type: "skills";
  skills: WorkerSkill[];
}

interface WorkerFailureMessage {
  id: number;
  type: "error";
  error: WorkerErrorMessage;
}

/**
 * Keep the worker as inline JavaScript. Installed packages ship TypeScript
 * sources, but Node must not be asked to execute a .ts worker entrypoint.
 */
const PI_SKILL_LOADER_WORKER_SOURCE = `
"use strict";
const { parentPort, workerData } = require("node:worker_threads");

function serializeError(error) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: "Error", message: String(error) };
}

const MAX_SERIALIZED_WORKER_SKILLS = ${MAX_SERIALIZED_WORKER_SKILLS};
const MAX_SKILL_METADATA_PAYLOAD_BYTES = ${MAX_SKILL_METADATA_PAYLOAD_BYTES};
const MAX_SKILL_NAME_BYTES = ${MAX_SKILL_NAME_BYTES};
const MAX_SKILL_DESCRIPTION_BYTES = ${MAX_SKILL_DESCRIPTION_BYTES};
const MAX_SKILL_PATH_BYTES = ${MAX_SKILL_PATH_BYTES};

function assertBoundedString(value, field, maxBytes, index) {
  if (typeof value !== "string") {
    throw new Error("Pi skill loader worker returned invalid skill metadata at index " + index);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error("Pi skill loader worker skill " + index + " " + field
      + " exceeds the maximum of " + maxBytes + " UTF-8 bytes");
  }
}

function serializeSkill(skill, index) {
  if (!skill || typeof skill !== "object"
    || !skill.sourceInfo || typeof skill.sourceInfo !== "object"
    || typeof skill.disableModelInvocation !== "boolean") {
    throw new Error("Pi skill loader worker returned invalid skill metadata at index " + index);
  }
  assertBoundedString(skill.name, "name", MAX_SKILL_NAME_BYTES, index);
  assertBoundedString(skill.description, "description", MAX_SKILL_DESCRIPTION_BYTES, index);
  assertBoundedString(skill.filePath, "filePath path", MAX_SKILL_PATH_BYTES, index);
  assertBoundedString(skill.baseDir, "baseDir path", MAX_SKILL_PATH_BYTES, index);
  if (skill.sourceInfo.path !== undefined) {
    assertBoundedString(skill.sourceInfo.path, "sourceInfo path", MAX_SKILL_PATH_BYTES, index);
  }
  if (skill.sourceInfo.baseDir !== undefined) {
    assertBoundedString(skill.sourceInfo.baseDir, "sourceInfo baseDir path", MAX_SKILL_PATH_BYTES, index);
  }
  return {
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    baseDir: skill.baseDir,
    sourceInfo: skill.sourceInfo,
    disableModelInvocation: skill.disableModelInvocation,
  };
}

const piModule = import(workerData.moduleUrl);
// Attach import failures until a request can receive their serialized error.
piModule.catch(() => {});
parentPort.on("message", async (request) => {
  try {
    const pi = await piModule;
    let result;
    if (request.operation === "loadSkills") {
      result = pi.loadSkills(request.input);
    } else if (request.operation === "loadSkillsFromDir") {
      result = pi.loadSkillsFromDir(request.input);
    } else {
      throw new Error("Unknown Pi skill loader operation");
    }
    if (!result || !Array.isArray(result.skills)) {
      throw new Error("Pi skill loader worker returned an invalid skill result");
    }
    if (result.skills.length > MAX_SERIALIZED_WORKER_SKILLS) {
      throw new Error("Pi skill loader worker returned too many skills: maximum "
        + MAX_SERIALIZED_WORKER_SKILLS + " skills");
    }

    // Build the structured-clone payload one skill at a time. Measuring the
    // exact JSON metadata representation before postMessage keeps a large
    // result from being duplicated by a whole-array JSON.stringify and makes
    // the 4 MiB boundary deterministic for multibyte metadata.
    const skills = [];
    let payloadBytes = 2; // []
    for (let index = 0; index < result.skills.length; index++) {
      const serialized = serializeSkill(result.skills[index], index);
      let encoded;
      try {
        encoded = JSON.stringify(serialized);
      } catch {
        throw new Error("Pi skill loader worker returned invalid serializable skill metadata at index " + index);
      }
      if (encoded === undefined) {
        throw new Error("Pi skill loader worker returned invalid serializable skill metadata at index " + index);
      }
      const nextBytes = payloadBytes + Buffer.byteLength(encoded, "utf8") + (index === 0 ? 0 : 1);
      if (nextBytes > MAX_SKILL_METADATA_PAYLOAD_BYTES) {
        throw new Error("Pi skill loader worker metadata payload exceeds the maximum of "
          + MAX_SKILL_METADATA_PAYLOAD_BYTES + " UTF-8 bytes at skill " + index);
      }
      payloadBytes = nextBytes;
      skills.push(serialized);
    }
    parentPort.postMessage({
      id: request.id,
      type: "skills",
      skills,
    });
  } catch (error) {
    parentPort.postMessage({ id: request.id, type: "error", error: serializeError(error) });
  }
});
`;

function resolvePiSkillLoaderModuleUrl(): string {
  const importMetaWithResolve = import.meta as ImportMeta & {
    resolve?: (specifier: string, parent?: string) => string;
  };
  let resolutionError: unknown;

  if (typeof importMetaWithResolve.resolve === "function") {
    try {
      const resolved = importMetaWithResolve.resolve(PI_CODING_AGENT_MODULE);
      if (resolved.startsWith("file:")) return resolved;
      return pathToFileURL(resolve(resolved)).href;
    } catch (error) {
      resolutionError = error;
    }
  }

  try {
    const resolved = createRequire(import.meta.url).resolve(PI_CODING_AGENT_MODULE);
    return pathToFileURL(resolved).href;
  } catch (error) {
    throw new Error(
      `Unable to resolve ${PI_CODING_AGENT_MODULE} for the skill loader worker`,
      { cause: resolutionError ?? error },
    );
  }
}

function workerErrorToError(error: WorkerErrorMessage): Error {
  const result = new Error(error.message);
  result.name = error.name;
  if (error.stack) result.stack = error.stack;
  return result;
}

function isWorkerErrorMessage(value: unknown): value is WorkerFailureMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WorkerFailureMessage>;
  const error = candidate.error;
  return Number.isInteger(candidate.id)
    && candidate.type === "error"
    && !!error
    && typeof error === "object"
    && typeof error.name === "string"
    && typeof error.message === "string";
}

function decodeWorkerSkillsMessage(value: unknown): Skill[] {
  if (!value || typeof value !== "object") {
    throw new Error("Pi skill loader worker returned an invalid message");
  }
  const message = value as Partial<WorkerSkillsMessage>;
  if (!Number.isInteger(message.id)
    || message.type !== "skills"
    || !Array.isArray(message.skills)) {
    throw new Error("Pi skill loader worker returned invalid skill metadata");
  }
  assertBoundedSkillResult(message.skills, "Pi skill loader worker");
  return message.skills;
}

export type PiSkillLoaderRunner = (
  operation: PiSkillLoaderOperation,
  input: PiSkillLoaderInput,
) => Promise<Skill[]>;

export interface PiSkillLoaderWorkerAdapter {
  run: PiSkillLoaderRunner;
  close: () => Promise<void>;
}

export interface PiSkillLoaderWorkerAdapterOptions {
  /** Test-only shortening hook; production is always capped at 15 seconds. */
  timeoutMs?: number;
}

interface PendingWorkerRequest {
  operation: PiSkillLoaderOperation;
  resolve: (skills: Skill[]) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  timerCleared: boolean;
}

function normalizeWorkerTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return PI_SKILL_LOADER_TIMEOUT_MS;
  return Math.max(0, Math.min(PI_SKILL_LOADER_TIMEOUT_MS, Math.floor(timeoutMs)));
}

/**
 * Lazily share one worker across source cache misses in one async catalog
 * load. Warm catalogs never construct it; close() is idempotent and is called
 * by the catalog's finally block.
 */
export function createPiSkillLoaderWorkerAdapter(
  options: PiSkillLoaderWorkerAdapterOptions = {},
): PiSkillLoaderWorkerAdapter {
  const timeoutMs = normalizeWorkerTimeout(options.timeoutMs);
  let worker: Worker | undefined;
  let workerTermination: Promise<void> | undefined;
  let closed = false;
  let fatalError: Error | undefined;
  let nextRequestId = 1;
  const pending = new Map<number, PendingWorkerRequest>();

  const clearRequestTimer = (request: PendingWorkerRequest): void => {
    if (request.timer === undefined || request.timerCleared) return;
    request.timerCleared = true;
    clearTimeout(request.timer);
  };

  const failPending = (error: Error): void => {
    for (const request of pending.values()) {
      clearRequestTimer(request);
      request.reject(error);
    }
    pending.clear();
  };

  const detach = (current: Worker): void => {
    current.off("message", onMessage);
    current.off("error", onError);
    current.off("exit", onExit);
  };

  const terminateWorker = (current: Worker): Promise<void> => {
    try {
      return Promise.resolve(current.terminate()).then(() => undefined, () => undefined);
    } catch {
      return Promise.resolve();
    }
  };

  const terminateCurrentWorker = (): void => {
    const current = worker;
    if (!current) return;
    worker = undefined;
    detach(current);
    workerTermination = terminateWorker(current);
  };

  const failAdapter = (error: Error): void => {
    if (!fatalError) fatalError = error;
    const failure = fatalError;
    failPending(failure);
    terminateCurrentWorker();
  };

  const onRequestTimeout = (id: number, operation: PiSkillLoaderOperation): void => {
    if (!pending.has(id)) return;
    const error = new Error(
      `Pi skill loader worker timed out after ${timeoutMs} ms during ${operation}; worker terminated`,
    );
    error.name = "PiSkillLoaderTimeoutError";
    failAdapter(error);
  };

  const onMessage = (message: unknown): void => {
    if (!message || typeof message !== "object") {
      failAdapter(new Error("Pi skill loader worker returned an invalid message"));
      return;
    }
    const candidate = message as { id?: unknown };
    if (!Number.isInteger(candidate.id)) {
      failAdapter(new Error("Pi skill loader worker returned a message without an id"));
      return;
    }
    const id = candidate.id as number;
    const request = pending.get(id);
    if (!request) return;

    if (isWorkerErrorMessage(message)) {
      pending.delete(id);
      clearRequestTimer(request);
      request.reject(workerErrorToError(message.error));
      return;
    }
    pending.delete(id);
    clearRequestTimer(request);
    try {
      request.resolve(decodeWorkerSkillsMessage(message));
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      request.reject(failure);
      failAdapter(failure);
    }
  };

  const onError = (error: Error): void => {
    failAdapter(error instanceof Error ? error : new Error(String(error)));
  };

  const onExit = (code: number): void => {
    if (closed || fatalError) return;
    failAdapter(new Error(`Pi skill loader worker exited with code ${code}`));
  };

  const ensureWorker = (): Worker => {
    if (closed) throw new Error("Pi skill loader worker adapter is closed");
    if (fatalError) throw fatalError;
    if (worker) return worker;

    try {
      worker = new Worker(PI_SKILL_LOADER_WORKER_SOURCE, {
        eval: true,
        // Do not inherit a host test/tool loader for this plain JavaScript.
        execArgv: [],
        workerData: { moduleUrl: resolvePiSkillLoaderModuleUrl() },
      });
      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.on("exit", onExit);
      return worker;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      fatalError = failure;
      const current = worker;
      if (current) {
        worker = undefined;
        detach(current);
        workerTermination = terminateWorker(current);
      }
      throw failure;
    }
  };

  const run: PiSkillLoaderRunner = (operation, input) => {
    let current: Worker;
    try {
      current = ensureWorker();
    } catch (error) {
      return Promise.reject(error);
    }

    const id = nextRequestId++;
    return new Promise<Skill[]>((resolveResult, rejectResult) => {
      const request: PendingWorkerRequest = {
        operation,
        resolve: resolveResult,
        reject: rejectResult,
        timerCleared: false,
      };
      pending.set(id, request);
      try {
        request.timer = setTimeout(() => onRequestTimeout(id, operation), timeoutMs);
        current.postMessage({ id, operation, input });
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        failAdapter(failure);
      }
    });
  };

  const close = async (): Promise<void> => {
    if (closed) {
      if (workerTermination) await workerTermination;
      return;
    }
    closed = true;
    failPending(new Error("Pi skill loader worker closed"));
    terminateCurrentWorker();
    if (workerTermination) await workerTermination;
  };

  return { run, close };
}
