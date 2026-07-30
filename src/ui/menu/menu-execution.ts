/** Execution defaults shown at the top level of /agents settings. */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { applyPersistedSetting, buildSettingsListTheme } from "./helpers.js";
import { createNumericSubmenu } from "./submenus/numeric-input.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";
import { DEFAULT_GRACE_TURNS } from "../../config/config-io.js";
import { getStore } from "../../shell.js";

function createConcurrencySetting(ctx: ExtensionCommandContext): SettingItem {
  const store = getStore();
  return {
    id: "defaultConcurrency",
    label: "Concurrency limit",
    currentValue: String(store.concurrency.default),
    description: "Maximum number of agents that run at once; additional agents queue automatically.",
    submenu: createNumericSubmenu(ctx, (parsed) =>
      applyPersistedSetting(ctx, () => store.mutate.concurrency.setDefault(parsed), `Concurrency limit set to ${parsed}`),
    ),
  };
}

export async function showExecutionMenu(ctx: ExtensionCommandContext): Promise<void> {
  const store = getStore();
  const items: SettingItem[] = [
    {
      id: "maxNestingDepth",
      label: "Max nesting depth",
      currentValue: String(store.agent.maxNestingDepth),
      submenu: createNumericSubmenu(ctx, { min: 1, max: 2, required: true }, (parsed) =>
        applyPersistedSetting(ctx, () => store.mutate.agent.setMaxNestingDepth(parsed), `Max nesting depth set to ${parsed}`),
      ),
      description: "1 permits root children only; 2 permits one child layer.",
    },
    createConcurrencySetting(ctx),
    {
      id: "defaultMaxTurns",
      label: "Default max turns",
      currentValue: String(store.agent.defaultMaxTurns ?? "(not set)"),
      submenu: createNumericSubmenu(ctx, { min: 1 }, (parsed) =>
        applyPersistedSetting(ctx, () => store.mutate.agent.setDefaultMaxTurns(parsed), `Default max turns set to ${parsed}`),
      () => applyPersistedSetting(ctx, () => store.mutate.agent.setDefaultMaxTurns(undefined), "Default max turns cleared")),
      description: "Soft turn limit. Blank leaves it unlimited.",
    },
    {
      id: "graceTurns",
      label: "Grace turns",
      currentValue: String(store.agent.graceTurns),
      submenu: createNumericSubmenu(ctx, { min: 0, default: DEFAULT_GRACE_TURNS }, (parsed) =>
        applyPersistedSetting(ctx, () => store.mutate.agent.setGraceTurns(parsed), `Grace turns set to ${parsed}`),
      ),
      description: "Extra turns after the soft turn limit before a hard abort.",
    },
    {
      id: "forceBackground",
      label: "Force background",
      currentValue: store.agent.forceBackground ? "ON" : "OFF",
      values: ["ON", "OFF"],
      description: "Spawn every agent in the background by default.",
    },
  ];

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    let list: SettingsList;
    list = new SettingsList(items, 10, buildSettingsListTheme(theme), (id, value) => {
      if (id === "forceBackground") {
        const previous = store.agent.forceBackground ? "ON" : "OFF";
        applyPersistedSetting(
          ctx,
          () => store.mutate.agent.setForceBackground(value === "ON"),
          `Force background set to ${value}`,
          () => list.updateValue(id, previous),
        );
      }
    }, () => done(undefined));
    return new SettingsListWrapper(list, { title: "Execution", theme, onCancel: () => done(undefined) });
  });
}
