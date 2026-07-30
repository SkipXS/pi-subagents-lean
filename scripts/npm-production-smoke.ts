import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

export function productionManifest(manifest: Record<string, unknown>): Record<string, unknown> {
  const { devDependencies: _devDependencies, ...productionManifest } = manifest;
  return productionManifest;
}

function main(): void {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-subagents-npm-production-smoke-"));

  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(
      join(tempRoot, "package.json"),
      JSON.stringify(productionManifest(manifest), null, 2),
    );
    execFileSync(npm, ["install", "--omit=dev", "--package-lock=false", "--ignore-scripts"], {
      cwd: tempRoot,
      stdio: "inherit",
    });
    console.log("npm production install succeeded");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
