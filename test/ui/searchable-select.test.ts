import { describe, expect, it, vi } from "vitest";
import { SearchableSelectDialog, type SelectOption } from "../../src/ui/searchable-select.js";
import type { Theme } from "../../src/ui/types.js";

const theme: Theme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
  italic: (text) => text,
};

function createDialog(items: SelectOption[], currentValue: string | null = null) {
  const onSelect = vi.fn();
  const onCancel = vi.fn();
  const dialog = new SearchableSelectDialog(items, currentValue, { onSelect, onCancel }, theme);
  return { dialog, onSelect, onCancel };
}

describe("SearchableSelectDialog", () => {
  it("preselects the current value and confirms it", () => {
    const { dialog, onSelect } = createDialog([
      { value: "a", label: "Alpha" },
      { value: "b", label: "Beta" },
    ], "b");

    dialog.handleInput("\r");
    expect(onSelect).toHaveBeenCalledWith("b");
  });

  it("wraps navigation and pages through long lists", () => {
    const items = Array.from({ length: 12 }, (_, index) => ({ value: `${index}`, label: `Item ${index}` }));
    const wrapped = createDialog(items);
    wrapped.dialog.handleInput("\x1b[A");
    wrapped.dialog.handleInput("\r");
    expect(wrapped.onSelect).toHaveBeenCalledWith("11");

    const paged = createDialog(items);
    paged.dialog.handleInput("\x1b[6~");
    expect((paged.dialog as any).listContainer.render(80).join("\n")).toContain("(11/12)");
    paged.dialog.handleInput("\r");
    expect(paged.onSelect).toHaveBeenCalledWith("10");
  });

  it("filters, clamps the selection and renders an empty state", () => {
    const { dialog, onSelect } = createDialog([
      { value: "alpha", label: "Alpha", provider: "one" },
      { value: "beta", label: "Beta", provider: "two" },
    ], "beta");

    dialog.handleInput("a");
    dialog.handleInput("l");
    dialog.handleInput("p");
    dialog.handleInput("h");
    dialog.handleInput("a");
    dialog.handleInput("\r");
    expect(onSelect).toHaveBeenCalledWith("alpha");

    const empty = createDialog([{ value: "alpha", label: "Alpha" }]);
    empty.dialog.handleInput("z");
    expect((empty.dialog as any).listContainer.render(80).join("\n")).toContain("No matching items");
    empty.dialog.handleInput("\x1b[B");
    empty.dialog.handleInput("\r");
    expect(empty.onSelect).not.toHaveBeenCalled();
  });

  it("cancels and settles callbacks at most once", () => {
    const selected = createDialog([{ value: "a", label: "Alpha" }]);
    selected.dialog.handleInput("\r");
    selected.dialog.handleInput("\r");
    selected.dialog.handleInput("\x1b");
    expect(selected.onSelect).toHaveBeenCalledOnce();
    expect(selected.onCancel).not.toHaveBeenCalled();

    const cancelled = createDialog([{ value: "a", label: "Alpha" }]);
    cancelled.dialog.handleInput("\x1b");
    cancelled.dialog.handleInput("\x1b");
    cancelled.dialog.handleInput("\r");
    expect(cancelled.onCancel).toHaveBeenCalledOnce();
    expect(cancelled.onSelect).not.toHaveBeenCalled();
  });
});
