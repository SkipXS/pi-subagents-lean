/** Combined global and per-agent model/thinking settings. */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { getAgentConfig, getAllTypes } from "../../agents/agent-types.js";
import type { ThinkingLevel } from "../../types.js";
import { findModelInRegistry, parseModelKey } from "../../utils.js";
import { normalizeThinkingLevel, supportedThinkingLevels } from "../../models/thinking.js";
import type { SettingSource } from "../../models/model-precedence.js";
import type { Theme } from "../types.js";
import { CONFIG_AGENT_NON_MODEL_KEYS } from "../../config/types.js";
import { applyPersistedSetting, buildSettingsListTheme } from "./helpers.js";
import { createModelSelectSubmenu } from "./submenus/model-select.js";
import { createThinkingSelectSubmenu } from "./submenus/thinking-select.js";
import { createConfirmSubmenu } from "./submenus/confirm.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import { getStore } from "../../shell.js";

const SOURCE_LABELS: Record<SettingSource, string> = {
  spawn: "spawn",
  "session-agent": "session override",
  "config-agent": "saved override",
  "agent-md": "agent MD",
  "session-global": "session global",
  "config-global": "global default",
  parent: "parent",
};

function withSource(value: string | undefined, source: SettingSource): string {
  return `${value ?? "inherit"} (${SOURCE_LABELS[source]})`;
}

