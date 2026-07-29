import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = mkdtempSync(join(tmpdir(), "pi-subagents-package-smoke-"));
const packDir = join(tempRoot, "pack");
const installDir = join(tempRoot, "install");
const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string; version: string };
const tarball = join(packDir, `${rootPackage.name}-${rootPackage.version}.tgz`);
const bun = process.execPath;

function installedVersion(packageName: string): string {
  const packageJson = JSON.parse(
    readFileSync(join(root, "node_modules", ...packageName.split("/"), "package.json"), "utf8"),
  ) as { version: string };
  return packageJson.version;
}

try {
  mkdirSync(packDir, { recursive: true });
  mkdirSync(installDir, { recursive: true });
  execFileSync(bun, [
    "pm", "pack",
    "--destination", packDir,
    "--ignore-scripts",
    "--quiet",
  ], { cwd: root, stdio: "inherit" });

  writeFileSync(join(installDir, "package.json"), JSON.stringify({
    private: true,
    type: "module",
    dependencies: {
      "pi-subagents-lean": `file:${tarball}`,
      "@earendil-works/pi-ai": installedVersion("@earendil-works/pi-ai"),
      "@earendil-works/pi-coding-agent": installedVersion("@earendil-works/pi-coding-agent"),
      "@earendil-works/pi-tui": installedVersion("@earendil-works/pi-tui"),
    },
  }, null, 2));

  execFileSync(bun, ["install", "--ignore-scripts"], { cwd: installDir, stdio: "inherit" });

  const smokeScript = `
    import { mkdtempSync, rmSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

    const agentDir = mkdtempSync(join(tmpdir(), "pi-subagents-loader-"));
    try {
      const extensionPath = join(process.cwd(), "node_modules", "pi-subagents-lean", "src", "index.ts");
      const result = await discoverAndLoadExtensions([extensionPath], process.cwd(), agentDir);
      if (result.errors.length > 0) throw new Error(JSON.stringify(result.errors));
      if (result.extensions.length !== 1) throw new Error("Expected exactly one loaded extension");
      const extension = result.extensions[0];
      const tools = [...extension.tools.keys()];
      if (tools.join(",") !== "Agent,StopAgent,AgentStatus") {
        throw new Error("Unexpected tools: " + tools.join(","));
      }
      if (!extension.commands.has("agents")) throw new Error("Missing /agents command");
      for (const event of ["tool_call", "session_start", "session_shutdown"]) {
        if (!extension.handlers.has(event)) throw new Error("Missing handler: " + event);
      }
      console.log("Installed package loaded successfully through Pi");
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  `;
  writeFileSync(join(installDir, "smoke.mjs"), smokeScript);
  execFileSync(bun, ["smoke.mjs"], {
    cwd: installDir,
    env: { ...process.env, PI_OFFLINE: "1" },
    stdio: "inherit",
  });
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
