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
vi.mock("../../../src/ui/menu/menu-config-recovery.js", () => ({ showConfigRecoveryMenu: vi.fn() }));
vi.mock("../../../src/ui/menu/menu-spawn-wizard.js", () => ({ showSpawnAgentMenu: vi.fn() }));

import { showRunningAgentsMenu } from "../../../src/ui/menu/menu-running-agents.js";
import { showSpawnAgentMenu } from "../../../src/ui/menu/menu-spawn-wizard.js";
import { showAgentCatalog } from "../../../src/ui/menu/menu-agent-catalog.js";
import { showModelSettingsMenu } from "../../../src/ui/menu/menu-model-settings.js";
import { showExecutionMenu } from "../../../src/ui/menu/menu-execution.js";
import { showWidgetSettingsMenu } from "../../../src/ui/menu/menu-widget-settings.js";
import { showSystemPromptMenu } from "../../../src/ui/menu/menu-system-prompt.js";
import { showConfigRecoveryMenu } from "../../../src/ui/menu/menu-config-recovery.js";
import { showAgentsMainMenu, showSettingsMenu } from "../../../src/ui/menu/menus.js";

function resetAgentState(): void {
  mockModules.mockConfig.agent = { default: null, forceBackground: false };
  mockModules.mockSessionOverrides.default = null;
  mockModules.mockConfig.mode = undefined;
  mockModules.mockSessionMode = undefined;
  mockModules.mockSessionShowCost = undefined;
  mockModules.mockConfigHealth = "healthy";
  mockModules.mockCanRepair = false;
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

  it("shows mode and the existing main-menu actions", async () => {
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
      "mode", "running", "spawn", "catalog", "settings",
    ]);
  });

  it("mutates session and permanent mode choices and synchronizes the footer", async () => {
    const sessionCtx = createMockCtx();
    sessionCtx.ui.theme = { fg: (_color: string, text: string) => text };
    sessionCtx.ui.setStatus = vi.fn();
    sessionCtx.ui.custom.mockResolvedValueOnce("mode").mockResolvedValueOnce("session:eco").mockResolvedValueOnce(undefined);
    await showAgentsMainMenu(sessionCtx, []);
    expect(mockModules.mockSessionMode).toBe("eco");
    expect(sessionCtx.ui.setStatus).toHaveBeenCalledWith("subagents-eco", "🍃 Eco");

    const permanentCtx = createMockCtx();
    permanentCtx.ui.theme = { fg: (_color: string, text: string) => text };
    permanentCtx.ui.setStatus = vi.fn();
    permanentCtx.ui.custom.mockResolvedValueOnce("mode").mockResolvedValueOnce("permanent:default").mockResolvedValueOnce(undefined);
    await showAgentsMainMenu(permanentCtx, []);
    expect(mockModules.mockConfig.mode).toBe("default");
    expect(mockModules.mockSessionMode).toBeUndefined();
    expect(permanentCtx.ui.setStatus).toHaveBeenCalledWith("subagents-eco", undefined);
  });

  it("reports a mode persistence failure, keeps the mode chooser open, and leaves the footer unchanged", async () => {
    const ctx = createMockCtx();
    ctx.ui.theme = { fg: (_color: string, text: string) => text };
    ctx.ui.setStatus = vi.fn();
    const { getStore } = await import("../../../src/shell.js");
    const store = getStore() as any;
    const setMode = store.mutate.agent.setMode;
    store.mutate.agent.setMode = () => { throw new Error("config locked"); };
    ctx.ui.custom
      .mockResolvedValueOnce("mode")
      .mockResolvedValueOnce("permanent:eco")
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    try {
      await showAgentsMainMenu(ctx, []);
      expect(ctx.ui.notify).toHaveBeenCalledWith("Failed to save setting: config locked", "error");
      expect(ctx.ui.setStatus).not.toHaveBeenCalled();
      expect(ctx.ui.custom).toHaveBeenCalledTimes(4);
    } finally {
      store.mutate.agent.setMode = setMode;
    }
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

  it("offers only the recovery/status flow while config health is not healthy", async () => {
    mockModules.mockConfigHealth = "using-backup";
    const ctx = createMockCtx();
    let component: any;
    ctx.ui.custom.mockImplementationOnce(async (factory: any) => {
      component = factory({ terminal: { rows: 40 } }, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, null, () => {});
      return undefined;
    });

    await showSettingsMenu(ctx, []);
    expect(component.settingsList.items.map((item: any) => item.value)).toEqual(["recovery"]);
  });

  it("dispatches recovery and rebuilds settings from the current health on return", async () => {
    mockModules.mockConfigHealth = "using-backup";
    const ctx = createMockCtx();
    let refreshedComponent: any;
    (showConfigRecoveryMenu as any).mockImplementationOnce(async () => {
      mockModules.mockConfigHealth = "healthy";
      return true;
    });
    ctx.ui.custom
      .mockResolvedValueOnce("recovery")
      .mockImplementationOnce(async (factory: any) => {
        refreshedComponent = factory(
          { terminal: { rows: 40 } },
          { fg: (_color: string, text: string) => text, bold: (text: string) => text },
          null,
          () => {},
        );
        return undefined;
      });

    await showSettingsMenu(ctx, []);

    expect(showConfigRecoveryMenu).toHaveBeenCalledWith(ctx);
    expect(refreshedComponent.settingsList.items.map((item: any) => item.value)).toEqual([
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
