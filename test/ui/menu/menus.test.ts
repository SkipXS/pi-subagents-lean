/**
 * menus.test.ts — Tests for the dispatcher (showAgentsMainMenu, showSettingsMenu).
 *
 * After migration: uses SelectList via ctx.ui.custom (not ctx.ui.select).
 * Each iteration creates a fresh SelectList; submenu closes it before opening.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockModules } from "../../menu-mock-setup.js";
import { createMockCtx } from "../../menu-test-helpers.js";
import { getAgentConfig } from "../../../src/agents/agent-types.js";

vi.mock("../../../src/ui/menu/menu-model-settings.js", () => ({ showModelSettingsMenu: vi.fn() }));
vi.mock("../../../src/ui/menu/menu-execution.js", () => ({ showExecutionMenu: vi.fn() }));
vi.mock("../../../src/ui/menu/menu-widget-settings.js", () => ({ showWidgetSettingsMenu: vi.fn() }));
vi.mock("../../../src/ui/menu/menu-running-agents.js", () => ({ showRunningAgentsMenu: vi.fn() }));
vi.mock("../../../src/ui/menu/menu-agent-catalog.js", () => ({ showAgentCatalog: vi.fn() }));
vi.mock("../../../src/ui/menu/menu-system-prompt.js", () => ({ showSystemPromptMenu: vi.fn() }));
vi.mock("../../../src/ui/menu/menu-spawn-wizard.js", () => ({ showSpawnAgentMenu: vi.fn() }));

import { showRunningAgentsMenu } from "../../../src/ui/menu/menu-running-agents.js";
import { showSpawnAgentMenu } from "../../../src/ui/menu/menu-spawn-wizard.js";
import { showAgentCatalog } from "../../../src/ui/menu/menu-agent-catalog.js";
import { showModelSettingsMenu } from "../../../src/ui/menu/menu-model-settings.js";
import { showExecutionMenu } from "../../../src/ui/menu/menu-execution.js";
import { showWidgetSettingsMenu } from "../../../src/ui/menu/menu-widget-settings.js";
import { showSystemPromptMenu } from "../../../src/ui/menu/menu-system-prompt.js";
import { showAgentsMainMenu, showSettingsMenu } from "../../../src/ui/menu/menus.js";

function resetAgentState(): void {
  mockModules.mockConfig.agent = { default: null, forceBackground: false };
  mockModules.mockSessionOverrides.default = null;
  mockModules.mockSessionShowCost = undefined;
}

describe("showAgentsMainMenu — SelectList dispatcher", () => {
  beforeEach(() => {
    resetAgentState();
    vi.clearAllMocks();
  });

  it("uses ctx.ui.custom (not ctx.ui.select)", async () => {
    const ctx = createMockCtx();
    await showAgentsMainMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.custom).toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("shows the agent catalog as the third main-menu item", async () => {
    const ctx = createMockCtx();
    let component: any;
    ctx.ui.custom.mockImplementationOnce(async (factory: any) => {
      component = factory(
        { terminal: { rows: 40 } },
        { fg: (_color: string, text: string) => text, bold: (text: string) => text },
        null,
        () => {},
      );
      return undefined;
    });

    await showAgentsMainMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(component.settingsList.items.map((item: any) => item.value)).toEqual([
      "running", "spawn", "catalog", "settings",
    ]);
  });

  it("Escape closes the menu", async () => {
    const ctx = createMockCtx();
    // custom returns undefined = escape
    await showAgentsMainMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.custom).toHaveBeenCalled();
  });
});

describe("showSettingsMenu — SelectList dispatcher", () => {
  beforeEach(() => {
    resetAgentState();
    vi.clearAllMocks();
  });

  it("uses ctx.ui.custom (not ctx.ui.select)", async () => {
    const ctx = createMockCtx();
    await showSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.custom).toHaveBeenCalled();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("shows prompt settings directly without an Advanced submenu", async () => {
    const ctx = createMockCtx();
    let component: any;
    ctx.ui.custom.mockImplementationOnce(async (factory: any) => {
      component = factory(
        { terminal: { rows: 40 } },
        { fg: (_color: string, text: string) => text, bold: (text: string) => text },
        null,
        () => {},
      );
      return undefined;
    });

    await showSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(component.settingsList.items.map((item: any) => item.value)).toEqual([
      "models", "execution", "widget", "systemprompt",
    ]);
  });

  it("Escape closes the menu", async () => {
    const ctx = createMockCtx();
    await showSettingsMenu(ctx, ["anthropic/claude-sonnet-4-20250514"]);
    expect(ctx.ui.custom).toHaveBeenCalled();
  });
});

describe("menu dispatcher navigation", () => {
  const modelOptions = ["anthropic/claude-sonnet-4-20250514"];

  beforeEach(() => {
    resetAgentState();
    vi.clearAllMocks();
    (getAgentConfig as any).mockImplementation((name: string) => {
      if (name === "Explore") return { name: "Explore", description: "Explore agent", extensions: false, skills: false, systemPrompt: "" };
      if (name === "general-purpose") return { name: "general-purpose", description: "General-purpose agent", extensions: false, skills: false, systemPrompt: "" };
      return undefined;
    });
  });

  it.each([
    ["running", showRunningAgentsMenu, []],
    ["spawn", showSpawnAgentMenu, [modelOptions]],
    ["catalog", showAgentCatalog, []],
  ])("dispatches main-menu %s to its submenu", async (choice, submenu, extraArgs) => {
    const ctx = createMockCtx();
    ctx.ui.custom.mockResolvedValueOnce(choice).mockResolvedValueOnce(undefined);

    await showAgentsMainMenu(ctx, modelOptions);

    expect(submenu).toHaveBeenCalledWith(ctx, ...extraArgs);
  });

  it("dispatches main-menu settings into the settings menu", async () => {
    const ctx = createMockCtx();
    ctx.ui.custom
      .mockResolvedValueOnce("settings")
      .mockResolvedValueOnce("models")
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    await showAgentsMainMenu(ctx, modelOptions);

    expect(showModelSettingsMenu).toHaveBeenCalledWith(ctx, modelOptions);
  });

  it.each([
    ["models", showModelSettingsMenu, [modelOptions]],
    ["execution", showExecutionMenu, []],
    ["widget", showWidgetSettingsMenu, []],
    ["systemprompt", showSystemPromptMenu, []],
  ])("dispatches settings %s to its submenu", async (choice, submenu, extraArgs) => {
    const ctx = createMockCtx();
    ctx.ui.custom.mockResolvedValueOnce(choice).mockResolvedValueOnce(undefined);

    await showSettingsMenu(ctx, modelOptions);

    expect(submenu).toHaveBeenCalledWith(ctx, ...extraArgs);
  });
});
