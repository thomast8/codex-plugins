import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildInitializeRequest,
  buildStableWorktreeId,
  buildThreadResumeRequest,
  buildWorktreePath,
  classifyRebindResult,
  companionStateDir,
  discoverEndpointCandidates,
  normalizeEndpoint,
  resolveCodexHome,
} from "./rebind-current-thread.mjs";

test("buildWorktreePath uses a stable id under codex worktrees", () => {
  const sourceRoot = path.join(os.tmpdir(), "ExampleRepo");
  const branch = "feature/native-spreadsheet-extractor";
  const codexHome = path.join(os.tmpdir(), "codex-home");
  const worktreePath = buildWorktreePath({ codexHome, sourceRoot, branch });

  assert.equal(
    worktreePath,
    path.join(codexHome, "worktrees", buildStableWorktreeId(sourceRoot, branch), "ExampleRepo"),
  );
  assert.match(path.basename(path.dirname(worktreePath)), /^[a-f0-9]{8}$/);
});

test("resolveCodexHome defaults to ~/.codex and honors CODEX_HOME", () => {
  assert.equal(resolveCodexHome({}, "/Users/example"), "/Users/example/.codex");
  assert.equal(resolveCodexHome({ CODEX_HOME: "/tmp/custom-codex" }, "/Users/example"), "/tmp/custom-codex");
});

test("normalizeEndpoint supports raw paths and unix endpoints", () => {
  assert.deepEqual(normalizeEndpoint("/tmp/codex.sock"), { kind: "unix", path: "/tmp/codex.sock" });
  assert.deepEqual(normalizeEndpoint("unix:/tmp/codex.sock"), { kind: "unix", path: "/tmp/codex.sock" });
  assert.deepEqual(normalizeEndpoint("unix:///tmp/codex.sock"), { kind: "unix", path: "/tmp/codex.sock" });
  assert.deepEqual(normalizeEndpoint("ws://127.0.0.1:4500"), {
    kind: "websocket",
    path: "ws://127.0.0.1:4500",
    url: "ws://127.0.0.1:4500",
  });
});

test("discoverEndpointCandidates reads env, broker state, and default socket candidates", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rebind-spec-"));
  const homeDir = path.join(tmp, "home");
  const codexHome = path.join(tmp, "codex-home");
  const pluginData = path.join(tmp, "plugin-data");
  const sourceRoot = path.join(tmp, "repo");
  const worktreePath = path.join(tmp, "worktree");
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(worktreePath, { recursive: true });

  const env = {
    CODEX_COMPANION_APP_SERVER_ENDPOINT: "unix:/tmp/from-env.sock",
    CLAUDE_PLUGIN_DATA: pluginData,
  };
  const stateDir = companionStateDir(sourceRoot, env);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "broker.json"), JSON.stringify({ endpoint: "unix:/tmp/from-state.sock" }));

  const candidates = discoverEndpointCandidates({ env, sourceRoot, worktreePath, codexHome, homeDir });
  assert.ok(candidates.some((candidate) => candidate.source === "env:CODEX_COMPANION_APP_SERVER_ENDPOINT"));
  assert.ok(candidates.some((candidate) => candidate.path === "/tmp/from-state.sock"));
  assert.ok(candidates.some((candidate) => candidate.path === path.join(codexHome, "app-server-control", "app-server-control.sock")));
});

test("JSON-RPC request builders match app-server protocol shape", () => {
  assert.deepEqual(buildInitializeRequest(7), {
    id: 7,
    method: "initialize",
    params: {
      clientInfo: {
        name: "codex-worktree-rebind",
        title: "Codex Worktree Rebind",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    },
  });

  assert.deepEqual(buildThreadResumeRequest(8, "thread-1", "/tmp/worktree"), {
    id: 8,
    method: "thread/resume",
    params: {
      threadId: "thread-1",
      cwd: "/tmp/worktree",
    },
  });
});

test("classifyRebindResult preserves honest statuses", () => {
  assert.equal(classifyRebindResult({ endpointFound: true, threadLoaded: true, resumeSucceeded: true }), "rebound");
  assert.equal(classifyRebindResult({ endpointFound: false, threadLoaded: false, resumeSucceeded: false }), "unsupported");
  assert.equal(classifyRebindResult({ endpointFound: true, threadLoaded: false, resumeSucceeded: false }), "unsupported");
  assert.equal(classifyRebindResult({ endpointFound: true, threadLoaded: true, resumeSucceeded: false }), "prepared_only");
});
