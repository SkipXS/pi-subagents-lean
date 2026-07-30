import { describe, expect, it } from "vitest";
import { productionManifest } from "../scripts/npm-production-smoke.ts";

describe("productionManifest", () => {
  it("removes development dependencies while preserving the production manifest", () => {
    const manifest = {
      name: "example",
      version: "1.0.0",
      packageManager: "bun@1",
      engines: { node: ">=18" },
      dependencies: { production: "^1.0.0" },
      optionalDependencies: { optional: "^1.0.0" },
      peerDependencies: { peer: "^1.0.0" },
      peerDependenciesMeta: { peer: { optional: true } },
      overrides: { transitive: "^1.0.0" },
      devDependencies: { vitest: "^4.0.0" },
    };

    expect(productionManifest(manifest)).toEqual({
      name: "example",
      version: "1.0.0",
      packageManager: "bun@1",
      engines: { node: ">=18" },
      dependencies: { production: "^1.0.0" },
      optionalDependencies: { optional: "^1.0.0" },
      peerDependencies: { peer: "^1.0.0" },
      peerDependenciesMeta: { peer: { optional: true } },
      overrides: { transitive: "^1.0.0" },
    });
  });
});
