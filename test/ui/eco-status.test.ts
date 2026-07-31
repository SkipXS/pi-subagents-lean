import { describe, expect, it, vi } from "vitest";
import { ECO_STATUS_KEY, syncEcoStatus } from "../../src/ui/eco-status.ts";

describe("Eco footer status", () => {
  it("uses the theme API in Eco mode and clears the status in Default mode", () => {
    const fg = vi.fn((_color: string, text: string) => `themed:${text}`);
    const setStatus = vi.fn();
    const ui = { theme: { fg }, setStatus };

    syncEcoStatus(ui, "eco");
    expect(fg).toHaveBeenCalledWith("success", "🍃 Eco");
    expect(setStatus).toHaveBeenLastCalledWith(ECO_STATUS_KEY, "themed:🍃 Eco");

    syncEcoStatus(ui, "default");
    expect(setStatus).toHaveBeenLastCalledWith(ECO_STATUS_KEY, undefined);
  });
});
