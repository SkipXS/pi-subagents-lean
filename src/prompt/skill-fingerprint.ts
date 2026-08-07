/**
 * Stable, bounded resource fingerprints used by the skill source caches.
 *
 * The walker owns the complete metadata snapshot and its sync/async budgets;
 * this facade owns the serialized fingerprint format and public API.
 */

import { resolve } from "node:path";
import {
  walkResourceTree,
  walkResourceTreeAsync,
  type FingerprintWalkResult,
  type ResolvedResourceFingerprintOptions,
} from "./skill-fingerprint-walk.js";
import type { ResourceFingerprintOptions } from "./skill-fingerprint-walk.js";

export {
  MAX_RESOURCE_FINGERPRINT_ENTRIES,
  MAX_RESOURCE_FINGERPRINT_DEPTH,
  MAX_SKILL_MARKDOWN_BYTES,
  MAX_SKILL_IGNORE_BYTES,
  MAX_SKILL_RELEVANT_BYTES_PER_ROOT,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_IGNORE_FILE_BYTES,
  MAX_RESOURCE_RELEVANT_BYTES,
  MAX_SKILL_ROOT_BYTES,
  ResourceFingerprintLimitError,
  type ResourceFingerprintLimit,
  type ResourceFingerprintOptions,
} from "./skill-fingerprint-walk.js";

export interface ResourceFingerprint {
  value: string;
  stable: boolean;
  /** Bytes of files that the corresponding Pi skill loader may read. */
  relevantBytes: number;
  /** Number of candidate skill Markdown files in the root. */
  skillCount: number;
}

function optionsWithDefaults(options: ResourceFingerprintOptions | undefined): ResolvedResourceFingerprintOptions {
  return {
    allowRootMarkdown: options?.allowRootMarkdown ?? true,
    countRootMarkdown: options?.countRootMarkdown ?? options?.allowRootMarkdown ?? true,
  };
}

function formatFingerprint(
  options: ResolvedResourceFingerprintOptions,
  walked: FingerprintWalkResult,
): ResourceFingerprint {
  return {
    // The walk records root-relative names and stable filesystem metadata. Do
    // not serialize the caller's absolute spelling: Windows may expose the
    // same directory as either a long or 8.3 path.
    value: JSON.stringify([options, walked.records, walked.relevantBytes, walked.skillCount]),
    stable: walked.stable,
    relevantBytes: walked.relevantBytes,
    skillCount: walked.skillCount,
  };
}

/** Fingerprint a resource root synchronously. */
export function fingerprintResourceTree(
  root: string,
  options?: ResourceFingerprintOptions,
): ResourceFingerprint {
  const resolvedRoot = resolve(root);
  const resolvedOptions = optionsWithDefaults(options);
  return formatFingerprint(resolvedOptions, walkResourceTree(resolvedRoot, resolvedOptions));
}

/** Promise-based equivalent of fingerprintResourceTree. */
export async function fingerprintResourceTreeAsync(
  root: string,
  options?: ResourceFingerprintOptions,
): Promise<ResourceFingerprint> {
  const resolvedRoot = resolve(root);
  const resolvedOptions = optionsWithDefaults(options);
  return formatFingerprint(
    resolvedOptions,
    await walkResourceTreeAsync(resolvedRoot, resolvedOptions),
  );
}
