#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(repoRoot, "plugins", "thomas-codex-workflows");
const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function assertInside(basePath, targetPath, label) {
  const relative = path.relative(basePath, targetPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside ${basePath}: ${targetPath}`);
  }
}

function assertRealInside(basePath, targetPath, label) {
  const baseRealPath = fs.realpathSync(basePath);
  const targetRealPath = fs.realpathSync(targetPath);
  assertInside(baseRealPath, targetRealPath, label);
  if (fs.lstatSync(targetPath).isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink: ${targetPath}`);
  }
}

function walkHooks(value, commands = []) {
  if (Array.isArray(value)) {
    for (const item of value) {
      walkHooks(item, commands);
    }
    return commands;
  }
  if (value && typeof value === "object") {
    if (typeof value.command === "string") {
      commands.push(value.command);
    }
    for (const child of Object.values(value)) {
      walkHooks(child, commands);
    }
  }
  return commands;
}

function shellScripts(dir) {
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".sh"))
    .map((name) => path.join(dir, name))
    .sort();
}

const manifest = readJson(manifestPath);
if (manifest.name !== "thomas-codex-workflows") {
  throw new Error(`${manifestPath} has unexpected plugin name ${manifest.name}`);
}
if (typeof manifest.hooks !== "string") {
  throw new Error(`${manifestPath} must declare hooks as a string path`);
}

const hooksPath = path.resolve(pluginRoot, manifest.hooks);
assertInside(pluginRoot, hooksPath, "hooks manifest");
if (!fs.existsSync(hooksPath)) {
  throw new Error(`Missing hooks manifest: ${hooksPath}`);
}
assertRealInside(pluginRoot, hooksPath, "hooks manifest");

const hooks = readJson(hooksPath);
const commands = walkHooks(hooks);
if (commands.length === 0) {
  throw new Error(`${hooksPath} does not declare any hook commands`);
}

const referenced = new Set();
for (const command of commands) {
  const matches = command.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"'\s]+)/g);
  for (const match of matches) {
    const target = path.resolve(pluginRoot, match[1]);
    assertInside(pluginRoot, target, "hook command target");
    if (!fs.existsSync(target)) {
      throw new Error(`Hook command references missing file: ${target}`);
    }
    assertRealInside(pluginRoot, target, "hook command target");
    referenced.add(target);
  }
}
if (referenced.size === 0) {
  throw new Error(`${hooksPath} does not reference plugin-local hook scripts`);
}

for (const scriptPath of shellScripts(path.join(pluginRoot, "hooks"))) {
  const result = spawnSync("/bin/bash", ["-n", scriptPath], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${scriptPath} failed bash syntax check: ${result.stderr || result.stdout}`);
  }
}

console.log(JSON.stringify({
  ok: true,
  hooks: hooksPath,
  commandCount: commands.length,
  referencedScripts: [...referenced].map((filePath) => path.relative(pluginRoot, filePath)).sort(),
  checkedScripts: shellScripts(path.join(pluginRoot, "hooks")).map((filePath) => path.relative(pluginRoot, filePath))
}, null, 2));
