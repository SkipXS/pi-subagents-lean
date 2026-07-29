import { describe, expect, it } from "vitest";
import { makeMarkdownTheme } from "../../src/ui/markdown-theme.js";
import type { Theme } from "../../src/ui/types.js";

function createTheme(italic?: (text: string) => string): Theme {
  return {
    fg: (color, text) => `<${color}>${text}</${color}>`,
    bg: (color, text) => `<bg:${color}>${text}</bg:${color}>`,
    bold: (text) => `<b>${text}</b>`,
    italic,
  };
}

describe("makeMarkdownTheme", () => {
  it("delegates headings, dim sections and configured italic styling", () => {
    const theme = makeMarkdownTheme(createTheme((text) => `<i>${text}</i>`));

    expect(theme.heading("Title")).toBe("<b>Title</b>");
    for (const style of [theme.linkUrl, theme.codeBlockBorder, theme.quote, theme.quoteBorder, theme.hr]) {
      expect(style!("x")).toBe("<dim>x</dim>");
    }
    expect(theme.italic!("x")).toBe("<i>x</i>");
    expect(theme.highlightCode!("a\nb")).toEqual(["a", "b"]);
  });

  it("falls back to identity functions for unsupported styling", () => {
    const theme = makeMarkdownTheme(createTheme());

    expect(theme.italic!("plain")).toBe("plain");
    expect(theme.link("link")).toBe("link");
    expect(theme.code("code")).toBe("code");
    expect(theme.underline("under")).toBe("under");
    expect(theme.strikethrough("strike")).toBe("strike");
  });
});
