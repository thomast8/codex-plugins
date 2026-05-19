#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const marketplaceName = process.env.CODEX_MARKETPLACE_NAME?.trim() || "codex-plugins";
const defaultConfigRoot = path.join(os.homedir(), ".Codex", "marketplaces", marketplaceName);
const configRoot = process.env.CODEX_CONFIG_ROOT
  ? path.resolve(process.env.CODEX_CONFIG_ROOT)
  : defaultConfigRoot;
const configPath = process.env.CODEX_CONFIG_FILE
  ? path.resolve(process.env.CODEX_CONFIG_FILE)
  : path.join(os.homedir(), ".Codex", "config.toml");
const skillsRoot = process.env.CODEX_SKILLS_ROOT
  ? path.resolve(process.env.CODEX_SKILLS_ROOT)
  : path.join(os.homedir(), ".Codex", "skills");
const marketplaceDisplayName =
  process.env.CODEX_MARKETPLACE_DISPLAY_NAME?.trim() || "Thomas Codex Plugins";
const staleMarketplaceNames = (
  process.env.CODEX_STALE_MARKETPLACES ?? "codex-azure-devops-plugin,thomas-codex-config"
)
  .split(",")
  .map((name) => name.trim())
  .filter((name) => name !== "" && name !== marketplaceName);
const selectedPluginNames = (
  process.env.CODEX_PLUGINS ?? process.env.CODEX_PLUGIN_NAME ?? ""
)
  .split(",")
  .map((name) => name.trim())
  .filter((name) => name !== "");
const installSkills = process.env.CODEX_INSTALL_SKILLS !== "false";
const selectedSkillNames = (
  process.env.CODEX_SKILLS ?? process.env.CODEX_SKILL_NAME ?? ""
)
  .split(",")
  .map((name) => name.trim())
  .filter((name) => name !== "");
