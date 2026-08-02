import { describe, it, expect } from "vitest";
import { extractText } from "../../src/prompt/context.js";

describe("extractText", () => {
  it("extracts text from a simple content array", () => {
    expect(extractText([{ type: "text", text: "Hello world" }])).toBe("Hello world");
  });

  it("joins multiple text blocks with newlines", () => {
    expect(extractText([
      { type: "text", text: "First line" },
      { type: "text", text: "Second line" },
    ])).toBe("First line\nSecond line");
  });

  it("filters out non-text blocks", () => {
    expect(extractText([
      { type: "text", text: "Visible" },
      { type: "image", data: "base64..." },
      { type: "toolCall", id: "tc1", arguments: {} },
    ])).toBe("Visible");
  });

  it("returns empty string for empty arrays", () => {
    expect(extractText([])).toBe("");
  });

  it("handles null/undefined text fields conservatively", () => {
    expect(extractText([
      { type: "text", text: null },
      { type: "text", text: "Valid" },
    ] as any)).toBe("\nValid");
  });
});
