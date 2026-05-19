#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const marketplacePath = path.join(repoRoot, ".agents", "plugins", "marketplace.json");

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function stringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function sorted(value) {
  return [...value].sort((a, b) => a.localeCompare(b));
}

function assertSameSet(label, actual, expected) {
  const actualSorted = sorted(actual);
  const expectedSorted = sorted(expected);
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    fail(
      `${label} must be ${JSON.stringify(expectedSorted)}, found ${JSON.stringify(actualSorted)}.`
    );
  }
}

function skillNames(pluginRoot, manifest) {
  if (manifest.skills === undefined) {
    return [];
  }
  const skillsRoot = path.resolve(pluginRoot, manifest.skills);
  return fs
    .readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(skillsRoot, name, "SKILL.md")));
}

function mcpServerNames(pluginRoot, manifest) {
  if (manifest.mcpServers === undefined) {
    return [];
  }
  const mcpPath = path.resolve(pluginRoot, manifest.mcpServers);
  return Object.keys(readJson(mcpPath));
}

function hookNames(pluginRoot, manifest) {
  if (manifest.hooks === undefined) {
    return [];
  }
  const hooksPath = path.resolve(pluginRoot, manifest.hooks);
  return Object.keys(readJson(hooksPath).hooks ?? {});
}

function validateDescriptor(pluginRoot, marketplaceName) {
  const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
  const descriptorPath = path.join(pluginRoot, "plugin.descriptor.json");
  if (!fs.existsSync(descriptorPath)) {
    fail(`${path.relative(repoRoot, pluginRoot)} is missing plugin.descriptor.json.`);
    return;
  }

  const manifest = readJson(manifestPath);
  const descriptor = readJson(descriptorPath);
  const label = `${marketplaceName}/${manifest.name}`;

  if (descriptor.schemaVersion !== 1) {
    fail(`${label}: schemaVersion must be 1.`);
  }
  if (descriptor.name !== manifest.name) {
    fail(`${label}: descriptor name must match plugin.json name.`);
  }
  if (descriptor.displayName !== manifest.interface?.displayName) {
    fail(`${label}: displayName must match plugin.json interface.displayName.`);
  }
  if (typeof descriptor.summary !== "string" || descriptor.summary.length < 30) {
    fail(`${label}: summary must explain the plugin in at least 30 characters.`);
  }
  if (typeof descriptor.purpose !== "string" || descriptor.purpose.length < 60) {
    fail(`${label}: purpose must explain the plugin in at least 60 characters.`);
  }
  if (!stringArray(descriptor.whenToUse) || descriptor.whenToUse.length === 0) {
    fail(`${label}: whenToUse must be a non-empty string array.`);
  }

  const surfaces = descriptor.surfaces ?? {};
  if (!stringArray(surfaces.skills) || !stringArray(surfaces.mcpServers) || !stringArray(surfaces.hooks)) {
    fail(`${label}: surfaces.skills, surfaces.mcpServers, and surfaces.hooks must be string arrays.`);
  } else {
    assertSameSet(`${label}: surfaces.skills`, surfaces.skills, skillNames(pluginRoot, manifest));
    assertSameSet(
      `${label}: surfaces.mcpServers`,
      surfaces.mcpServers,
      mcpServerNames(pluginRoot, manifest)
    );
    assertSameSet(`${label}: surfaces.hooks`, surfaces.hooks, hookNames(pluginRoot, manifest));
  }

  const safety = descriptor.safety ?? {};
  if (safety.publicSafe !== true) {
    fail(`${label}: safety.publicSafe must be true.`);
  }
  for (const key of ["authModel", "writeModel"]) {
    if (typeof safety[key] !== "string" || safety[key].length < 20) {
      fail(`${label}: safety.${key} must be a useful string.`);
    }
  }
  if (!stringArray(safety.excludedState) || safety.excludedState.length === 0) {
    fail(`${label}: safety.excludedState must be a non-empty string array.`);
  }
  if (!stringArray(descriptor.installNotes) || descriptor.installNotes.length === 0) {
    fail(`${label}: installNotes must be a non-empty string array.`);
  }
}

const marketplace = readJson(marketplacePath);
for (const plugin of marketplace.plugins ?? []) {
  if (plugin.source?.source !== "local" || typeof plugin.source.path !== "string") {
    fail(`${plugin.name}: only local marketplace entries are supported.`);
    continue;
  }
  validateDescriptor(path.resolve(repoRoot, plugin.source.path), marketplace.name);
}

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log(`Verified ${(marketplace.plugins ?? []).length} plugin descriptors.`);
