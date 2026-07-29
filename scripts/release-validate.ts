import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
const version = packageJson.version;
const releaseTag = process.env.RELEASE_TAG;
const releaseHeading = new RegExp(
  `^## \\[${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\] - \\d{4}-\\d{2}-\\d{2}$`,
  "m",
);

if (!releaseHeading.test(changelog)) {
  throw new Error(`CHANGELOG.md must contain a dated ## [${version}] release heading.`);
}

if (releaseTag !== undefined && releaseTag !== `v${version}`) {
  throw new Error(`Release tag ${releaseTag} does not match package version ${version}.`);
}

console.log(`Release metadata is valid for v${version}.`);
