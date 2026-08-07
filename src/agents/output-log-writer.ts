/**
 * output-log-writer.ts — serialized, best-effort output-log operations.
 *
 * One writer is shared per absolute path. The store owns all security-sensitive
 * opens; this module only decides ordering, failure isolation, and flushing.
 */

import { dirname, resolve } from "node:path";
import {
  ensureOutputDirectoryForPath,
  releaseOutputRootIdentity,
  releaseOutputRootMarker,
  scheduleOutputRootCleanup,
  writeOutputFile,
} from "./output-log-store.js";

/** Per-log and per-parent-session output budgets, measured in UTF-8 bytes. */
export const MAX_OUTPUT_LOG_BYTES = 8 * 1024 * 1024;
export const MAX_OUTPUT_ROOT_BYTES = 64 * 1024 * 1024;

/** Stable marker emitted once when a log budget rejects further content. */
export const OUTPUT_TRUNCATION_MARKER = "[TRUNCATED]\n";

// Descriptive aliases keep the limits easy to discover for hosts/tests without
// creating a second configuration surface.
export const OUTPUT_LOG_MAX_BYTES = MAX_OUTPUT_LOG_BYTES;
export const OUTPUT_ROOT_MAX_BYTES = MAX_OUTPUT_ROOT_BYTES;

interface OutputAccounting {
  bytes: number;
  truncated: boolean;
}

/**
 * Roots are fresh per parent session, so enqueue-time process-local reservation
 * is sufficient for the live 64-MiB quota. Reservations happen synchronously
 * at enqueue time; this is the atomic boundary across all per-path writers
 * that may run in parallel. The root janitor owns persistent global retention.
 */
const fileAccounting = new Map<string, OutputAccounting>();
const rootAccounting = new Map<string, OutputAccounting>();

function accountingFor(map: Map<string, OutputAccounting>, key: string): OutputAccounting {
  let accounting = map.get(key);
  if (!accounting) {
    accounting = { bytes: 0, truncated: false };
    map.set(key, accounting);
  }
  return accounting;
}

/** Return a UTF-8 byte prefix without emitting a replacement character. */
function utf8Prefix(bytes: Buffer, maxBytes: number): Buffer {
  if (maxBytes <= 0) return Buffer.alloc(0);
  if (bytes.length <= maxBytes) return bytes;

  let lead = maxBytes - 1;
  while (lead >= 0 && (bytes[lead]! & 0xc0) === 0x80) lead--;
  if (lead < 0) return Buffer.alloc(0);

  const first = bytes[lead]!;
  const expectedLength = (first & 0x80) === 0
    ? 1
    : (first & 0xe0) === 0xc0
      ? 2
      : (first & 0xf0) === 0xe0
        ? 3
        : 4;
  return lead + expectedLength <= maxBytes
    ? bytes.subarray(0, maxBytes)
    : bytes.subarray(0, lead);
}

/**
 * Reserve one content chunk against both budgets and return the exact payload
 * that may be written. The reservation is conservative when a Unicode prefix
 * cannot fill every remaining byte, which keeps both limits hard under races.
 */
function reserveOutput(path: string, content: string): string {
  if (!content) return "";

  const fileKey = resolve(path);
  const rootKey = resolve(dirname(fileKey));
  const file = accountingFor(fileAccounting, fileKey);
  const root = accountingFor(rootAccounting, rootKey);

  if (file.truncated || root.truncated) {
    file.truncated = true;
    return "";
  }

  const contentBytes = Buffer.from(content, "utf8");
  const fileRemaining = Math.max(0, MAX_OUTPUT_LOG_BYTES - file.bytes);
  const rootRemaining = Math.max(0, MAX_OUTPUT_ROOT_BYTES - root.bytes);
  const available = Math.min(fileRemaining, rootRemaining);

  if (contentBytes.length <= available) {
    file.bytes += contentBytes.length;
    root.bytes += contentBytes.length;
    return content;
  }

  // This attempted write crosses at least one boundary. Freeze the affected
  // log immediately; if the root is the limiting boundary, freeze the root so
  // later parallel writers cannot add content after its cap was reached.
  file.truncated = true;
  if (rootRemaining <= fileRemaining) root.truncated = true;

  if (available <= 0) return "";

  const markerBytes = Buffer.from(OUTPUT_TRUNCATION_MARKER, "utf8");
  const payload = available >= markerBytes.length
    ? Buffer.concat([utf8Prefix(contentBytes, available - markerBytes.length), markerBytes])
    : markerBytes.subarray(0, available);
  const payloadText = payload.toString("utf8");
  const writtenBytes = Buffer.byteLength(payloadText, "utf8");
  file.bytes += writtenBytes;
  root.bytes += writtenBytes;
  return payloadText;
}

/** Read-only live accounting, primarily useful to deterministic hosts/tests. */
export function getOutputLogAccounting(path: string): Readonly<{
  fileBytes: number;
  rootBytes: number;
  fileTruncated: boolean;
  rootTruncated: boolean;
}> {
  const fileKey = resolve(path);
  const rootKey = resolve(dirname(fileKey));
  const file = fileAccounting.get(fileKey);
  const root = rootAccounting.get(rootKey);
  return Object.freeze({
    fileBytes: file?.bytes ?? 0,
    rootBytes: root?.bytes ?? 0,
    fileTruncated: file?.truncated ?? false,
    rootTruncated: root?.truncated ?? false,
  });
}

