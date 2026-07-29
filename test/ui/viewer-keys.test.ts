import { describe, expect, it, vi } from "vitest";
import { createViewerKeys } from "../../src/ui/viewer-keys.js";

describe("createViewerKeys", () => {
  it("uses the standard TUI bindings when no manager is supplied", () => {
    const keys = createViewerKeys();

    expect(keys.scrollUp("\x1b[A")).toBe(true);
    expect(keys.scrollDown("\x1b[B")).toBe(true);
    expect(keys.pageUp("\x1b[5~")).toBe(true);
    expect(keys.pageDown("\x1b[6~")).toBe(true);
  });

  it("uses configured bindings while retaining viewer aliases", () => {
    const matches = vi.fn((data: string, id: string) => data === `custom:${id}`);
    const keys = createViewerKeys({ matches });

    expect(keys.scrollUp("custom:tui.select.up")).toBe(true);
    expect(keys.scrollDown("custom:tui.select.down")).toBe(true);
    expect(keys.pageUp("custom:tui.select.pageUp")).toBe(true);
    expect(keys.pageDown("custom:tui.select.pageDown")).toBe(true);
    expect(keys.scrollUp("k")).toBe(true);
    expect(keys.scrollDown("j")).toBe(true);
    expect(keys.pageUp("\x1b[1;2A")).toBe(true);
    expect(keys.pageDown("\x1b[1;2B")).toBe(true);
  });
});
