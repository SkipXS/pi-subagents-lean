/**
 * menu-system-prompt.ts — System prompt settings menu concern.
 *
 * Uses SettingsList from @earendil-works/pi-tui via ctx.ui.custom.
 * SettingsList maintains internal cursor state, fixing the cursor-position
 * reset bug that occurred with ctx.ui.select.
 *
 * Exports:
 *   - showSystemPromptMenu: mode, custom prompt, parent orchestration, AGENTS.md
 */

import fs from "node:fs";
import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { applyPersistedSetting, buildSettingsListTheme } from "./helpers.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import type { SystemPromptMode } from "../../agents/types.js";
import { getStore } from "../../shell.js";
import { CUSTOM_PROMPT_PATH } from "../../config/config-io.js";

export async function showSystemPromptMenu(ctx: ExtensionCommandContext): Promise<void> {
  const store = getStore();

  const buildItems = (): SettingItem[] => {
    const items: SettingItem[] = [
      {
        id: "systemPromptMode",
        label: "System prompt mode",
        currentValue: store.agent.systemPromptMode,
        values: ["replace", "inherit", "custom"],
        description: "How the subagent system prompt is built: replace, inherit, or custom.",
      },
    ];

    // Create prompt file (only when mode is custom and file doesn't exist)
    if (store.agent.systemPromptMode === "custom" && !fs.existsSync(CUSTOM_PROMPT_PATH)) {
      items.push({
        id: "createPromptFile",
        label: "Create prompt file",
        currentValue: CUSTOM_PROMPT_PATH,
        values: ["Create"],
        description: `Create ${CUSTOM_PROMPT_PATH} with a starter template for custom mode.`,
      });
    }

    items.push(
      {
        id: "includeContextFiles",
        label: "Include AGENTS.md",
        currentValue: store.agent.includeContextFiles ? "ON" : "OFF",
        values: ["ON", "OFF"],
        description: "Load project and ~/.pi/agent AGENTS.md as shared <project_context>.",
      },
      {
        id: "orchestrationPrompt",
        label: "Parent orchestration prompt",
        currentValue: store.agent.orchestrationPrompt ? "ON" : "OFF",
        values: ["ON", "OFF"],
        description: "Append compact dynamic agent guidance to parent turns.",
      },
      {
        id: "loadSkillsImplicitly",
        label: "Load skills implicitly",
        currentValue: store.agent.loadSkillsImplicitly ? "ON" : "OFF",
        values: ["ON", "OFF"],
        description: "Give new agents all skills when frontmatter omits the field.",
      },
      {
        id: "loadExtensionsImplicitly",
        label: "Load extensions implicitly",
        currentValue: store.agent.loadExtensionsImplicitly ? "ON" : "OFF",
        values: ["ON", "OFF"],
        description: "Give new agents all extensions when frontmatter omits the field.",
      },
    );

    return items;
  };
  let items = buildItems();
  let rebuild: ((newItems: SettingItem[]) => void) | null = null;

  let settingsList: SettingsList;
  const restoreValue = (id: string, value: string) => () => settingsList.updateValue(id, value);
  const onChange = (id: string, newValue: string) => {
    switch (id) {
      case "systemPromptMode":
        if (applyPersistedSetting(ctx, () => store.mutate.agent.setSystemPromptMode(newValue as SystemPromptMode), `System prompt mode set to ${newValue}`,
          restoreValue(id, store.agent.systemPromptMode))) {
          // Rebuild: "custom" adds the create prompt file item, other modes remove it.
          items = buildItems();
          rebuild?.(items);
        }
        break;
      case "createPromptFile":
        try {
          fs.mkdirSync(path.dirname(CUSTOM_PROMPT_PATH), { recursive: true });
          fs.writeFileSync(CUSTOM_PROMPT_PATH, "You are a Pi, an expert coding sub-agent.\nYou have been invoked to handle a specific task autonomously", "utf-8");
          ctx.ui.notify(`Created prompt file: ${CUSTOM_PROMPT_PATH}`, "info");
        } catch (err: any) {
          ctx.ui.notify(`Failed to create prompt file: ${err.message}`, "error");
        }
        return;
      case "includeContextFiles":
        applyPersistedSetting(ctx, () => store.mutate.agent.setIncludeContextFiles(newValue === "ON"), `Include AGENTS.md set to ${newValue}`,
          restoreValue(id, store.agent.includeContextFiles ? "ON" : "OFF"));
        break;
      case "orchestrationPrompt":
        applyPersistedSetting(ctx, () => store.mutate.agent.setOrchestrationPrompt(newValue === "ON"), `Parent orchestration prompt set to ${newValue}`,
          restoreValue(id, store.agent.orchestrationPrompt ? "ON" : "OFF"));
        break;
      case "loadSkillsImplicitly":
        applyPersistedSetting(ctx, () => store.mutate.agent.setLoadSkillsImplicitly(newValue === "ON"), `Load skills implicitly set to ${newValue}`,
          restoreValue(id, store.agent.loadSkillsImplicitly ? "ON" : "OFF"));
        break;
      case "loadExtensionsImplicitly":
        applyPersistedSetting(ctx, () => store.mutate.agent.setLoadExtensionsImplicitly(newValue === "ON"), `Load extensions implicitly set to ${newValue}`,
          restoreValue(id, store.agent.loadExtensionsImplicitly ? "ON" : "OFF"));
        break;
    }
  };

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    settingsList = new SettingsList(items, 10, buildSettingsListTheme(theme), onChange, () => done(undefined));
    return new SettingsListWrapper(settingsList, { title: "System Prompt", theme, onCancel: () => done(undefined), onRebuild: (r) => { rebuild = r; } });
  });
}
