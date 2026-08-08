import { describe, expect, it } from "vitest";
import { getStatusNote } from "../src/status-note.js";

describe("getStatusNote", () => {
  it("returns empty string for a successful status", () => {
    expect(getStatusNote({ status: "completed", startedAt: 0 })).toBe("");
  });

  it("explains parent cancellation for a stopped result", () => {
    expect(getStatusNote({ status: "stopped", startedAt: 0, stoppedBy: "parent" })).toMatch(/parent turn ended/);
    expect(getStatusNote({ status: "stopped", startedAt: 0 })).toMatch(/parent turn ended/);
  });

  it("wraps known notes with space-parentheses", () => {
    expect(getStatusNote({ status: "stopped", startedAt: 0, stoppedBy: "parent" })).toMatch(/^ \(.+\)$/);
  });
});
