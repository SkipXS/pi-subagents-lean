/** Config recovery status and the deliberately narrow .bak repair action. */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SelectList, type SelectItem } from "@earendil-works/pi-tui";
import { getStore } from "../../shell.js";
import { buildSelectListTheme } from "./helpers.js";
import { SettingsListWrapper } from "./wrappers/settings-list.js";

/** Returns true when repair succeeded. */
export async function showConfigRecoveryMenu(ctx: ExtensionCommandContext): Promise<boolean> {
  const store = getStore();
  const status = store.health === "using-backup"
    ? "The primary config is unavailable; this session uses subagents-lean.json.bak."
    : "The config could not be read safely. Persistent settings are disabled to preserve its bytes.";

  if (store.health !== "using-backup" || !store.canRepair) {
    ctx.ui.notify(status, "error");
    return false;
  }

  const choice = await ctx.ui.custom<string | undefined>((_tui, theme, _kb, done) => {
    const items: SelectItem[] = [
      { value: "repair", label: "Repair primary from backup", description: `${status} Archives the corrupt primary before restoring the backup.` },
      { value: "cancel", label: "Cancel", description: "Leave both config files unchanged." },
    ];
    const list = new SelectList(items, 5, buildSelectListTheme(theme));
    list.onSelect = (item) => done(item.value);
    return new SettingsListWrapper(list, { title: "Config Recovery", theme, onCancel: () => done(undefined) });
  });
  if (choice !== "repair") return false;

  const confirmed = await ctx.ui.custom<string | undefined>((_tui, theme, _kb, done) => {
    const list = new SelectList([
      { value: "yes", label: "Yes, repair", description: "Archive the corrupt primary and restore the validated backup." },
      { value: "no", label: "No", description: "Leave both files unchanged." },
    ], 5, buildSelectListTheme(theme));
    list.onSelect = (item) => done(item.value);
    return new SettingsListWrapper(list, { title: "Confirm Config Repair", theme, onCancel: () => done(undefined) });
  });
  if (confirmed !== "yes") return false;

  try {
    store.repair();
    ctx.ui.notify("Primary config repaired from backup.", "info");
    return true;
  } catch (err) {
    ctx.ui.notify(`Config repair failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    return false;
  }
}
