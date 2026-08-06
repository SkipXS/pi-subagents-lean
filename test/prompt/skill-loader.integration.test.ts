import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "subagents-real-skills-"));
  roots.push(root);
  return root;
}

function skill(root: string, name: string, description: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`, "utf8");
  return file;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("skill discovery through Pi's real loaders", () => {
  it("honors git boundaries, ignore files, root-file filtering, and name precedence", async () => {
    const root = tempRoot();
    const agentDir = join(root, "agent-home");
    const isolatedHome = join(root, "os-home");
    const repo = join(root, "repo");
    const cwd = join(repo, "packages", "app");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(isolatedHome, { recursive: true });
    mkdirSync(cwd, { recursive: true });

    skill(join(cwd, ".agents", "skills"), "winner", "nearest ancestor");
    skill(join(repo, ".agents", "skills"), "winner", "git root duplicate");
    skill(join(repo, ".agents", "skills"), "root-only", "root boundary");
    skill(join(root, ".agents", "skills"), "outside-git", "must not cross git root");
    skill(join(cwd, ".pi", "skills"), "project-default", "Pi project default");
    skill(join(agentDir, "skills"), "user-default", "Pi user default");
    skill(join(cwd, ".agents", "skills"), "ignored", "ignored directory");
    writeFileSync(join(cwd, ".agents", "skills", ".ignore"), "ignored/\n", "utf8");
    writeFileSync(join(cwd, ".agents", "skills", "flat.md"), "---\nname: flat\ndescription: filtered\n---\n", "utf8");

    vi.stubEnv("HOME", isolatedHome);
    vi.stubEnv("USERPROFILE", isolatedHome);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.resetModules();
    const { loadAllSkills } = await import("../../src/prompt/skill-loader.ts");
    const loaded = loadAllSkills(cwd);
    const byName = new Map(loaded.map((entry) => [entry.name, entry]));

    expect(byName.get("winner")?.description).toBe("nearest ancestor");
    expect(byName.get("root-only")?.description).toBe("root boundary");
    expect(byName.has("outside-git")).toBe(false);
    expect(byName.has("ignored")).toBe(false);
    expect(byName.has("flat")).toBe(false);
    expect(byName.has("project-default")).toBe(true);
    expect(byName.has("user-default")).toBe(true);
  });

  it("keeps global user skills while excluding project roots for an untrusted snapshot", async () => {
    const root = tempRoot();
    const isolatedHome = join(root, "os-home");
    const agentDir = join(root, "agent-home");
    const repo = join(root, "repo");
    const cwd = join(repo, "packages", "app");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(cwd, { recursive: true });

    skill(join(cwd, ".agents", "skills"), "project-agents", "project shared");
    skill(join(cwd, ".pi", "skills"), "project-pi", "project default");
    skill(join(isolatedHome, ".agents", "skills"), "home-user", "global agents");
    skill(join(agentDir, "skills"), "pi-user", "global pi");

    vi.stubEnv("HOME", isolatedHome);
    vi.stubEnv("USERPROFILE", isolatedHome);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.resetModules();
    const { loadAllSkills } = await import("../../src/prompt/skill-loader.ts");

    const untrusted = new Set(loadAllSkills(cwd, false).map(({ name }) => name));
    expect(untrusted).toEqual(new Set(["home-user", "pi-user"]));

    const trusted = new Set(loadAllSkills(cwd, true).map(({ name }) => name));
    expect(trusted).toEqual(new Set(["project-agents", "project-pi", "home-user", "pi-user"]));
  });

  it("refreshes a real cached negative source after creation and mutation", async () => {
    const root = tempRoot();
    const cwd = join(root, "repo");
    const isolatedHome = join(root, "os-home");
    const agentDir = join(root, "agent-home");
    mkdirSync(join(cwd, ".git"), { recursive: true });
    mkdirSync(isolatedHome, { recursive: true });
    mkdirSync(cwd, { recursive: true });

    vi.stubEnv("HOME", isolatedHome);
    vi.stubEnv("USERPROFILE", isolatedHome);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.resetModules();
    const { loadAllSkills } = await import("../../src/prompt/skill-loader.ts");

    expect(loadAllSkills(cwd).some(({ name }) => name === "cached")).toBe(false);
    const filePath = skill(join(cwd, ".pi", "skills"), "cached", "initial");
    expect(loadAllSkills(cwd).find(({ name }) => name === "cached")?.description).toBe("initial");
    expect(loadAllSkills(cwd).find(({ name }) => name === "cached")?.description).toBe("initial");

    writeFileSync(filePath, "---\nname: cached\ndescription: changed\n---\n\n# changed\n", "utf8");
    expect(loadAllSkills(cwd).find(({ name }) => name === "cached")?.description).toBe("changed");

    rmSync(filePath, { force: true });
    expect(loadAllSkills(cwd).some(({ name }) => name === "cached")).toBe(false);
  });

  it("deduplicates a directory link by canonical skill path when the platform permits it", async () => {
    const root = tempRoot();
    const cwd = join(root, "repo");
    const skills = join(cwd, ".agents", "skills");
    mkdirSync(join(cwd, ".git"), { recursive: true });
    const target = join(root, "shared-skill");
    skill(root, "shared-skill", "linked once");
    mkdirSync(skills, { recursive: true });
    try {
      symlinkSync(target, join(skills, "linked"), process.platform === "win32" ? "junction" : "dir");
      symlinkSync(target, join(skills, "linked-again"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      // Only privilege restrictions are unavailable validation; path/junction regressions fail.
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) return;
      throw error;
    }

    const isolatedHome = join(root, "os-home");
    mkdirSync(isolatedHome, { recursive: true });
    vi.stubEnv("HOME", isolatedHome);
    vi.stubEnv("USERPROFILE", isolatedHome);
    vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent-home"));
    vi.resetModules();
    const { loadAllSkills } = await import("../../src/prompt/skill-loader.ts");
    expect(loadAllSkills(cwd).filter(({ name }) => name === "shared-skill")).toHaveLength(1);
  });
});
