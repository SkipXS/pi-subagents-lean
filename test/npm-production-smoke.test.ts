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

  it("publishes the source entrypoint, documentation, and all canonical default agents", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    expect(manifest.pi).toEqual({ extensions: ["./src/index.ts"] });
    expect(manifest.files).toEqual(expect.arrayContaining(["src/", "README.md", "LICENSE", "docs/coverage.md"]));
    for (const name of ["architect", "scout", "implementer", "reviewer", "verifier"]) {
      expect(existsSync(join("src", "agents", "defaults", `${name}.md`))).toBe(true);
    }
  });
});
