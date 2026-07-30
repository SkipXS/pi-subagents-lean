import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
// A cold npm install of Pi's provider-heavy dependency tree can exceed two
// minutes on hosted Windows runners.
const COMMAND_TIMEOUT_MS = 300_000;

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
    const installArgs = ["install", "--omit=dev", "--package-lock=false", "--ignore-scripts"];
    // npm's automatic peer installation repeatedly corrupts nested package
    // extraction on hosted Windows runners. The separate package smoke installs
    // and loads the extension with its real Pi peers on both platforms; this
    // check only needs to validate the production dependency manifest there.
    if (process.platform === "win32") installArgs.push("--legacy-peer-deps");
    execFileSync(npm, installArgs, {
      cwd: tempRoot,
      stdio: "inherit",
      timeout: COMMAND_TIMEOUT_MS,
    });
    console.log("npm production install succeeded");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