export async function showModelSettingsMenu(
  ctx: ExtensionCommandContext,
  modelOptions: string[],
): Promise<void> {
  type Store = ReturnType<typeof getStore>;

  const ecoModelFor = (store: Store, type: string, parent: string, cfg: ReturnType<typeof getAgentConfig>) =>
    typeof store.ecoModelSettingFor === "function"
      ? store.ecoModelSettingFor(type, parent, cfg)
      : { ...store.modelSettingFor(type, parent, cfg), ecoConfigured: false };
  const ecoThinkingFor = (store: Store, type: string, parent: ThinkingLevel | undefined, cfg: ReturnType<typeof getAgentConfig>) =>
    typeof store.ecoThinkingSettingFor === "function"
      ? store.ecoThinkingSettingFor(type, parent, cfg)
      : { ...store.thinkingSettingFor(type, parent, cfg), ecoConfigured: false };

  /** Resolve both Default and Eco fields so the overview and editor share one source of truth. */
  const resolveRoleSettings = (store: Store, typeName: string) => {
    const cfg = getAgentConfig(typeName);
    const model = store.modelSettingFor(typeName, "inherit", cfg);
    const thinking = store.thinkingSettingFor(typeName, undefined, cfg);

    // Some command contexts do not expose a lookup-capable registry (for
    // example during startup). In that case retain the full level list.
    const registry = ctx.modelRegistry as typeof ctx.modelRegistry & { find?: unknown };
    const effectiveModel = typeof registry.find === "function"
      ? findModelInRegistry(model.value, registry as Parameters<typeof findModelInRegistry>[1], ctx.model)
      : ctx.model;
    const effectiveThinking = normalizeThinkingLevel(effectiveModel, thinking.value);
    const incompatibleThinking = thinking.value !== undefined && effectiveThinking !== thinking.value;

    const configModel = store.agentConfigSnapshot()[typeName];
    const ecoModel = ecoModelFor(store, typeName, "inherit", cfg);
    const ecoKey = parseModelKey(ecoModel.value);
    const effectiveEcoModel = typeof registry.find === "function"
      ? ecoModel.ecoConfigured
        ? ecoKey ? registry.find(ecoKey.provider, ecoKey.modelId) : undefined
        : findModelInRegistry(ecoModel.value, registry as Parameters<typeof findModelInRegistry>[1], ctx.model)
      : ctx.model;
    const ecoThinking = ecoThinkingFor(store, typeName, undefined, cfg);
    const effectiveEcoThinking = normalizeThinkingLevel(effectiveEcoModel, ecoThinking.value);

    return {
      cfg,
      model,
      thinking,
      effectiveModel,
      effectiveThinking,
      incompatibleThinking,
      configModel,
      ecoModel,
      ecoThinking,
      effectiveEcoModel,
      effectiveEcoThinking,
    };
  };

  // The overview keeps the provider/model identity but omits source suffixes;
  // the editor retains those full source details in each field's currentValue.
  const compactModel = (value: string | undefined): string => value?.trim() || "inherit";

  const formatRoleSummary = (settings: ReturnType<typeof resolveRoleSettings>): string => {
    const defaultThinking = settings.effectiveThinking ?? "inherit";
    const ecoModel = settings.ecoModel.ecoConfigured ? compactModel(settings.ecoModel.value) : "Default";
    const ecoThinking = settings.ecoThinking.ecoConfigured
      ? settings.effectiveEcoThinking ?? "inherit"
      : "Default";
    return `Default: ${compactModel(settings.model.value)} / ${defaultThinking} · Eco: ${ecoModel} / ${ecoThinking}`;
  };

  const modelOverride = (store: Store, key: string, label: string) =>
    (mode: "session" | "permanent" | "clear", model: string | null): boolean | void => {
      if (mode === "clear") {
        if (!applyPersistedSetting(ctx, () => {
          if (key === "default") store.mutate.agent.setDefaultModel(null);
          else store.mutate.agent.clearModelOverride(key);
        }, `${label} model updated`)) return false;
        store.mutate.session.clearOverride(key);
        return true;
      } else {
        const value = model === "(inherits parent)" ? null : model;
        if (mode === "session") {
          if (value === null) store.mutate.session.clearOverride(key);
          else store.mutate.session.setOverride(key, value);
          ctx.ui.notify(`${label} model updated`, "info");
          return true;
        } else {
          return applyPersistedSetting(ctx, () => {
            if (key === "default") store.mutate.agent.setDefaultModel(value);
            else if (value === null) store.mutate.agent.clearModelOverride(key);
            else store.mutate.agent.setModelOverride(key, value);
          }, `${label} model updated`);
        }
      }
    };

  const ecoModelOverride = (store: Store, key: string, label: string) =>
    (mode: "session" | "permanent" | "clear", model: string | null): boolean | void => {
      const value = model === "(inherits parent)" ? null : model;
      if (mode === "session") {
        if (value === null) store.mutate.session.clearEcoModelOverride(key);
        else store.mutate.session.setEcoModelOverride(key, value);
        ctx.ui.notify(`${label} Eco model updated`, "info");
        return true;
      }
      if (mode === "permanent") {
        return applyPersistedSetting(ctx, () => {
          if (value === null) store.mutate.agent.clearEcoModelOverride(key);
          else store.mutate.agent.setEcoModelOverride(key, value);
        }, `${label} Eco model updated`);
      }
      return false;
    };

  const thinkingOverride = (store: Store, key: string, label: string) =>
    (mode: "session" | "permanent" | "clear", level: ThinkingLevel | undefined): boolean | void => {
      if (mode === "clear") {
        if (!applyPersistedSetting(ctx, () => {
          if (key === "default") store.mutate.agent.setDefaultThinking(undefined);
          else store.mutate.agent.clearThinkingOverride(key);
        }, `${label} thinking updated`)) return false;
        store.mutate.session.clearThinkingOverride(key);
        return true;
      } else if (mode === "session") {
        if (level === undefined) store.mutate.session.clearThinkingOverride(key);
        else store.mutate.session.setThinkingOverride(key, level);
        ctx.ui.notify(`${label} thinking updated`, "info");
        return true;
      } else {
        return applyPersistedSetting(ctx, () => {
          if (key === "default") store.mutate.agent.setDefaultThinking(level);
          else if (level === undefined) store.mutate.agent.clearThinkingOverride(key);
          else store.mutate.agent.setThinkingOverride(key, level);
        }, `${label} thinking updated`);
      }
    };

  const ecoThinkingOverride = (store: Store, key: string, label: string) =>
    (mode: "session" | "permanent" | "clear", level: ThinkingLevel | undefined): boolean | void => {
      if (mode === "session") {
        if (level === undefined) store.mutate.session.clearEcoThinkingOverride(key);
        else store.mutate.session.setEcoThinkingOverride(key, level);
        ctx.ui.notify(`${label} Eco thinking updated`, "info");
        return true;
      }
      if (mode === "permanent") {
        return applyPersistedSetting(ctx, () => {
          if (level === undefined) store.mutate.agent.clearEcoThinkingOverride(key);
          else store.mutate.agent.setEcoThinkingOverride(key, level);
        }, `${label} Eco thinking updated`);
      }
      return false;
    };

  /** Build the four field rows shown after entering one role. */
  const buildRoleItems = (store: Store, theme: Theme, typeName: string): SettingItem[] => {
    const settings = resolveRoleSettings(store, typeName);
    const { model, thinking, effectiveModel, effectiveThinking, incompatibleThinking, configModel, ecoModel, ecoThinking, effectiveEcoModel, effectiveEcoThinking } = settings;

    return [
      {
        id: `model:${typeName}`,
        label: "Standard Model",
        currentValue: withSource(model.value, model.source),
        description: `Model setting for ${typeName}. Agent-specific overrides take priority over its MD.`,
        submenu: createModelSelectSubmenu({
          modelOptions,
          showClear: store.sessionModelOverride(typeName) !== null || typeof configModel === "string",
          theme,
          onSelect: modelOverride(store, typeName, typeName),
        }),
      },
      {
        id: `thinking:${typeName}`,
        label: "Standard Thinking",
        currentValue: withSource(effectiveThinking, thinking.source),
        description: incompatibleThinking
          ? `Using ${effectiveThinking}; requested ${thinking.value} from ${SOURCE_LABELS[thinking.source]} is unsupported by the effective model.`
          : `Thinking setting for ${typeName}. Agent-specific overrides take priority over its MD.`,
        submenu: createThinkingSelectSubmenu({
          showClear: store.sessionThinkingOverride(typeName) !== undefined
            || store.persistedThinkingOverride(typeName) !== undefined,
          levels: supportedThinkingLevels(effectiveModel),
          theme,
          onSelect: thinkingOverride(store, typeName, typeName),
        }),
      },
      {
        id: `eco-model:${typeName}`,
        label: "Eco Model",
        currentValue: withSource(ecoModel.value, ecoModel.source),
        description: ecoModel.ecoConfigured
          ? `Eco model for ${typeName}.`
          : `No Eco model configured; using the fully resolved Default model.`,
        submenu: createModelSelectSubmenu({
          modelOptions,
          // Scope-aware inheritance replaces the ambiguous cross-scope Clear action.
          showClear: false,
          inheritLabel: "Inherit Default",
          theme,
          onSelect: ecoModelOverride(store, typeName, typeName),
        }),
      },
      {
        id: `eco-thinking:${typeName}`,
        label: "Eco Thinking",
        currentValue: withSource(effectiveEcoThinking, ecoThinking.source),
        description: ecoThinking.ecoConfigured
          ? `Eco thinking for ${typeName}; normalized against its effective Eco model.`
          : `No Eco thinking configured; using the fully resolved Default thinking.`,
        submenu: createThinkingSelectSubmenu({
          // Scope-aware inheritance replaces the ambiguous cross-scope Clear action.
          showClear: false,
          inheritLabel: "Inherit Default",
          levels: supportedThinkingLevels(effectiveEcoModel),
          theme,
          onSelect: ecoThinkingOverride(store, typeName, typeName),
        }),
      },
    ];
  };

  let overviewList: SettingsList | undefined;
  let rebuildOverview: ((items: SettingItem[]) => void) | undefined;

  /** Update a role's compact row without closing the editor currently in use. */
  const refreshRoleSummary = (typeName: string): void => {
    overviewList?.updateValue(
      `role:${typeName}`,
      formatRoleSummary(resolveRoleSettings(getStore(), typeName)),
    );
  };

  /** Build a role editor as a SettingsList submenu of the compact overview. */
  const createRoleEditor = (typeName: string, theme: Theme) =>
    (_currentValue: string, done: (selectedValue?: string) => void) => {
      let rebuildRole: ((items: SettingItem[]) => void) | undefined;
      const currentItems = () => buildRoleItems(getStore(), theme, typeName);
      const leaveEditor = (): void => {
        refreshRoleSummary(typeName);
        // Rebuild the overview on exit so newly-created session actions and
        // reset predicates reflect edits made inside this role editor.
        rebuildOverview?.(buildItems(getStore(), theme));
        done();
      };

      const roleList = new SettingsList(
        currentItems(),
        8,
        buildSettingsListTheme(theme),
        () => {
          rebuildRole?.(currentItems());
          refreshRoleSummary(typeName);
        },
        leaveEditor,
      );

      return new SettingsListWrapper(roleList, {
        title: `${typeName} Settings`,
        theme,
        onRebuild: (callback) => { rebuildRole = callback; },
      });
    };

  function buildItems(store: Store, theme: Theme): SettingItem[] {
    const items: SettingItem[] = [];
    const sessionEcoModel = (type: string) => store.sessionEcoModelOverride?.(type);
    const sessionEcoThinking = (type: string) => store.sessionEcoThinkingOverride?.(type);

    items.push({
      id: "disableDefaultAgents",
      label: "Disable default agents",
      currentValue: store.agent.disableDefaultAgents ? "ON" : "OFF",
      values: ["ON", "OFF"],
      description: "Exclude bundled agent types from discovery; takes effect on the next parent turn.",
    });

    const globalModel = store.sessionDefaultModel ?? store.agent.defaultModel;
    const globalModelSource: SettingSource = store.sessionDefaultModel
      ? "session-global"
      : store.agent.defaultModel
        ? "config-global"
        : "parent";
    items.push({
      id: "defaultModel",
      label: "Global default model",
      currentValue: withSource(globalModel ?? "inherit", globalModelSource),
      description: "Fallback model used only when an agent MD does not specify one.",
      submenu: createModelSelectSubmenu({
        modelOptions,
        showClear: globalModelSource !== "parent",
        theme,
        onSelect: modelOverride(store, "default", "Global default"),
      }),
    });

    const globalThinking = store.sessionDefaultThinking ?? store.agent.defaultThinking;
    const globalThinkingSource: SettingSource = store.sessionDefaultThinking
      ? "session-global"
      : store.agent.defaultThinking
        ? "config-global"
        : "parent";
    items.push({
      id: "defaultThinking",
      label: "Global default thinking",
      currentValue: withSource(globalThinking, globalThinkingSource),
      description: "Fallback thinking used only when an agent MD does not specify one.",
      submenu: createThinkingSelectSubmenu({
        showClear: globalThinkingSource !== "parent",
        theme,
        onSelect: thinkingOverride(store, "default", "Global default"),
      }),
    });

    items.push({ id: "__types__", label: "── Per-agent settings ──", currentValue: "────────" });
    for (const typeName of getAllTypes()) {
      const roleSettings = resolveRoleSettings(store, typeName);
      items.push({
        id: `role:${typeName}`,
        label: typeName,
        currentValue: formatRoleSummary(roleSettings),
        description: `Edit Standard and Eco model/thinking settings for ${typeName}.`,
        submenu: createRoleEditor(typeName, theme),
      });
    }

    const hasSession = store.sessionDefaultModel !== null
      || store.sessionDefaultThinking !== undefined
      || getAllTypes().some((type) => store.sessionModelOverride(type) !== null
        || store.sessionThinkingOverride(type) !== undefined
        || sessionEcoModel(type) !== undefined
        || sessionEcoThinking(type) !== undefined);
    if (hasSession) {
      items.push({
        id: "clearSession",
        label: "Clear session overrides",
        currentValue: "",
        description: "Discard session-only Default and Eco model/thinking overrides.",
        submenu: createConfirmSubmenu({
          message: "Clear all session overrides?",
          theme,
          onConfirm: () => {
            store.mutate.session.clearAll();
            ctx.ui.notify("Session overrides cleared", "info");
          },
        }),
      });
    }

    items.push({
      id: "clearAll",
      label: "Reset all agent settings",
      currentValue: "",
      description: "Clear saved and session model/thinking overrides, including global defaults.",
      submenu: createConfirmSubmenu({
        message: "Reset all model and thinking settings?",
        theme,
        onConfirm: () => {
          const agentConfig = store.agentConfigSnapshot();
          const hasModelOverrides = Object.entries(agentConfig).some(
            ([key, value]) => !CONFIG_AGENT_NON_MODEL_KEYS.includes(key) && value != null,
          );
          const hasAnything = hasSession || hasModelOverrides || (store.hasPersistedEcoOverrides?.() ?? false) || store.agent.defaultModel !== null
            || store.agent.defaultThinking !== undefined
            || store.hasPersistedThinkingOverrides();
          if (!hasAnything) {
            ctx.ui.notify("No overrides to clear", "info");
            return;
          }
          if (applyPersistedSetting(
            ctx,
            () => store.mutate.agent.resetAllModelAndThinkingOverrides(),
            "All agent settings reset",
          )) {
            store.mutate.session.clearAll();
          }
        },
      }),
    });

    return items;
  }

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const items = buildItems(getStore(), theme);
    let settingsList: SettingsList;
    settingsList = new SettingsList(
      items,
      18,
      buildSettingsListTheme(theme),
      (id, value) => {
        if (id === "disableDefaultAgents") {
          const store = getStore();
          const previous = store.agent.disableDefaultAgents ? "ON" : "OFF";
          applyPersistedSetting(
            ctx,
            () => store.mutate.agent.setDisableDefaultAgents(value === "ON"),
            `Disable default agents set to ${value} (takes effect on next parent turn)`,
            () => settingsList.updateValue(id, previous),
          );
          return;
        }
        rebuildOverview?.(buildItems(getStore(), theme));
      },
      () => done(undefined),
    );
    overviewList = settingsList;
    return new SettingsListWrapper(settingsList, {
      title: "Agent Settings",
      theme,
      onCancel: () => done(undefined),
      onRebuild: (callback) => { rebuildOverview = callback; },
    });
  });
}
