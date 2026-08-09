import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

  it("keeps the Pi manifest and package compatibility boundary", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));

    expect(manifest.pi).toEqual({ extensions: ["./src/index.ts"] });
    expect(manifest).not.toHaveProperty("main");
    expect(manifest).not.toHaveProperty("types");
    expect(manifest).not.toHaveProperty("exports");
    expect(manifest.files).toEqual([
      "src/",
      "README.md",
      "CHANGELOG.md",
      "LICENSE",
    ]);
    expect({
      name: manifest.name,
      license: manifest.license,
      packageManager: manifest.packageManager,
      engines: manifest.engines,
      dependencies: manifest.dependencies,
      peerDependencies: manifest.peerDependencies,
    }).toEqual({
      name: "pi-subagents-lean",
      license: "MIT",
      packageManager: "bun@1",
      engines: { bun: ">=1.0.0", node: ">=18" },
      dependencies: { "@sinclair/typebox": "^0.34.49" },
      peerDependencies: {
        "@earendil-works/pi-ai": "^0.82.0",
        "@earendil-works/pi-coding-agent": "^0.82.0",
      },
    });

    for (const name of ["architect", "scout", "implementer", "reviewer", "verifier"]) {
      expect(existsSync(join("src", "agents", "defaults", `${name}.md`))).toBe(true);
    }
  });
});
