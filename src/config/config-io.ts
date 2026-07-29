/**
 * config-io.ts — Config persistence (read/write).
 *
 * Atomic writes: write to .tmp then rename.
 * Loaded at session_start; saved on every /agents menu mutation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SubagentsConfig } from "../models/model-precedence.js";
import { parseThinkingLevel } from "../utils.js";

const CONFIG_DIR = getAgentDir();
const CONFIG_PATH = path.join(CONFIG_DIR, "subagents-lean.json");

/** Set after a corrupt primary config is read; prevents destroying its bytes on save. */
let primaryConfigCorrupt = false;
/** Path to the custom subagent system prompt. */
export const CUSTOM_PROMPT_PATH = path.join(CONFIG_DIR, "subagents-lean-prompt.md");
/** Default number of grace turns before an agent is force-stopped. */
export const DEFAULT_GRACE_TURNS = 6;

/** Valid system prompt modes. */
export const VALID_SYSTEM_PROMPT_MODES = new Set<string>(["replace", "inherit", "custom"]);

/** Default concurrency config — used for resets. */
export const DEFAULT_CONCURRENCY: SubagentsConfig["concurrency"] = { default: 4 };

/** Default agent settings — merged into loaded config so callers get a complete shape. */
const DEFAULT_AGENT: SubagentsConfig["agent"] = {
  default: null,
  forceBackground: false,
  graceTurns: DEFAULT_GRACE_TURNS,
  widgetMaxLines: 12,
  widgetDescLengthFull: 50,
  widgetDescLengthCompact: 30,
  widgetCompact: false,
  widgetShortcut: false,
  widgetShowModelThinking: true,
  widgetShowStartTime: true,
  systemPromptMode: "replace",
  includeContextFiles: true,
  disableDefaultAgents: false,
  orchestrationPrompt: true,
  showTools: true,
  showTurns: true,
  showInput: true,
  showOutput: true,
  showContext: true,
  showCost: false,
  showTime: true,
  outputThinkingBufferSize: 0,
  finishedRetentionMinutes: 10,
};

/**
 * Read config from disk. Merges loaded values over defaults so the result
 * is always a complete SubagentsConfig — no partial shapes for callers to handle.
 */
export function loadConfig(): SubagentsConfig {
  let raw: SubagentsConfig;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    if (!isConfigShape(parsed)) {
      primaryConfigCorrupt = true;
      raw = {} as SubagentsConfig;
    } else {
      primaryConfigCorrupt = false;
      raw = parsed;
    }
  } catch (err) {
    // A missing file is a healthy first-run state. Other read/parse failures
    // must not be silently normalized back over the primary config.
    primaryConfigCorrupt = (err as NodeJS.ErrnoException).code !== "ENOENT";
    raw = {} as SubagentsConfig;
  }

  // Legacy provider/model limits are intentionally discarded. Saving this
  // normalized config after any mutation removes them from disk.
  const concurrency: SubagentsConfig["concurrency"] = {
    default: raw.concurrency?.default ?? DEFAULT_CONCURRENCY.default,
  };
  const agent = { ...DEFAULT_AGENT, ...raw.agent };
  // v1.5 and earlier shipped `Explore`; retain its model selection for the
  // bundled scout that now covers discovery, unless scout was configured.
  // An own `scout` property, including null or an empty string, is explicit.
  if (!Object.hasOwn(raw.agent ?? {}, "scout") && typeof raw.agent?.Explore === "string") {
    agent.scout = raw.agent.Explore;
  }
  const defaultThinking = parseThinkingLevel(agent.defaultThinking);
  if (defaultThinking === undefined) delete agent.defaultThinking;
  else agent.defaultThinking = defaultThinking;
  return {
    agent,
    thinkingOverrides: { ...(raw.thinkingOverrides ?? {}) },
    concurrency,
  };
}

/** Write config to disk with atomic rename. Throws if the write cannot complete. */
export function saveConfigAtomic(config: SubagentsConfig): void {
  if (primaryConfigCorrupt) {
    throw new Error("Cannot save config: the primary config is corrupt and was left unchanged.");
  }

  // Keep the temp file in the target directory so rename remains atomic. Its
  // unique name prevents one save from cleaning up another's temp file; this
  // deliberately does not coordinate competing config updates.
  const tmpPath = `${CONFIG_PATH}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf-8");
    fs.renameSync(tmpPath, CONFIG_PATH);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // The temporary file may not exist when mkdir/write failed.
    }
    console.error(`[pi-subagents-lean] Failed to save config: ${err}`);
    throw err;
  }
}

/** Parsed config must be an object, and present nested sections must be objects. */
function isConfigShape(value: unknown): value is SubagentsConfig {
  if (!isRecord(value)) return false;
  return (value.agent === undefined || isRecord(value.agent))
    && (value.concurrency === undefined || isRecord(value.concurrency))
    && (value.thinkingOverrides === undefined || isRecord(value.thinkingOverrides));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
