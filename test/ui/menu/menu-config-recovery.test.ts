import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockModules } from "../../menu-mock-setup.js";
import { createMockCtx } from "../../menu-test-helpers.js";
import { getStore } from "../../../src/shell.js";
import { showConfigRecoveryMenu } from "../../../src/ui/menu/menu-config-recovery.js";

describe("showConfigRecoveryMenu", () => {
  beforeEach(() => {
    mockModules.mockConfigHealth = "using-backup";
    mockModules.mockCanRepair = true;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["unrecoverable", true, "The config could not be read safely"],
    ["using-backup", false, "The primary config is unavailable"],
  ] as const)("shows an error without opening a dialog when recovery is unavailable (%s, canRepair=%s)", async (health, canRepair, message) => {
    mockModules.mockConfigHealth = health;
    mockModules.mockCanRepair = canRepair;
    const ctx = createMockCtx();
    const repair = vi.spyOn(getStore(), "repair");

    await expect(showConfigRecoveryMenu(ctx)).resolves.toBe(false);

    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(repair).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining(message), "error");
  });

  it.each([
    ["cancel", ["cancel"]],
    ["confirmation decline", ["repair", "no"]],
  ] as const)("leaves the config unchanged after %s", async (_description, choices) => {
    const ctx = createMockCtx();
    ctx.ui.custom.mockResolvedValueOnce(choices[0]).mockResolvedValueOnce(choices[1]);
    const repair = vi.spyOn(getStore(), "repair");

    await expect(showConfigRecoveryMenu(ctx)).resolves.toBe(false);

    expect(repair).not.toHaveBeenCalled();
    expect(mockModules.mockConfigHealth).toBe("using-backup");
    expect(mockModules.mockCanRepair).toBe(true);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("builds recovery and confirmation choices before repairing", async () => {
    const ctx = createMockCtx();
    const wrappers: any[] = [];
    const choices = ["repair", "yes"];
    ctx.ui.custom.mockImplementation(async (factory: any) => {
      wrappers.push(factory(
        { terminal: { rows: 40 } },
        { fg: (_color: string, text: string) => text, bold: (text: string) => text },
        null,
        () => {},
      ));
      return choices.shift();
    });
    const repair = vi.spyOn(getStore(), "repair");

    await expect(showConfigRecoveryMenu(ctx)).resolves.toBe(true);

    expect(wrappers).toHaveLength(2);
    expect(wrappers.map((wrapper) => wrapper.title)).toEqual(["Config Recovery", "Confirm Config Repair"]);
    expect(wrappers[0].settingsList.items.map((item: any) => item.value)).toEqual(["repair", "cancel"]);
    expect(wrappers[1].settingsList.items.map((item: any) => item.value)).toEqual(["yes", "no"]);
    expect(repair).toHaveBeenCalledOnce();
    expect(mockModules.mockConfigHealth).toBe("healthy");
    expect(mockModules.mockCanRepair).toBe(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Primary config repaired from backup.", "info");
  });

  it("reports a repair failure", async () => {
    const ctx = createMockCtx();
    ctx.ui.custom.mockResolvedValueOnce("repair").mockResolvedValueOnce("yes");
    const repair = vi.spyOn(getStore(), "repair").mockImplementation(() => {
      throw new Error("disk unavailable");
    });

    await expect(showConfigRecoveryMenu(ctx)).resolves.toBe(false);

    expect(repair).toHaveBeenCalledOnce();
    expect(mockModules.mockConfigHealth).toBe("using-backup");
    expect(mockModules.mockCanRepair).toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Config repair failed: disk unavailable", "error");
  });
});
