import { describe, expect, it } from "vitest";
import {
  CONFIG_AGENT_KEYS,
  DEFAULT_CONCURRENCY_DEFAULT,
  MAX_AGENT_SETTINGS_OVERRIDE_ENTRIES,
  MAX_SUBAGENTS_CONFIG_BYTES,
  normalizeAgentEntries,
  normalizeAgentSettingsOverrides,
  normalizeConcurrencyDefault,
} from "../../src/config/types.ts";
import { MAX_AGENT_MODEL_BYTES, MAX_AGENT_NAME_BYTES } from "../../src/agents/agent-string-limits.ts";

describe("concurrency normalization", () => {
  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "4",
    {},
    1.5,
    0,
    -2,
    65,
    Number.MAX_SAFE_INTEGER,
    1e100,
    null,
  ] as unknown[]) ("uses the default for invalid value %p", (value) => {
    expect(normalizeConcurrencyDefault(value)).toBe(DEFAULT_CONCURRENCY_DEFAULT);
  });

  it.each([1, 2, 4, 17, 64]) ("keeps the valid positive integer %d", (value) => {
    expect(normalizeConcurrencyDefault(value)).toBe(value);
  });
});

describe("agent config entry normalization", () => {
  it("accepts only the current boolean agent settings", () => {
    const input = {
      disableDefaultAgents: true,
      default: "provider/default",
      reviewer: "provider/model",
      ignoredString: "provider/model",
      ignoredObject: { reviewer: "high" },
      ignoredBoolean: false,
      unknown: true,
    };

    expect(normalizeAgentEntries(input)).toEqual({
      disableDefaultAgents: true,
    });
    expect(CONFIG_AGENT_KEYS).toEqual(["disableDefaultAgents"]);
  });
});

describe("per-agent model/thinking override normalization", () => {
  it("normalizes names case-insensitively and lets the last case variant win", () => {
    expect(normalizeAgentSettingsOverrides({
      Scout: { model: "provider/first", thinking: "high", ignored: true },
      scout: { thinking: "low", ignored: "still ignored" },
      Reviewer: { model: "provider/reviewer", thinking: "invalid", extra: "ignored" },
      invalid: { model: 42, thinking: "ultra" },
      notAnObject: "provider/model",
    })).toEqual({
      scout: { thinking: "low" },
      reviewer: { model: "provider/reviewer" },
    });
  });

  it("bounds entries and identifier/model strings by UTF-8 bytes", () => {
    const exactName = "é".repeat(MAX_AGENT_NAME_BYTES / 2);
    const exactModel = "界".repeat(Math.floor(MAX_AGENT_MODEL_BYTES / 3));
    expect(normalizeAgentSettingsOverrides({
      [exactName]: { model: `${exactModel}a` },
      [`${exactName}é`]: { model: "provider/over-name" },
      valid: { model: `${exactModel}a` },
      tooLongModel: { model: "m".repeat(MAX_AGENT_MODEL_BYTES + 1) },
    })).toEqual({
      [exactName]: { model: `${exactModel}a` },
      valid: { model: `${exactModel}a` },
    });

    const many = Object.fromEntries(Array.from(
      { length: MAX_AGENT_SETTINGS_OVERRIDE_ENTRIES + 20 },
      (_, index) => [`agent-${index}`, { model: `provider/model-${index}` }],
    ));
    const bounded = normalizeAgentSettingsOverrides(many);
    expect(Object.keys(bounded)).toHaveLength(MAX_AGENT_SETTINGS_OVERRIDE_ENTRIES);
    expect(bounded[`agent-${MAX_AGENT_SETTINGS_OVERRIDE_ENTRIES}`]).toBeUndefined();
    expect(MAX_SUBAGENTS_CONFIG_BYTES).toBe(1024 * 1024);
  });
});
