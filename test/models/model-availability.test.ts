import { describe, expect, it, vi } from "vitest";
import { requireAvailableModel } from "../../src/models/model-availability.ts";

const model = { provider: "cheap", id: "small" } as any;

describe("configured Eco model availability", () => {
  it("fails closed when the exact model is missing", async () => {
    const registry = { find: vi.fn(() => undefined), getApiKeyAndHeaders: vi.fn() } as any;
    await expect(requireAvailableModel("cheap/small", registry, "Eco model"))
      .rejects.toThrow("Eco model not found: cheap/small");
  });

  it("fails closed when authentication is unavailable", async () => {
    const registry = {
      find: vi.fn(() => model),
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: false, error: "sign in required" })),
    } as any;
    await expect(requireAvailableModel("cheap/small", registry, "Eco model"))
      .rejects.toThrow("Eco model is not authenticated: cheap/small (sign in required)");
  });

  it("returns the exact authenticated model", async () => {
    const registry = {
      find: vi.fn(() => model),
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true })),
    } as any;
    await expect(requireAvailableModel("cheap/small", registry, "Eco model")).resolves.toBe(model);
  });
});
