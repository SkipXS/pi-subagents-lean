/**
 * menus.ts — /agents command dispatcher.
 *
 * Uses SelectList from @earendil-works/pi-tui via ctx.ui.custom.
 * Each iteration creates a fresh SelectList; submenu closes it before opening.
 * No nested ctx.ui.custom calls.
 *
 * Module structure:
 *   - helpers.ts: shared helpers (buildSettingsListTheme, buildSelectListTheme, validateNumeric)
 *   - menu-model-settings.ts: showModelSettingsMenu
 *   - menu-execution.ts: showExecutionMenu
 *   - menu-widget-settings.ts: showWidgetSettingsMenu
 *   - menu-running-agents.ts: showRunningAgentsMenu
 *   - menu-agent-catalog.ts: showAgentCatalog
 *   - menu-system-prompt.ts: showSystemPromptMenu
 *   - menus.ts (this file): dispatcher — main menu and settings menu
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SelectList, type SelectItem } from "@earendil-works/pi-tui";
import { applyPersistedSetting, buildSelectListTheme } from "./helpers.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import { showModelSettingsMenu } from "./menu-model-settings.js";
import { showExecutionMenu } from "./menu-execution.js";
import { showWidgetSettingsMenu } from "./menu-widget-settings.js";
import { showRunningAgentsMenu } from "./menu-running-agents.js";
import { showAgentCatalog } from "./menu-agent-catalog.js";
import { showSystemPromptMenu } from "./menu-system-prompt.js";
import { showConfigRecoveryMenu } from "./menu-config-recovery.js";
import { getStore } from "../../shell.js";
import { syncEcoStatus } from "../eco-status.js";

// Spawn wizard — co-located in this folder.
import { showSpawnAgentMenu } from "./menu-spawn-wizard.js";
export { showSpawnAgentMenu };


/**
 * Render `items` as a titled SelectList and dispatch the chosen value.
 * Re-loops after each dispatch until the user cancels (Esc or Back).
 * Each iteration builds a fresh list so state never leaks between visits.
 */
async function runSelectMenu(
  ctx: ExtensionCommandContext,
  title: string,
  items: SelectItem[] | (() => SelectItem[]),
  dispatch: (choice: string) => Promise<boolean | void>,
): Promise<void> {
  while (true) {
    const choice = await ctx.ui.custom<string | undefined>((_tui, theme, _kb, done) => {
      const currentItems = typeof items === "function" ? items() : items;
      const list = new SelectList([...currentItems], 10, buildSelectListTheme(theme));
      list.onSelect = (item) => done(item.value);
      return new SettingsListWrapper(list, { title, theme, onCancel: () => done(undefined) });
    });
    if (choice === undefined) return;
    if (await dispatch(choice)) return;
  }
}

export async function showSettingsMenu(
  ctx: ExtensionCommandContext,
  modelOptions: string[],
): Promise<void> {
  const items = (): SelectItem[] => {
    if (getStore().health !== "healthy") {
      return [{ value: "recovery", label: "Config recovery required", description: "Persistent settings are disabled until the config is recovered safely" }];
    }
    return [
      { value: "models", label: "Agent settings", description: "Agent availability and global/per-agent model and thinking overrides" },
      { value: "execution", label: "Execution", description: "Global concurrency, background mode, and turn limits" },
      { value: "widget", label: "Widget", description: "Appearance, sizing, behavior, and usage stats" },
      { value: "systemprompt", label: "System prompt, context, skills & extensions", description: "Prompt mode and implicit loading defaults" },
    ];
  };

  await runSelectMenu(ctx, "Settings", items, async (choice) => {
    switch (choice) {
      case "models": await showModelSettingsMenu(ctx, modelOptions); break;
      case "execution": await showExecutionMenu(ctx); break;
      case "widget": await showWidgetSettingsMenu(ctx); break;
      case "systemprompt": await showSystemPromptMenu(ctx); break;
      case "recovery": await showConfigRecoveryMenu(ctx); break;
    }
  });
}

async function showModeMenu(ctx: ExtensionCommandContext): Promise<void> {
  const store = getStore();
  await runSelectMenu(ctx, "Agent Mode", () => [
    { value: "session:default", label: "Default · this session", description: "Use Default mode until this session ends" },
    { value: "session:eco", label: "🍃 Eco · this session", description: "Use Eco settings until this session ends" },
    { value: "permanent:default", label: "Default · permanent", description: "Apply now and make Default the mode for new sessions" },
    { value: "permanent:eco", label: "🍃 Eco · permanent", description: "Apply now and make Eco the mode for new sessions" },
    { value: "clear", label: "Clear saved/session mode", description: "Return to the implicit Default mode" },
  ], async (choice) => {
    const [scope, value] = choice.split(":") as [string, "default" | "eco" | undefined];
    if (scope === "session" && value) {
      store.mutate.session.setMode(value);
      syncEcoStatus(ctx.ui, store.mode);
      ctx.ui.notify(`Agent mode set to ${value === "eco" ? "Eco" : "Default"} for this session`, "info");
      return true;
    }
    if (scope === "permanent" && value) {
      const saved = applyPersistedSetting(ctx, () => store.mutate.agent.setMode(value), `Agent mode set to ${value === "eco" ? "Eco" : "Default"}`);
      if (saved) syncEcoStatus(ctx.ui, store.mode);
      return saved;
    }
    if (choice === "clear") {
      const saved = applyPersistedSetting(ctx, () => store.mutate.agent.setMode(undefined), "Agent mode reset to Default");
      if (saved) {
        store.mutate.session.setMode(undefined);
        syncEcoStatus(ctx.ui, store.mode);
      }
      return saved;
    }
  });
}

export async function showAgentsMainMenu(
  ctx: ExtensionCommandContext,
  modelOptions: string[],
): Promise<void> {
  const items = (): SelectItem[] => {
    const store = getStore();
    const eco = store.mode === "eco";
    return [
      { value: "mode", label: `Mode: ${eco ? "🍃 Eco" : "Default"}`, description: `Active source: ${store.modeSource}` },
      { value: "running", label: "Running agents", description: "List running, queued, and completed agents" },
      { value: "spawn", label: "Spawn agent", description: "Manually spawn a new agent" },
      { value: "catalog", label: "Agent catalog", description: "Inspect discovered agent definitions and their configuration" },
      { value: "settings", label: "Settings", description: "Agent, execution, widget, and prompt settings" },
    ];
  };

  await runSelectMenu(ctx, "Agents", items, async (choice) => {
    switch (choice) {
      case "mode": await showModeMenu(ctx); break;
      case "running": await showRunningAgentsMenu(ctx); break;
      case "spawn": await showSpawnAgentMenu(ctx, modelOptions); break;
      case "catalog": await showAgentCatalog(ctx); break;
      case "settings": await showSettingsMenu(ctx, modelOptions); break;
    }
  });
}
