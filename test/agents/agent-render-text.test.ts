import { describe, expect, it } from "vitest";
import {
  AgentCallDetailsComponent,
  escapeTerminalText,
  visibleWidth,
  wrapPlaintext,
} from "../../src/agents/agent-render-text.js";

function visibleLines(component: AgentCallDetailsComponent, width: number): string[] {
  return component.render(width).map((line) => line.replace(/\s+$/u, ""));
}

describe("Agent render text boundary", () => {
  it("wraps complete Unicode text at grapheme-safe conservative widths", () => {
    const value = "abc🇩🇪x\nabc1️⃣x";
    expect(visibleWidth("🇩🇪")).toBe(2);
    expect(visibleWidth("1️⃣")).toBe(2);
    expect(wrapPlaintext(value, 4)).toEqual(["abc", "🇩🇪x", "abc", "1️⃣x"]);

    const component = new AgentCallDetailsComponent();
    component.setText("A very long prompt with 日本語 and 👩‍💻 that must remain complete");
    const lines = visibleLines(component, 24);
    expect(lines.join(" ")).toContain("A very long prompt with 日本語 and 👩‍💻 that must remain complete");
    expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
  });

  it("escapes terminal controls while retaining intentional newlines and Unicode", () => {
    const esc = String.fromCharCode(0x1b);
    const bel = String.fromCharCode(0x07);
    const c1Csi = String.fromCharCode(0x9b);
    const value = `before${esc}]52;c;secret${bel}\r\t\0${String.fromCharCode(0x7f)}${c1Csi}\n日本語`;
    const escaped = escapeTerminalText(value, true);

    expect(escaped).toBe("before\\x1b]52;c;secret\\x07\\r\\t\\x00\\x7f\\x9b\n日本語");
    expect([...escaped].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint === 0x0a || (codePoint > 0x1f && codePoint !== 0x7f && !(codePoint >= 0x80 && codePoint <= 0x9f));
    })).toBe(true);
  });

  it("caches unchanged text and invalidates when content changes", () => {
    const component = new AgentCallDetailsComponent();
    component.setText("abc");
    expect(visibleLines(component, 20)).toEqual(["abc"]);
    expect(component.setText("abc")).toBe(false);
    expect(visibleLines(component, 20)).toEqual(["abc"]);
    expect(component.setText("updated")).toBe(true);
    expect(visibleLines(component, 20)).toEqual(["updated"]);
  });
});
