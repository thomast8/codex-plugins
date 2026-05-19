#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = path.join(repoRoot, "skills");
const archivedSkillsRoot = path.join(repoRoot, "archived-skills");
const pluginSkillsRoot = path.join(
  repoRoot,
  "plugins",
  "thomas-codex-skills",
  "skills"
);

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

function relativeSkillFiles(root, { skipHiddenRootDirs = false } = {}) {
  const files = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(root, fullPath);
      if (entry.name.startsWith(".")) {
        if (skipHiddenRootDirs && dir === root && entry.isDirectory()) {
          continue;
        }
        fail(`${relativePath} must not be a hidden file or directory.`);
        continue;
      }
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        fail(`${relativePath} must not be a symlink.`);
        continue;
      }
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  }

  walk(root);
  return files.sort();
}

function verifyPluginSkillMirror() {
  if (!fs.existsSync(pluginSkillsRoot)) {
    fail("plugins/thomas-codex-skills/skills is missing.");
    return;
  }

  const sourceFiles = relativeSkillFiles(skillsRoot, { skipHiddenRootDirs: true });
  const mirrorFiles = relativeSkillFiles(pluginSkillsRoot);
  const sourceSet = new Set(sourceFiles);
  const mirrorSet = new Set(mirrorFiles);

  for (const filePath of sourceFiles) {
    if (!mirrorSet.has(filePath)) {
      fail(`plugins/thomas-codex-skills/skills is missing ${filePath}.`);
      continue;
    }
    const source = fs.readFileSync(path.join(skillsRoot, filePath));
    const mirror = fs.readFileSync(path.join(pluginSkillsRoot, filePath));
    if (!source.equals(mirror)) {
      fail(`plugins/thomas-codex-skills/skills/${filePath} differs from skills/${filePath}.`);
    }
  }

  for (const filePath of mirrorFiles) {
    if (!sourceSet.has(filePath)) {
      fail(`plugins/thomas-codex-skills/skills contains extra file ${filePath}.`);
    }
  }
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

verifyPluginSkillMirror();

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(
  `Verified ${activeSkills.length} active skills, ${archivedSkills.length} archived skills, and the Thomas Codex Skills plugin mirror.`
);