const installMcpServers = process.env.CODEX_INSTALL_MCPS !== "false";
const selectedMcpServerNames = (process.env.CODEX_MCPS ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter((name) => name !== "");
const marketplacePath = path.join(configRoot, ".agents", "plugins", "marketplace.json");
const repoMarketplacePath = path.join(repoRoot, ".agents", "plugins", "marketplace.json");
const repoSkillsRoot = path.join(repoRoot, "skills");
const safeMcpServers = {
  gitnexus: {
    command: "gitnexus",
    args: ["mcp"],
  },
  "mcp-debugger": {
    command: "npx",
    args: ["-y", "@debugmcp/mcp-debugger"],
  },
};

function ensureExists(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${filePath} does not exist.`);
  }
}

function tomlString(value) {
  return JSON.stringify(value);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function upsertTomlKey(contents, table, key, value) {
  const lines = contents.split("\n");
  const header = `[${table}]`;
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  const start = lines.findIndex((line) => line.trim() === header);

  if (start === -1) {
    return `${contents.trimEnd()}\n\n${header}\n${key} = ${value}\n`;
  }

  let end = start + 1;
  while (end < lines.length && !lines[end].trimStart().startsWith("[")) {
    end += 1;
  }

  let replaced = false;
  const nextBody = [];
  for (const line of lines.slice(start + 1, end)) {
    if (!keyPattern.test(line)) {
      nextBody.push(line);
      continue;
    }
    if (!replaced) {
      nextBody.push(`${key} = ${value}`);
      replaced = true;
    }
  }

  if (!replaced) {
    nextBody.push(`${key} = ${value}`);
  }

  lines.splice(start + 1, end - start - 1, ...nextBody);
  return lines.join("\n");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function assertPluginName(pluginName) {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(pluginName)) {
    throw new Error(
      `Invalid plugin name ${JSON.stringify(pluginName)}. Use lowercase letters, numbers, dots, underscores, or hyphens.`
    );
  }
  return pluginName;
}

function pathInside(basePath, childPath) {
  const relative = path.relative(basePath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveInside(basePath, pluginName, label) {
  const resolved = path.resolve(basePath, assertPluginName(pluginName));
  if (!pathInside(basePath, resolved)) {
    throw new Error(`${label} for ${pluginName} must stay inside ${basePath}`);
  }
  return resolved;
}

function repoMarketplace() {
  return readJson(repoMarketplacePath);
}

function availablePluginNames() {
  return (repoMarketplace().plugins ?? []).map((plugin) => plugin.name);
}

function pluginsToInstall() {
  const names = [
    ...new Set(selectedPluginNames.length > 0
      ? selectedPluginNames
      : availablePluginNames()),
  ].map(assertPluginName);
  if (names.length === 0) {
    throw new Error(`${repoMarketplacePath} does not list any plugins.`);
  }
  return names;
}

function availableSkillNames() {
  if (!fs.existsSync(repoSkillsRoot)) {
    return [];
  }
  return fs
    .readdirSync(repoSkillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(repoSkillsRoot, name, "SKILL.md")))
    .sort();
}

function skillsToInstall() {
  if (!installSkills) {
    return [];
  }
  const names = [
    ...new Set(selectedSkillNames.length > 0 ? selectedSkillNames : availableSkillNames()),
  ].map(assertPluginName);
  for (const name of names) {
    if (!fs.existsSync(path.join(repoSkillsRoot, name, "SKILL.md"))) {
      throw new Error(`${repoSkillsRoot} does not contain skill ${name}.`);
    }
  }
  return names;
}

function mcpServersToInstall() {
  if (!installMcpServers) {
    return [];
  }
  const names = selectedMcpServerNames.length > 0
    ? [...new Set(selectedMcpServerNames)]
    : Object.keys(safeMcpServers);
  for (const name of names) {
    if (!Object.hasOwn(safeMcpServers, name)) {
      throw new Error(`Unknown safe MCP server ${JSON.stringify(name)}.`);
    }
  }
  return names;
}

function pluginKey(pluginName) {
  return `${pluginName}@${marketplaceName}`;
}

function stalePluginKeys(pluginName) {
  return [...new Set(staleMarketplaceNames)].map(
    (name) => `${pluginName}@${name}`
  );
}

function pluginSource(pluginName) {
  return resolveInside(path.join(repoRoot, "plugins"), pluginName, "Plugin source");
}

function skillSource(skillName) {
  return resolveInside(repoSkillsRoot, skillName, "Skill source");
}

function ensurePluginRoot(pluginName) {
  const pluginsRoot = path.join(repoRoot, "plugins");
  const root = pluginSource(pluginName);
  ensureExists(root);
  const rootLinkStat = fs.lstatSync(root);
  if (rootLinkStat.isSymbolicLink()) {
    throw new Error(`${root} must not be a symlink.`);
  }
  if (!rootLinkStat.isDirectory()) {
    throw new Error(`${root} must be a directory.`);
  }
  const pluginsRootRealPath = fs.realpathSync(pluginsRoot);
  const rootRealPath = fs.realpathSync(root);
  if (!pathInside(pluginsRootRealPath, rootRealPath)) {
    throw new Error(`${root} must stay inside ${pluginsRoot}.`);
  }
  return root;
}

function ensureSkillRoot(skillName) {
  const root = skillSource(skillName);
  ensureExists(root);
  const rootLinkStat = fs.lstatSync(root);
  if (rootLinkStat.isSymbolicLink()) {
    throw new Error(`${root} must not be a symlink.`);
  }
  if (!rootLinkStat.isDirectory()) {
    throw new Error(`${root} must be a directory.`);
  }
  const skillsRootRealPath = fs.realpathSync(repoSkillsRoot);
  const rootRealPath = fs.realpathSync(root);
  if (!pathInside(skillsRootRealPath, rootRealPath)) {
    throw new Error(`${root} must stay inside ${repoSkillsRoot}.`);
  }
  const skillPath = path.join(root, "SKILL.md");
  ensureExists(skillPath);
  if (fs.lstatSync(skillPath).isSymbolicLink()) {
    throw new Error(`${skillPath} must not be a symlink.`);
  }
  return root;
}

function pluginLink(pluginName) {
  return resolveInside(path.join(configRoot, "plugins"), pluginName, "Plugin link");
}

function skillLink(skillName) {
  return resolveInside(skillsRoot, skillName, "Skill link");
}

function repoMarketplaceEntry(pluginName) {
  const marketplace = readJson(repoMarketplacePath);
  const entry = marketplace.plugins?.find((plugin) => plugin.name === pluginName);
  if (entry === undefined) {
    throw new Error(`${repoMarketplacePath} does not contain plugin ${pluginName}.`);
  }
  return JSON.parse(JSON.stringify(entry));
}

const manifestEntryTypes = {
  mcpServers: "file",
  hooks: "file",
  skills: "directory",
};

function resolveManifestPath(root, manifestPath, key) {
  if (typeof manifestPath !== "string" || manifestPath.trim() === "") {
    throw new Error(`${key} must be a non-empty string path.`);
  }
  const resolved = path.resolve(root, manifestPath);
  if (!pathInside(root, resolved)) {
    throw new Error(`${key} path ${manifestPath} must stay inside ${root}.`);
  }
  ensureExists(resolved);
  const rootRealPath = fs.realpathSync(root);
  const resolvedRealPath = fs.realpathSync(resolved);
  if (!pathInside(rootRealPath, resolvedRealPath)) {
    throw new Error(`${key} path ${manifestPath} must stay inside ${root}.`);
  }
  const linkStat = fs.lstatSync(resolved);
  if (linkStat.isSymbolicLink()) {
    throw new Error(`${key} path ${manifestPath} must not be a symlink.`);
  }
  const stat = fs.statSync(resolved);
  const expectedType = manifestEntryTypes[key];
  if (expectedType === "file" && !stat.isFile()) {
    throw new Error(`${key} path ${manifestPath} must point to a file.`);
  }
  if (expectedType === "directory" && !stat.isDirectory()) {
    throw new Error(`${key} path ${manifestPath} must point to a directory.`);
  }
  return resolved;
}

function ensurePluginShape(pluginName) {
  const root = ensurePluginRoot(pluginName);
  const metadataDir = path.join(root, ".codex-plugin");
  ensureExists(metadataDir);
  if (fs.lstatSync(metadataDir).isSymbolicLink()) {
    throw new Error(`${metadataDir} must not be a symlink.`);
  }
  const manifestPath = path.join(root, ".codex-plugin", "plugin.json");
  ensureExists(manifestPath);
  if (fs.lstatSync(manifestPath).isSymbolicLink()) {
    throw new Error(`${manifestPath} must not be a symlink.`);
  }
  const manifest = readJson(manifestPath);
  if (manifest.name !== pluginName) {
    throw new Error(`${manifestPath} name must be ${pluginName}.`);
  }
  let hasEntryPoint = false;
  for (const key of Object.keys(manifestEntryTypes)) {
    if (manifest[key] === undefined) {
      continue;
    }
    resolveManifestPath(root, manifest[key], key);
    hasEntryPoint = true;
  }
  if (!hasEntryPoint) {
    throw new Error(`${manifestPath} must declare at least one of mcpServers, hooks, or skills.`);
  }
}

function writeJsonIfChanged(filePath, value) {
  const next = `${JSON.stringify(value, null, 2)}\n`;
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") === next) {
    return false;
  }
  fs.writeFileSync(filePath, next, "utf8");
  return true;
}

function inspectPluginLink(pluginName) {
  const source = pluginSource(pluginName);
  const link = pluginLink(pluginName);

  if (!fs.existsSync(link)) {
    return "created";
  }

  const stat = fs.lstatSync(link);
  if (stat.isSymbolicLink() && fs.realpathSync(link) === fs.realpathSync(source)) {
    return "already-present";
  }

  throw new Error(`${link} already exists and does not point to ${source}`);
}

function inspectSkillLink(skillName) {
  const source = skillSource(skillName);
  const link = skillLink(skillName);

  if (!fs.existsSync(link)) {
    return "created";
  }

  const stat = fs.lstatSync(link);
  if (stat.isSymbolicLink() && fs.realpathSync(link) === fs.realpathSync(source)) {
    return "already-present";
  }

  throw new Error(`${link} already exists and does not point to ${source}`);
}

function createPluginLink(pluginName, status) {
  if (status !== "created") {
    return;
  }
  const source = pluginSource(pluginName);
  const link = pluginLink(pluginName);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(source, link, "dir");
}

function createSkillLink(skillName, status) {
  if (status !== "created") {
    return;
  }
  const source = skillSource(skillName);
  const link = skillLink(skillName);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(source, link, "dir");
}

function ensureMarketplaceEntries(pluginNames) {
  fs.mkdirSync(path.dirname(marketplacePath), { recursive: true });

  const marketplace = fs.existsSync(marketplacePath)
    ? readJson(marketplacePath)
    : {
        name: marketplaceName,
        interface: { displayName: marketplaceDisplayName },
        plugins: [],
      };

  marketplace.name = marketplaceName;
  marketplace.interface ??= { displayName: marketplaceDisplayName };
  marketplace.plugins ??= [];

  const statuses = [];
  for (const pluginName of pluginNames) {
    const entry = repoMarketplaceEntry(pluginName);
    const existing = marketplace.plugins.find((plugin) => plugin.name === pluginName);
    if (existing) {
      Object.assign(existing, entry);
    } else {
      marketplace.plugins.push(entry);
    }
    statuses.push({ pluginName, status: existing ? "updated" : "added" });
  }

  const changed = writeJsonIfChanged(marketplacePath, marketplace);
  return statuses.map(({ pluginName, status }) => ({
    pluginName,
    status: changed ? status : "already-present"
  }));
}

function upsertMcpServers(contents, mcpServerNames) {
  let updated = contents;
  for (const name of mcpServerNames) {
    const server = safeMcpServers[name];
    updated = upsertTomlKey(
      updated,
      `mcp_servers.${name}`,
      "command",
      tomlString(server.command)
    );
    updated = upsertTomlKey(
      updated,
      `mcp_servers.${name}`,
      "args",
      JSON.stringify(server.args)
    );
  }
  return updated;
}

ensureExists(repoMarketplacePath);
ensureExists(configPath);

const pluginNames = pluginsToInstall();
for (const pluginName of pluginNames) {
  ensurePluginShape(pluginName);
}
const skillNames = skillsToInstall();
for (const skillName of skillNames) {
  ensureSkillRoot(skillName);
}
const mcpServerNames = mcpServersToInstall();

const linkStatuses = pluginNames.map((pluginName) => ({
  pluginName,
  status: inspectPluginLink(pluginName)
}));
const skillLinkStatuses = skillNames.map((skillName) => ({
  skillName,
  status: inspectSkillLink(skillName)
}));
const marketplaceStatuses = ensureMarketplaceEntries(pluginNames);
for (const { pluginName, status } of linkStatuses) {
  createPluginLink(pluginName, status);
}
for (const { skillName, status } of skillLinkStatuses) {
  createSkillLink(skillName, status);
}
const original = fs.readFileSync(configPath, "utf8");
let updated = original;

updated = upsertTomlKey(
  updated,
  `marketplaces.${marketplaceName}`,
  "source",
  tomlString(configRoot)
);
updated = upsertTomlKey(
  updated,
  `marketplaces.${marketplaceName}`,
  "source_type",
  '"local"'
);
for (const pluginName of pluginNames) {
  updated = upsertTomlKey(
    updated,
    `plugins.${tomlString(pluginKey(pluginName))}`,
    "enabled",
    "true"
  );
  for (const stalePluginKey of stalePluginKeys(pluginName)) {
    updated = upsertTomlKey(
      updated,
      `plugins.${tomlString(stalePluginKey)}`,
      "enabled",
      "false"
    );
  }
}
updated = upsertMcpServers(updated, mcpServerNames);

if (updated === original) {
  console.log("Codex config already has the selected marketplace plugins and MCP servers.");
} else {
  if (!fs.statSync(configPath).isFile()) {
    throw new Error(`${configPath} is not a regular file.`);
  }
  const backupPath = `${configPath}.bak-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}`;
  fs.copyFileSync(configPath, backupPath);
  fs.chmodSync(backupPath, 0o600);
  fs.writeFileSync(configPath, updated, "utf8");
  console.log(`Updated ${configPath}`);
  console.log(`Backup written to ${backupPath}`);
}

console.log(`Config root: ${configRoot}`);
for (const { pluginName, status } of linkStatuses) {
  console.log(`Plugin link: ${pluginLink(pluginName)} (${status})`);
}
for (const { pluginName, status } of marketplaceStatuses) {
  console.log(`Marketplace entry: ${marketplacePath} ${pluginName} (${status})`);
}
for (const { skillName, status } of skillLinkStatuses) {
  console.log(`Skill link: ${skillLink(skillName)} (${status})`);
}
console.log(`Marketplace: ${marketplaceName}`);
console.log(`Plugins: ${pluginNames.map(pluginKey).join(", ")}`);
if (skillNames.length > 0) {
  console.log(`Skills: ${skillNames.join(", ")}`);
}
if (mcpServerNames.length > 0) {
  console.log(`MCP servers: ${mcpServerNames.join(", ")}`);
}
const disabledStaleKeys = pluginNames.flatMap(stalePluginKeys);
if (disabledStaleKeys.length > 0) {
  console.log(`Disabled stale plugin entries: ${disabledStaleKeys.join(", ")}`);
}
console.log("Restart or reload Codex so the app picks up the new local marketplace.");
