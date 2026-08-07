import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { buildSkillsOverride } from "../src/agents/agent-runner-policy.js";

type SkillPolicy = {
  skills: true | string[] | false;
  excludeSkills?: string[];
};

const skillNames = ["discovered-allowed", "discovered-blocked"] as const;

function writeSkill(path: string, name: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [
    "---",
    `name: ${name}`,
    `description: ${name} description`,
    "---",
    `${name} body`,
    "",
  ].join("\n"), "utf8");
}

async function loadDiscoveredSkillNames(root: string, policy: SkillPolicy): Promise<string[]> {
  const projectDir = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(projectDir);
  mkdirSync(agentDir);

  const skillPaths = skillNames.map((name) => {
    const skillPath = join(root, `${name}.md`);
    writeSkill(skillPath, name);
    return skillPath;
  });
  const extensionPath = join(root, "resource-extension.ts");
  writeFileSync(extensionPath, [
    "export default function (pi) {",
    `  pi.on("resources_discover", () => ({ skillPaths: ${JSON.stringify(skillPaths)} }));`,
    "}",
    "",
  ].join("\n"), "utf8");

  const settingsManager = SettingsManager.create(projectDir, agentDir);
  settingsManager.setProjectTrusted(true);
  const loader = new DefaultResourceLoader({
    cwd: projectDir,
    agentDir,
    additionalExtensionPaths: [extensionPath],
    noSkills: policy.skills === false || Array.isArray(policy.skills),
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    skillsOverride: buildSkillsOverride(policy.skills, policy.excludeSkills),
    settingsManager,
  });
  await loader.reload();

  expect(loader.getExtensions().extensions.map((extension) => extension.path)).toContain(extensionPath);
  expect(loader.getSkills().skills).toEqual([]);

  const { session } = await createAgentSession({
    cwd: projectDir,
    agentDir,
    model: undefined,
    tools: [],
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(projectDir),
    settingsManager,
  });
  try {
    // This is Pi's real startup order: the factory is already loaded by
    // reload(), then bindExtensions() emits resources_discover and extends
    // the same resource loader.
    await session.bindExtensions({});
    return loader.getSkills().skills.map((skill) => skill.name);
  } finally {
    session.dispose();
  }
}

const policyCases: Array<{ label: string; policy: SkillPolicy; expected: string[] }> = [
  {
    label: "skills false",
    policy: { skills: false },
    expected: [],
  },
  {
    label: "an explicit skills list",
    policy: { skills: ["discovered-allowed", "discovered-blocked"], excludeSkills: ["discovered-blocked"] },
    expected: ["discovered-allowed"],
  },
  {
    label: "skills true with exclusions",
    policy: { skills: true, excludeSkills: ["discovered-blocked"] },
    expected: ["discovered-allowed"],
  },
  {
    label: "all metadata without exclusions",
    policy: { skills: true },
    expected: ["discovered-allowed", "discovered-blocked"],
  },
];

describe("Pi resources_discover skill policy", () => {
  it.each(policyCases)("keeps $label effective after bindExtensions/resources_discover", async ({ policy, expected }) => {
    const root = mkdtempSync(join(tmpdir(), "subagents-skill-discovery-"));
    try {
      await expect(loadDiscoveredSkillNames(root, policy)).resolves.toEqual(expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("uses the same Pi trust boundary for real user and project skill discovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "subagents-project-trust-skills-"));
    try {
      const projectDir = join(root, "project");
      const agentDir = join(root, "agent");
      mkdirSync(projectDir, { recursive: true });
      writeSkill(join(projectDir, ".pi", "skills", "project-only", "SKILL.md"), "project-only");
      writeSkill(join(agentDir, "skills", "user-only", "SKILL.md"), "user-only");

      const untrustedSettings = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });
      const untrustedLoader = new DefaultResourceLoader({
        cwd: projectDir,
        agentDir,
        noExtensions: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        settingsManager: untrustedSettings,
      });
      await untrustedLoader.reload();
      const untrustedNames = untrustedLoader.getSkills().skills.map((skill) => skill.name);
      expect(untrustedNames).toContain("user-only");
      expect(untrustedNames).not.toContain("project-only");

      const trustedSettings = SettingsManager.create(projectDir, agentDir, { projectTrusted: true });
      const trustedLoader = new DefaultResourceLoader({
        cwd: projectDir,
        agentDir,
        noExtensions: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        settingsManager: trustedSettings,
      });
      await trustedLoader.reload();
      expect(trustedLoader.getSkills().skills.map((skill) => skill.name)).toEqual(
        expect.arrayContaining(["user-only", "project-only"]),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
