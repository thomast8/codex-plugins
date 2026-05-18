#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultConfigRoot = path.join(
  os.homedir(),
  "Library",
  "Mobile Documents",
  "com~apple~CloudDocs",
  "Codex-config"
);
const configRoot = process.env.CODEX_CONFIG_ROOT
  ? path.resolve(process.env.CODEX_CONFIG_ROOT)
  : defaultConfigRoot;
const configPath = process.env.CODEX_CONFIG_FILE
  ? path.resolve(process.env.CODEX_CONFIG_FILE)
  : path.join(os.homedir(), ".Codex", "config.toml");
const marketplaceName = process.env.CODEX_MARKETPLACE_NAME?.trim() || "codex-plugins";
const marketplaceDisplayName =
  process.env.CODEX_MARKETPLACE_DISPLAY_NAME?.trim() || "Thomas Codex Plugins";
const staleMarketplaceNames = (
  process.env.CODEX_STALE_MARKETPLACES ?? "codex-azure-devops-plugin,thomas-codex-config"
)
  .split(",")
  .map((name) => name.trim())
  .filter((name) => name !== "" && name !== marketplaceName);
const pluginName = "azure-devops";
const pluginKey = `${pluginName}@${marketplaceName}`;
const stalePluginKeys = [...new Set(staleMarketplaceNames)].map(
  (name) => `${pluginName}@${name}`
);
const pluginSource = path.join(repoRoot, "plugins", pluginName);
const pluginLink = path.join(configRoot, "plugins", pluginName);
const marketplacePath = path.join(configRoot, ".agents", "plugins", "marketplace.json");
const repoMarketplacePath = path.join(repoRoot, ".agents", "plugins", "marketplace.json");

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

function repoMarketplaceEntry() {
  const marketplace = readJson(repoMarketplacePath);
  const entry = marketplace.plugins?.find((plugin) => plugin.name === pluginName);
  if (entry === undefined) {
    throw new Error(`${repoMarketplacePath} does not contain plugin ${pluginName}.`);
  }
  return JSON.parse(JSON.stringify(entry));
}

function writeJsonIfChanged(filePath, value) {
  const next = `${JSON.stringify(value, null, 2)}\n`;
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") === next) {
    return false;
  }
  fs.writeFileSync(filePath, next, "utf8");
  return true;
}

function ensurePluginLink() {
  fs.mkdirSync(path.dirname(pluginLink), { recursive: true });

  if (!fs.existsSync(pluginLink)) {
    fs.symlinkSync(pluginSource, pluginLink, "dir");
    return "created";
  }

  const stat = fs.lstatSync(pluginLink);
  if (stat.isSymbolicLink() && fs.realpathSync(pluginLink) === fs.realpathSync(pluginSource)) {
    return "already-present";
  }

  throw new Error(`${pluginLink} already exists and does not point to ${pluginSource}`);
}

function ensureMarketplaceEntry() {
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

  const entry = repoMarketplaceEntry();

  const existing = marketplace.plugins.find((plugin) => plugin.name === pluginName);
  if (existing) {
    Object.assign(existing, entry);
  } else {
    marketplace.plugins.push(entry);
  }

  const changed = writeJsonIfChanged(marketplacePath, marketplace);
  if (!existing) {
    return "added";
  }
  return changed ? "updated" : "already-present";
}

ensureExists(repoMarketplacePath);
ensureExists(path.join(pluginSource, ".codex-plugin", "plugin.json"));
ensureExists(path.join(pluginSource, ".mcp.json"));
ensureExists(path.join(pluginSource, "dist", "index.bundle.js"));
ensureExists(configPath);

const linkStatus = ensurePluginLink();
const marketplaceStatus = ensureMarketplaceEntry();
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
updated = upsertTomlKey(updated, `plugins.${tomlString(pluginKey)}`, "enabled", "true");
for (const stalePluginKey of stalePluginKeys) {
  updated = upsertTomlKey(
    updated,
    `plugins.${tomlString(stalePluginKey)}`,
    "enabled",
    "false"
  );
}

if (updated === original) {
  console.log("Azure DevOps plugin is already registered in Codex.");
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
console.log(`Plugin link: ${pluginLink} (${linkStatus})`);
console.log(`Marketplace entry: ${marketplacePath} (${marketplaceStatus})`);
console.log(`Marketplace: ${marketplaceName}`);
console.log(`Plugin: ${pluginKey}`);
if (stalePluginKeys.length > 0) {
  console.log(`Disabled stale plugin entries: ${stalePluginKeys.join(", ")}`);
}
console.log("Restart or reload Codex so the app picks up the new local marketplace.");
