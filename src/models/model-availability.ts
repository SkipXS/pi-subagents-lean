import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { parseModelKey } from "../utils.js";

/** Resolve a configured model exactly and verify current authentication; never falls back. */
export async function requireAvailableModel(
  modelKey: string,
  registry: Pick<ModelRegistry, "find"> & Partial<Pick<ModelRegistry, "getApiKeyAndHeaders">>,
  label = "Model",
): Promise<Model<any>> {
  const parsed = parseModelKey(modelKey);
  const model = parsed ? registry.find(parsed.provider, parsed.modelId) : undefined;
  if (!model) throw new Error(`${label} not found: ${modelKey}`);
  if (typeof registry.getApiKeyAndHeaders === "function") {
    const auth = await registry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error(`${label} is not authenticated: ${modelKey} (${auth.error})`);
  }
  return model;
}