/**
 * One append/write queue for one physical log path. Every operation catches its
 * own I/O failure so a broken log cannot poison later operations or the caller
 * that submitted them.
 */
class SerialLogWriter {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  constructor(private readonly onIdle: () => void) {}

  enqueue(operation: () => Promise<void>): Promise<void> {
    this.pending++;
    const next = this.tail
      .catch(() => undefined)
      .then(async () => {
        try {
          await operation();
        } catch {
          // Output logs are optional best-effort telemetry.
        } finally {
          this.pending--;
        }
      });
    this.tail = next;
    // Retire only after this operation settles. A write queued before that
    // point increments pending and therefore keeps this exact writer alive.
    void next.then(() => this.retireIfIdle());
    return next;
  }

  whenIdle(): Promise<void> {
    return this.tail.catch(() => undefined);
  }

  isIdle(): boolean {
    return this.pending === 0;
  }

  private retireIfIdle(): void {
    if (this.pending === 0) this.onIdle();
  }
}

/** Writers are shared by path so separate execution wrappers cannot race. */
const writers = new Map<string, SerialLogWriter>();
let writerGeneration = 0;

function writerFor(path: string): SerialLogWriter {
  const key = resolve(path);
  let writer = writers.get(key);
  if (!writer) {
    let createdWriter: SerialLogWriter;
    createdWriter = new SerialLogWriter(() => {
      // Identity and idle checks prevent an old writer from deleting a newer
      // writer created for the same path after the old queue drained.
      if (createdWriter.isIdle() && writers.get(key) === createdWriter) {
        writers.delete(key);
      }
    });
    writer = createdWriter;
    writers.set(key, writer);
    writerGeneration++;
  }
  return writer;
}

/** Queue directory setup without treating the not-yet-created log as a file. */
export function enqueueOutputDirectory(path: string): Promise<void> {
  return writerFor(path).enqueue(() => ensureOutputDirectoryForPath(path));
}

/** Queue one budgeted initial or append write behind all prior path writes. */
export function enqueueOutputWrite(path: string, append: boolean, content: string): Promise<void> {
  const payload = reserveOutput(path, content);
  if (!payload) return Promise.resolve();
  return writerFor(path).enqueue(() => writeOutputFile(path, append, payload));
}

/** Wait for one path's queued writes without creating a retained idle writer. */
export function whenOutputLogIdle(path: string): Promise<void> {
  return writers.get(resolve(path))?.whenIdle() ?? Promise.resolve();
}

/**
 * Wait for all output-log writes submitted so far. This is intentionally not
 * used by the agent manager's hot lifecycle paths; it exists for tests and
 * hosts that explicitly want to wait for best-effort telemetry.
 */
export async function whenOutputLogsIdle(): Promise<void> {
  // Capture currently queued writers, then re-check generation and pending
  // state so retirement/recreation cannot hide a write submitted while waiting.
  while (true) {
    const generation = writerGeneration;
    const snapshot = [...writers.values()];
    await Promise.all(snapshot.map((writer) => writer.whenIdle()));
    if (
      generation === writerGeneration
      && snapshot.every((writer) => writer.isIdle())
      && [...writers.values()].every((writer) => writer.isIdle())
    ) return;
  }
}

/**
 * Wait for all writers whose path belongs directly to one root. Writer maps are
 * intentionally left alone: an idle writer retires itself, while queued work
 * remains ordered and can finish before the root's process-local resources are
 * released.
 */
export async function whenOutputRootIdle(root: string): Promise<void> {
  const rootKey = resolve(root);
  while (true) {
    const generation = writerGeneration;
    const snapshot = [...writers.entries()]
      .filter(([path]) => resolve(dirname(path)) === rootKey)
      .map(([, writer]) => writer);
    await Promise.all(snapshot.map((writer) => writer.whenIdle()));
    const current = [...writers.entries()]
      .filter(([path]) => resolve(dirname(path)) === rootKey)
      .map(([, writer]) => writer);
    if (
      generation === writerGeneration
      && snapshot.every((writer) => writer.isIdle())
      && current.every((writer) => writer.isIdle())
    ) return;
  }
}

/**
 * Explicitly release one output root's process-local accounting and identity.
 * This is deliberately asynchronous and non-blocking for lifecycle callers:
 * queued writes drain first, then only the accounting/identity maps are
 * cleared. Files and the root remain persistent on disk for the janitor.
 */
export async function releaseOutputRoot(root: string): Promise<void> {
  const rootKey = resolve(root);
  await whenOutputRootIdle(rootKey);
  for (const path of fileAccounting.keys()) {
    if (resolve(dirname(path)) === rootKey) fileAccounting.delete(path);
  }
  rootAccounting.delete(rootKey);
  await releaseOutputRootMarker(rootKey);
  releaseOutputRootIdentity(rootKey);
  scheduleOutputRootCleanup();
}

/** Descriptive alias for hosts that treat output roots as owned resources. */
export const releaseOutputLogResources = releaseOutputRoot;

/** Short alias for explicit test/shutdown flushing. */
export function whenIdle(): Promise<void> {
  return whenOutputLogsIdle();
}
