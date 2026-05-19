#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function runGit(repoPath, args) {
  return spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
  });
}

function gitOutput(repoPath, args) {
  const result = runGit(repoPath, args);
  return result.status === 0 ? result.stdout.trim() : "";
}

function realpathMaybe(value) {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function samePath(left, right) {
  return realpathMaybe(left) === realpathMaybe(right);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function indexDir(repoPath) {
  return path.join(repoPath, ".gitnexus");
}

function indexMeta(repoPath) {
  return readJson(path.join(indexDir(repoPath), "meta.json"));
}

function hasStableLbug(indexPath) {
  return (
    fs.existsSync(path.join(indexPath, "lbug")) &&
    !fs.existsSync(path.join(indexPath, "lbug.lock")) &&
    !fs.existsSync(path.join(indexPath, "lbug.wal"))
  );
}

function findGitNexusPackageRoot() {
  const pathEntries = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, "gitnexus");
    if (!fs.existsSync(candidate)) {
      continue;
    }
    try {
      const real = fs.realpathSync.native(candidate);
      if (real.endsWith(path.join("dist", "cli", "index.js"))) {
        return path.dirname(path.dirname(path.dirname(real)));
      }
    } catch {
      // Try the next PATH entry.
    }
  }
  return null;
}

function lbugResponds(indexPath) {
  if (process.env.GITNEXUS_WORKTREE_SKIP_LBUG_PROBE === "1") {
    return true;
  }

  const gitnexusRoot = findGitNexusPackageRoot();
  if (!gitnexusRoot) {
    return true;
  }

  const coreModule = path.join(gitnexusRoot, "node_modules", "@ladybugdb", "core", "index.mjs");
  if (!fs.existsSync(coreModule)) {
    return true;
  }

  const dbPath = path.join(indexPath, "lbug");
  const script = `
import lbug from ${JSON.stringify(coreModule)};
const db = new lbug.Database(process.argv[1], 0, false, true);
const conn = new lbug.Connection(db);
const result = await conn.query("RETURN 1 AS ok");
await result.getAll();
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, dbPath], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  if (process.env.GITNEXUS_WORKTREE_DEBUG === "1" && result.status !== 0) {
    const detail = result.signal || result.stderr.trim() || `exit ${result.status}`;
    process.stderr.write(`GitNexus worktree preflight: unusable lbug ${dbPath}: ${detail}\n`);
  }
  return result.status === 0;
}

function hasUsableLbug(indexPath) {
  return hasStableLbug(indexPath) && lbugResponds(indexPath);
}

export function isLinkedWorktree(repoPath) {
  const gitDir = gitOutput(repoPath, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const commonDir = gitOutput(repoPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return Boolean(gitDir && commonDir && path.resolve(gitDir) !== path.resolve(commonDir));
}

export function listWorktrees(repoPath) {
  const output = gitOutput(repoPath, ["worktree", "list", "--porcelain"]);
  const worktrees = [];
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      worktrees.push(line.slice("worktree ".length));
    }
  }
  return worktrees;
}

function uniquePaths(paths) {
  const seen = new Set();
  const unique = [];
  for (const candidate of paths.filter(Boolean).map((item) => path.resolve(item))) {
    const key = realpathMaybe(candidate);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(candidate);
    }
  }
  return unique;
}

export function findReusableIndex({ repoPath, sourceRoot, headSha }) {
  const candidates = uniquePaths([sourceRoot, ...listWorktrees(repoPath)]);
  for (const candidate of candidates) {
    if (samePath(candidate, repoPath)) {
      continue;
    }

    const candidateIndex = indexDir(candidate);
    const meta = readJson(path.join(candidateIndex, "meta.json"));
    if (meta?.lastCommit === headSha && hasUsableLbug(candidateIndex)) {
      return { repoPath: candidate, indexPath: candidateIndex, meta };
    }
  }
  return null;
}

export function registerGitNexusRepo(repoPath, meta, homeDir = os.homedir()) {
  if (!meta?.lastCommit) {
    return;
  }

  const registryPath = path.join(homeDir, ".gitnexus", "registry.json");
  const existing = readJson(registryPath);
  const entries = Array.isArray(existing) ? existing : [];
  const resolvedRepo = path.resolve(repoPath);
  const entry = {
    name: path.basename(resolvedRepo),
    path: resolvedRepo,
    storagePath: indexDir(resolvedRepo),
    indexedAt: meta.indexedAt,
    lastCommit: meta.lastCommit,
    stats: meta.stats,
  };

  const index = entries.findIndex((candidate) => path.resolve(candidate.path) === resolvedRepo);
  if (index >= 0) {
    entries[index] = entry;
  } else {
    entries.push(entry);
  }

  writeJson(registryPath, entries);
}

function copyReusableIndex(source, repoPath) {
  const destination = indexDir(repoPath);
  if (fs.existsSync(destination)) {
    return null;
  }

  fs.cpSync(source.indexPath, destination, {
    recursive: true,
    errorOnExist: true,
    filter: (sourcePath) => !sourcePath.endsWith(".lock"),
  });

  const meta = indexMeta(repoPath) ?? source.meta;
  const updatedMeta = {
    ...meta,
    repoPath: path.resolve(repoPath),
  };
  writeJson(path.join(destination, "meta.json"), updatedMeta);
  return updatedMeta;
}

function quarantineIndex(indexPath) {
  if (!fs.existsSync(indexPath)) {
    return null;
  }

  const stamp = new Date().toISOString().replace(/[^0-9TZ]/g, "");
  let destination = `${indexPath}.quarantine-${stamp}`;
  let suffix = 2;
  while (fs.existsSync(destination)) {
    destination = `${indexPath}.quarantine-${stamp}-${suffix}`;
    suffix += 1;
  }
  fs.renameSync(indexPath, destination);
  return destination;
}

function replaceWithReusableIndex(source, repoPath) {
  const destination = indexDir(repoPath);
  const quarantined = quarantineIndex(destination);
  const meta = copyReusableIndex(source, repoPath);
  return meta ? { meta, quarantined } : null;
}

export function ensureGitNexusWorktreeIndex({ repoPath = process.cwd(), sourceRoot, homeDir = os.homedir() } = {}) {
  const resolvedRepo = path.resolve(repoPath);
  const headSha = gitOutput(resolvedRepo, ["rev-parse", "HEAD"]);
  if (!headSha) {
    return { status: "skipped", message: "skipped (not a git repo)" };
  }

  const currentIndex = indexDir(resolvedRepo);
  const currentMeta = indexMeta(resolvedRepo);
  if (currentMeta?.lastCommit === headSha && hasUsableLbug(currentIndex)) {
    const updatedMeta = { ...currentMeta, repoPath: resolvedRepo };
    try {
      writeJson(path.join(currentIndex, "meta.json"), updatedMeta);
    } catch {
      // A read-only current index is still usable. Do not fall through to
      // analysis just because metadata normalization was blocked.
    }
    try {
      registerGitNexusRepo(resolvedRepo, updatedMeta, homeDir);
    } catch {
      // Same principle as above: registry refresh is nice, not worth a reindex.
    }
    return { status: "current", message: "already current" };
  }

  const reusable = findReusableIndex({ repoPath: resolvedRepo, sourceRoot, headSha });
  if (reusable) {
    const replacement = fs.existsSync(currentIndex)
      ? replaceWithReusableIndex(reusable, resolvedRepo)
      : { meta: copyReusableIndex(reusable, resolvedRepo), quarantined: null };
    if (replacement?.meta) {
      registerGitNexusRepo(resolvedRepo, replacement.meta, homeDir);
      const quarantineNote = replacement.quarantined
        ? `; quarantined previous index at ${replacement.quarantined}`
        : "";
      return {
        status: "reused",
        message: `reused index from ${reusable.repoPath}${quarantineNote}`,
        source: reusable.repoPath,
        quarantined: replacement.quarantined,
      };
    }
  }

  if (isLinkedWorktree(resolvedRepo)) {
    return {
      status: "deferred",
      message: `deferred (no reusable index for ${headSha.slice(0, 7)}; run gitnexus analyze --embeddings --skip-agents-md when graph is needed)`,
    };
  }

  return {
    status: "needs-analyze",
    message: "stale or missing index - run gitnexus analyze --embeddings --skip-agents-md",
  };
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo") {
      options.repoPath = argv[(i += 1)];
    } else if (arg === "--source") {
      options.sourceRoot = argv[(i += 1)];
    } else if (arg === "--home") {
      options.homeDir = argv[(i += 1)];
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = ensureGitNexusWorktreeIndex(options);
    process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : `${result.message}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && samePath(fileURLToPath(import.meta.url), process.argv[1])) {
  main();
}
