import type { AgentMode } from "../models/model-precedence.js";

export const ECO_STATUS_KEY = "subagents-eco";

/** Keep the footer indicator theme/API conformant and absent in Default mode. */
export function syncEcoStatus(
  ui: { theme: { fg(color: string, text: string): string }; setStatus(key: string, text: string | undefined): void },
  mode: AgentMode,
): void {
  if (typeof ui.setStatus !== "function") return;
  const text = mode === "eco" && typeof ui.theme?.fg === "function"
    ? ui.theme.fg("success", "🍃 Eco")
    : undefined;
  ui.setStatus(ECO_STATUS_KEY, text);
}
