import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { ensureGitNexusWorktreeIndex, isLinkedWorktree } from "./gitnexus-worktree-index.mjs";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function git(repoPath, args) {
  return run("git", ["-C", repoPath, ...args]);
}

function initRepo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gitnexus-worktree-index-spec-"));
  const repoPath = path.join(tmp, "repo");
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(repoPath, "README.md"), "# Example\n", "utf8");
  git(repoPath, ["add", "README.md"]);
  git(repoPath, [
    "-c",
    "user.name=Codex Spec",
    "-c",
    "user.email=codex@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "initial",
  ]);
  return { tmp, repoPath };
}

function writeFakeIndex(repoPath, lastCommit) {
  const indexPath = path.join(repoPath, ".gitnexus");
  fs.mkdirSync(indexPath, { recursive: true });
  fs.writeFileSync(path.join(indexPath, "lbug"), "fake ladybug db\n", "utf8");
  fs.writeFileSync(
    path.join(indexPath, "meta.json"),
    `${JSON.stringify(
      {
        repoPath,
        lastCommit,
        indexedAt: "2026-05-14T00:00:00.000Z",
        stats: { files: 1, nodes: 1, edges: 0, communities: 0, processes: 0, embeddings: 0 },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function withEnv(name, value, fn) {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

test("reuses an exact-match GitNexus index from the main worktree", () => {
  const { tmp, repoPath } = initRepo();
  const head = git(repoPath, ["rev-parse", "HEAD"]);
  writeFakeIndex(repoPath, head);

  const worktreePath = path.join(tmp, "feature-reuse");
  git(repoPath, ["worktree", "add", "-b", "feature/reuse", worktreePath, "HEAD"]);
  const homeDir = path.join(tmp, "home");

  const result = withEnv("GITNEXUS_WORKTREE_SKIP_LBUG_PROBE", "1", () =>
    ensureGitNexusWorktreeIndex({ repoPath: worktreePath, sourceRoot: repoPath, homeDir }),
  );

  assert.equal(result.status, "reused");
  assert.ok(fs.existsSync(path.join(worktreePath, ".gitnexus", "lbug")));
  assert.equal(readJson(path.join(worktreePath, ".gitnexus", "meta.json")).repoPath, worktreePath);

  const registry = readJson(path.join(homeDir, ".gitnexus", "registry.json"));
  assert.equal(registry.length, 1);
  assert.equal(registry[0].path, worktreePath);
});

test("does not reuse an exact-match index when the LadybugDB probe fails", () => {
  const { tmp, repoPath } = initRepo();
  const head = git(repoPath, ["rev-parse", "HEAD"]);
  writeFakeIndex(repoPath, head);

  const worktreePath = path.join(tmp, "feature-unusable");
  git(repoPath, ["worktree", "add", "-b", "feature/unusable", worktreePath, "HEAD"]);

  const result = ensureGitNexusWorktreeIndex({
    repoPath: worktreePath,
    sourceRoot: repoPath,
    homeDir: path.join(tmp, "home"),
  });

  assert.equal(result.status, "deferred");
  assert.ok(!fs.existsSync(path.join(worktreePath, ".gitnexus", "lbug")));
});

test("defers linked worktree indexing when a stale local index already exists", () => {
  const { tmp, repoPath } = initRepo();
  const head = git(repoPath, ["rev-parse", "HEAD"]);
  writeFakeIndex(repoPath, head);

  const worktreePath = path.join(tmp, "feature-stale");
  git(repoPath, ["worktree", "add", "-b", "feature/stale", worktreePath, "HEAD"]);
  writeFakeIndex(worktreePath, "0000000000000000000000000000000000000000");

  const result = ensureGitNexusWorktreeIndex({
    repoPath: worktreePath,
    sourceRoot: repoPath,
    homeDir: path.join(tmp, "home"),
  });

  assert.equal(result.status, "deferred");
  assert.equal(
    readJson(path.join(worktreePath, ".gitnexus", "meta.json")).lastCommit,
    "0000000000000000000000000000000000000000",
  );
});

test("does not defer a main checkout that needs analysis", () => {
  const { repoPath } = initRepo();

  const result = ensureGitNexusWorktreeIndex({ repoPath });

  assert.equal(isLinkedWorktree(repoPath), false);
  assert.equal(result.status, "needs-analyze");
});
