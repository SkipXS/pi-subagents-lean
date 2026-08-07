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
const COMMAND_TIMEOUT_MS = 120_000;

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
  ], { cwd: root, stdio: "inherit", timeout: COMMAND_TIMEOUT_MS });

  writeFileSync(join(installDir, "package.json"), JSON.stringify({
    private: true,
    type: "module",
    dependencies: {
      "pi-subagents-lean": `file:${tarball}`,
      "@earendil-works/pi-ai": installedVersion("@earendil-works/pi-ai"),
      "@earendil-works/pi-coding-agent": installedVersion("@earendil-works/pi-coding-agent"),
    },
  }, null, 2));

  execFileSync(bun, ["install", "--ignore-scripts"], { cwd: installDir, stdio: "inherit", timeout: COMMAND_TIMEOUT_MS });

  const smokeScript = `
    import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

    const agentDir = mkdtempSync(join(tmpdir(), "pi-subagents-loader-"));
    try {
      const packageDir = join(process.cwd(), "node_modules", "pi-subagents-lean");
      const installedPackage = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
      if (installedPackage.version !== "${rootPackage.version}") {
        throw new Error("Installed package version does not match the tarball version");
      }
      if (JSON.stringify(installedPackage.pi) !== JSON.stringify({ extensions: ["./src/index.ts"] })) {
        throw new Error("Unexpected Pi manifest entry");
      }
      for (const field of ["main", "types", "exports"]) {
        if (Object.prototype.hasOwnProperty.call(installedPackage, field)) {
          throw new Error("Unexpected package entry field: " + field);
        }
      }
      const packagedFiles = [
        "src/", "docs/coverage.md", "docs/releasing.md", "CHANGELOG.md", "README.md", "LICENSE",
      ];
      if (JSON.stringify(installedPackage.files) !== JSON.stringify(packagedFiles)) {
        throw new Error("Unexpected package files metadata");
      }
      for (const file of [
        "README.md", "LICENSE", "CHANGELOG.md", "docs/coverage.md", "docs/releasing.md", "src/index.ts",
        "src/agents/defaults/architect.md", "src/agents/defaults/scout.md", "src/agents/defaults/implementer.md",
        "src/agents/defaults/reviewer.md", "src/agents/defaults/verifier.md",
      ]) {
        if (!existsSync(join(packageDir, file))) throw new Error("Missing packaged file: " + file);
      }
      const extensionPath = join(packageDir, "src", "index.ts");
      const result = await discoverAndLoadExtensions([extensionPath], process.cwd(), agentDir);
      if (result.errors.length > 0) throw new Error(JSON.stringify(result.errors));
      if (result.extensions.length !== 1) throw new Error("Expected exactly one loaded extension");
      const extension = result.extensions[0];
      const expectedToolNames = ["Agent", "AgentContinue", "StopAgent", "AgentStatus"];
      const tools = [...extension.tools.keys()];
      if (JSON.stringify(tools) !== JSON.stringify(expectedToolNames)) {
        throw new Error("Unexpected tools: " + tools.join(","));
      }
      const expectedToolContracts = {
        Agent: {
          type: "object",
          additionalProperties: false,
          required: ["prompt", "agent"],
          properties: {
            prompt: { type: "string", maxLength: 262144 },
            description: { type: "string", maxLength: 8192 },
            agent: { type: "string" },
            run_in_background: { type: "boolean" },
            worktree_path: { type: "string" },
          },
        },
        AgentContinue: {
          type: "object",
          additionalProperties: false,
          required: ["agent_id", "prompt", "run_in_background"],
          properties: {
            agent_id: { type: "string", maxLength: 128 },
            prompt: { type: "string", maxLength: 262144 },
            run_in_background: { type: "boolean" },
          },
        },
        StopAgent: {
          type: "object",
          additionalProperties: false,
          required: ["agent_id"],
          properties: { agent_id: { type: "string", maxLength: 128 } },
        },
        AgentStatus: {
          type: "object",
          additionalProperties: false,
          required: [],
          properties: {},
        },
      };
      function normalizedContract(definition) {
        const schema = definition.parameters ?? {};
        const properties = schema.properties ?? {};
        return {
          type: schema.type,
          additionalProperties: schema.additionalProperties,
          required: schema.required ?? [],
          properties: Object.fromEntries(Object.entries(properties).map(([key, value]) => [
            key,
            {
              type: value.type,
              ...(value.maxLength === undefined ? {} : { maxLength: value.maxLength }),
            },
          ])),
        };
      }
      for (const name of expectedToolNames) {
        const definition = extension.tools.get(name)?.definition;
        if (!definition || definition.name !== name || typeof definition.execute !== "function") {
          throw new Error("Invalid tool definition: " + name);
        }
        if (JSON.stringify(normalizedContract(definition)) !== JSON.stringify(expectedToolContracts[name])) {
          throw new Error("Unexpected contract for tool: " + name);
        }
      }
      if (extension.commands.size !== 0) throw new Error("Unexpected custom commands");
      for (const event of ["session_start", "session_shutdown"]) {
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
    timeout: COMMAND_TIMEOUT_MS,
  });
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
