import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = mkdtempSync(join(tmpdir(), "pi-subagents-npm-production-smoke-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

try {
  writeFileSync(
    join(tempRoot, "package.json"),
    readFileSync(join(root, "package.json"), "utf8"),
  );
  execFileSync(npm, ["install", "--omit=dev", "--package-lock=false", "--ignore-scripts"], {
    cwd: tempRoot,
    stdio: "inherit",
  });
  console.log("npm production install succeeded");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
