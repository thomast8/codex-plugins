#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = path.join(repoRoot, "skills");
const archivedSkillsRoot = path.join(repoRoot, "archived-skills");

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function skillDirs(root, { includeArchived = false } = {}) {
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({
      name: entry.name,
      root: path.join(root, entry.name),
      includeArchived,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function parseFrontmatterName(contents) {
  const match = contents.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) {
    return null;
  }
  const nameMatch = match[1].match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m);
  return nameMatch?.[1]?.trim() ?? null;
}

function parseFrontmatterDescription(contents) {
  const match = contents.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) {
    return null;
  }
  const descriptionMatch = match[1].match(/^description:\s*(.+)\s*$/m);
  return descriptionMatch?.[1]?.trim() ?? null;
}

const activeSkills = skillDirs(skillsRoot);
const archivedSkills = skillDirs(archivedSkillsRoot, { includeArchived: true });

for (const skill of [...activeSkills, ...archivedSkills]) {
  const skillPath = path.join(skill.root, "SKILL.md");
  if (!fs.existsSync(skillPath)) {
    fail(`${path.relative(repoRoot, skill.root)} is missing SKILL.md.`);
    continue;
  }
  const contents = fs.readFileSync(skillPath, "utf8");
  const frontmatterName = parseFrontmatterName(contents);
  const description = parseFrontmatterDescription(contents);
  if (frontmatterName !== skill.name) {
    fail(
      `${path.relative(repoRoot, skillPath)} frontmatter name must be ${skill.name}, found ${JSON.stringify(frontmatterName)}.`
    );
  }
  if (!description || description.length < 20) {
    fail(`${path.relative(repoRoot, skillPath)} needs a useful description.`);
  }
}

if (activeSkills.length === 0) {
  fail("No active skills found under skills/.");
}

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(
  `Verified ${activeSkills.length} active skills and ${archivedSkills.length} archived skills.`
);
