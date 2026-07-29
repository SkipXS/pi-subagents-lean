import { describe, expect, it, vi } from "vitest";
import { createThinkingSelectSubmenu } from "../../../../src/ui/menu/submenus/thinking-select.js";
import type { Theme } from "../../../../src/ui/types.js";

const theme: Theme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
  italic: (text) => text,
};

function setup(showClear = false, levels?: readonly ("off" | "low" | "max")[]) {
  const onSelect = vi.fn();
  const done = vi.fn();
  const component = createThinkingSelectSubmenu({ showClear, levels, theme, onSelect })("", done);
  return { component, onSelect, done };
}

describe("createThinkingSelectSubmenu", () => {
  it("selects a session override and maps inherit to undefined", () => {
    const { component, onSelect, done } = setup();

    component.handleInput!("\r");
    component.handleInput!("\r");

    expect(onSelect).toHaveBeenCalledWith("session", undefined);
    expect(done).toHaveBeenCalledWith("inherit");
  });

  it("selects a permanent thinking level", () => {
    const { component, onSelect, done } = setup();

    component.handleInput!("\x1b[B");
    component.handleInput!("\r");
    component.handleInput!("\x1b[B");
    component.handleInput!("\x1b[B");
    component.handleInput!("\x1b[B");
    component.handleInput!("\r");

    expect(onSelect).toHaveBeenCalledWith("permanent", "low");
    expect(done).toHaveBeenCalledWith("low");
  });

  it("clears an override without opening the level selector", () => {
    const { component, onSelect, done } = setup(true);

    component.handleInput!("\x1b[B");
    component.handleInput!("\x1b[B");
    component.handleInput!("\r");

    expect(onSelect).toHaveBeenCalledWith("clear", undefined);
    expect(done).toHaveBeenCalledWith("clear");
  });

  it("honors a restricted level list", () => {
    const { component, onSelect } = setup(false, ["max"]);

    component.handleInput!("\r");
    component.handleInput!("\x1b[B");
    component.handleInput!("\r");

    expect(onSelect).toHaveBeenCalledWith("session", "max");
  });

  it("cancels from either step without changing settings", () => {
    const mode = setup();
    mode.component.handleInput!("\x1b");
    expect(mode.done).toHaveBeenCalledWith();
    expect(mode.onSelect).not.toHaveBeenCalled();

    const level = setup();
    level.component.handleInput!("\r");
    level.component.handleInput!("\x1b");
    expect(level.done).toHaveBeenCalledWith();
    expect(level.onSelect).not.toHaveBeenCalled();
  });
});
