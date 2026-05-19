#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const mcpConfig = JSON.parse(fs.readFileSync(join(pluginRoot, ".mcp.json"), "utf8"));
const serverConfig = mcpConfig["github-local-ops"];
const fakeBinDir = fs.mkdtempSync(join(os.tmpdir(), "github-local-ops-contract-"));
const commandLog = join(fakeBinDir, "commands.jsonl");
const replyLog = join(fakeBinDir, "replies.jsonl");
const reviewerLog = join(fakeBinDir, "reviewers.jsonl");
const bodyFile = join(fakeBinDir, "body.txt");
const checksFile = join(fakeBinDir, "checks.txt");
const fakeGh = join(fakeBinDir, "gh.mjs");
const fakeGit = join(fakeBinDir, "git.mjs");

fs.writeFileSync(fakeGh, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_COMMAND_LOG, JSON.stringify({ bin: "gh", args, cwd: process.cwd() }) + "\\n");
if (args[0] === "--version") {
  console.log("gh version 2.0.0");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  console.log("github.com");
  console.log("  \\u2713 Logged in to github.com account thomast8");
  console.log("  - Active account: true");
  process.exit(0);
}
if (args[0] === "repo" && args[1] === "view") {
  console.log(JSON.stringify({
    nameWithOwner: "owner/repo",
    url: "https://github.com/owner/repo",
    defaultBranchRef: { name: "main" },
    viewerPermission: "ADMIN",
    isPrivate: false,
    description: "Fixture repo"
  }));
  process.exit(0);
}
function argAfter(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1] || null;
}
function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs.readFileSync(filePath, "utf8").trim().split("\\n").filter(Boolean).map((line) => JSON.parse(line));
}
function writeJsonl(filePath, value) {
  fs.appendFileSync(filePath, JSON.stringify(value) + "\\n");
}
if (args[0] === "api" && args[1] === "graphql") {
  const body = fs.existsSync(process.env.FAKE_BODY_FILE)
    ? fs.readFileSync(process.env.FAKE_BODY_FILE, "utf8")
    : "Initial PR body";
  const reviewers = readJsonl(process.env.FAKE_REVIEWER_LOG).flatMap((entry) => entry.reviewers);
  const replies = readJsonl(process.env.FAKE_REPLY_LOG);
  const replyNodes = replies.map((reply, index) => ({
    id: "PRRC_reply_" + index,
    databaseId: 9000 + index,
    body: reply.body,
    author: { login: "thomast8" },
    createdAt: "2026-05-19T10:10:00Z",
    updatedAt: "2026-05-19T10:10:00Z",
    url: "https://github.com/owner/repo/pull/1#discussion_r" + (9000 + index),
    path: "src/example.js",
    line: 12,
    originalLine: 12,
    diffHunk: "@@",
    outdated: false,
    replyTo: { id: "PRRC_root", databaseId: Number(reply.commentId) }
  }));
  console.log(JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          id: "PR_1",
          number: 1,
          title: "Fixture PR",
          state: "OPEN",
          url: "https://github.com/owner/repo/pull/1",
          body,
          reviewDecision: "REVIEW_REQUIRED",
          isDraft: false,
          baseRefName: "main",
          headRefName: "feature/review",
          headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          author: { login: "thomast8" },
          reviewRequests: {
            nodes: reviewers.map((reviewer) => ({
              requestedReviewer: { __typename: "User", login: reviewer }
            }))
          },
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "PRRT_human",
                isResolved: false,
                isOutdated: false,
                path: "src/example.js",
                line: 12,
                startLine: null,
                originalLine: 12,
                originalStartLine: null,
                subjectType: "LINE",
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "PRRC_root",
                      databaseId: 101,
                      body: "Please fix this.",
                      author: { login: "reviewer" },
                      createdAt: "2026-05-19T10:00:00Z",
                      updatedAt: "2026-05-19T10:00:00Z",
                      url: "https://github.com/owner/repo/pull/1#discussion_r101",
                      path: "src/example.js",
                      line: 12,
                      originalLine: 12,
                      diffHunk: "@@",
                      outdated: false,
                      replyTo: null
                    },
                    ...replyNodes
                  ]
                }
              },
              {
                id: "PRRT_bot",
                isResolved: false,
                isOutdated: false,
                path: "src/example.js",
                line: 20,
                startLine: null,
                originalLine: 20,
                originalStartLine: null,
                subjectType: "LINE",
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "PRRC_bot",
                      databaseId: 202,
                      body: "CodeQL found a thing.",
                      author: { login: "github-code-scanning[bot]" },
                      createdAt: "2026-05-19T10:05:00Z",
                      updatedAt: "2026-05-19T10:05:00Z",
                      url: "https://github.com/owner/repo/pull/1#discussion_r202",
                      path: "src/example.js",
                      line: 20,
                      originalLine: 20,
                      diffHunk: "@@",
                      outdated: false,
                      replyTo: null
                    }
                  ]
                }
              }
            ]
          }
        }
      },
      rateLimit: { limit: 5000, cost: 1, remaining: 4999, resetAt: "2026-05-19T11:00:00Z", used: 1 }
    }
  }));
  process.exit(0);
}
if (args[0] === "api" && args[1] === "--method" && args[2] === "POST" && args[3].includes("/replies")) {
  const body = String(argAfter("-f") || "").replace(/^body=/, "");
  const match = args[3].match(/comments\\/(\\d+)\\/replies$/);
  const commentId = match ? match[1] : "0";
  writeJsonl(process.env.FAKE_REPLY_LOG, { commentId, body });
  console.log(JSON.stringify({
    id: 9001,
    body,
    url: "https://api.github.com/repos/owner/repo/pulls/comments/9001",
    html_url: "https://github.com/owner/repo/pull/1#discussion_r9001"
  }));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "checks") {
  const checkMode = fs.existsSync(process.env.FAKE_CHECKS_FILE)
    ? fs.readFileSync(process.env.FAKE_CHECKS_FILE, "utf8").trim()
    : "pass";
  console.log(JSON.stringify([
    {
      bucket: checkMode === "fail" ? "fail" : "pass",
      completedAt: "2026-05-19T10:20:00Z",
      description: checkMode === "fail" ? "failed" : "ok",
      event: "pull_request",
      link: "https://github.com/owner/repo/actions/runs/1",
      name: "unit",
      startedAt: "2026-05-19T10:15:00Z",
      state: checkMode === "fail" ? "FAILURE" : "SUCCESS",
      workflow: "CI"
    }
  ]));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "edit") {
  const body = argAfter("--body");
  if (body !== null) {
    fs.writeFileSync(process.env.FAKE_BODY_FILE, body, "utf8");
  }
  const reviewers = argAfter("--add-reviewer");
  if (reviewers !== null) {
    writeJsonl(process.env.FAKE_REVIEWER_LOG, { reviewers: reviewers.split(",").filter(Boolean) });
  }
  console.log("");
  process.exit(0);
}
console.error("unexpected gh args " + JSON.stringify(args));
process.exit(1);
`, "utf8");
fs.writeFileSync(fakeGit, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_COMMAND_LOG, JSON.stringify({ bin: "git", args, cwd: process.cwd() }) + "\\n");
if (args[0] === "--version") {
  console.log("git version 2.0.0");
  process.exit(0);
}
if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
  console.log(process.cwd());
  process.exit(0);
}
if (args[0] === "rev-parse" && args[1] === "HEAD") {
  console.log("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  process.exit(0);
}
if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "--symbolic-full-name") {
  console.log("origin/feature/review");
  process.exit(0);
}
if (args[0] === "rev-parse" && args[1] === "refs/remotes/origin/feature/review") {
  console.log("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  process.exit(0);
}
if (args[0] === "rev-list" && args[1] === "--left-right" && args[2] === "--count") {
  console.log("0\\t0");
  process.exit(0);
}
if (args[0] === "branch" && args[1] === "--show-current") {
  console.log("feature/review");
  process.exit(0);
}
if (args[0] === "remote" && args[1] === "get-url" && args[2] === "origin") {
  console.log("https://token@github.com/owner/repo.git");
  process.exit(0);
}
console.error("unexpected git args " + JSON.stringify(args));
process.exit(1);
`, "utf8");
fs.chmodSync(fakeGh, 0o755);
fs.chmodSync(fakeGit, 0o755);

if (!serverConfig || serverConfig.command !== "node") {
  throw new Error("github-local-ops .mcp.json must declare a node command");
}
if (!serverConfig.args?.includes("./scripts/github-mcp.mjs")) {
  throw new Error("github-local-ops .mcp.json must start scripts/github-mcp.mjs");
}
if (!serverConfig.args?.includes("--enable-public-writes")) {
  throw new Error("github-local-ops .mcp.json must enable public writes for provider-owned execution");
}

const child = spawn(serverConfig.command, serverConfig.args, {
  cwd: pluginRoot,
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    GITHUB_LOCAL_OPS_ENABLE_PUBLIC_WRITES: "",
    GITHUB_LOCAL_OPS_GH_BIN: fakeGh,
    GITHUB_LOCAL_OPS_GIT_BIN: fakeGit,
    FAKE_COMMAND_LOG: commandLog,
    FAKE_REPLY_LOG: replyLog,
    FAKE_REVIEWER_LOG: reviewerLog,
    FAKE_BODY_FILE: bodyFile,
    FAKE_CHECKS_FILE: checksFile
  }
});

let nextId = 1;
let buffer = "";
const pending = new Map();
const stderr = [];

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const message = JSON.parse(trimmed);
    const request = pending.get(message.id);
    if (request) {
      pending.delete(message.id);
      clearTimeout(request.timeout);
      request.resolve(message);
    }
  }
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr.push(chunk);
});

child.on("exit", (code) => {
  for (const [id, request] of pending.entries()) {
    pending.delete(id);
    clearTimeout(request.timeout);
    request.reject(new Error(`MCP server exited before response ${id}; code ${code}`));
  }
});

function request(method, params = {}) {
  const id = nextId;
  nextId += 1;
  const payload = { jsonrpc: "2.0", id, method, params };
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}`));
    }, 5000);
    pending.set(id, { resolve, reject, timeout });
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  });
}

function textContent(response) {
  return response.result?.content?.[0]?.text || "";
}

function jsonContent(response) {
  const text = textContent(response);
  if (!text) {
    throw new Error("Expected JSON text content in MCP response");
  }
  return JSON.parse(text);
}

function readCommandLog() {
  if (!fs.existsSync(commandLog)) {
    return [];
  }
  return fs.readFileSync(commandLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function main() {
  const initialize = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "github-local-ops-contract", version: "0.1.0" }
  });
  const toolsResult = await request("tools/list");
  const names = toolsResult.result.tools.map((tool) => tool.name);
  for (const name of [
    "github_setup_status",
    "github_current_context",
    "github_pr_view",
    "github_pr_handoff_status",
    "github_review_handoff_preview",
    "github_mutation_preview",
    "github_mutation_execute"
  ]) {
    if (!names.includes(name)) {
      throw new Error(`Missing expected tool: ${name}`);
    }
  }

  const status = await request("tools/call", {
    name: "github_setup_status",
    arguments: { cwd: pluginRoot, autoFetch: false }
  });
  const setup = jsonContent(status);
  if (setup.configured !== true) {
    throw new Error("github_setup_status contract did not reach configured state");
  }
  if (setup.freshness?.attempted !== false) {
    throw new Error("github_setup_status contract must not fetch refs");
  }
  for (const key of ["gitAvailable", "ghAvailable", "authOk", "repoResolved"]) {
    if (setup.checks?.[key] !== true) {
      throw new Error(`github_setup_status checks.${key} was not healthy`);
    }
  }
  if (setup.git?.origin !== "https://[redacted]@github.com/owner/repo.git") {
    throw new Error("github_setup_status did not redact credentialed origin URL");
  }
  const callsAfterStatus = readCommandLog().length;

  const preview = await request("tools/call", {
    name: "github_mutation_preview",
    arguments: {
      operation: "issue_comment",
      payload: {
        repo: "owner/repo",
        number: 1,
        body: "Contract preview only."
      }
    }
  });
  if (!textContent(preview).includes("approvalToken")) {
    throw new Error("github_mutation_preview response did not include approvalToken");
  }
  const previewJson = jsonContent(preview);
  if (previewJson.operation !== "issue_comment") {
    throw new Error("github_mutation_preview response did not preserve operation");
  }
  if (previewJson.executableByTool !== true) {
    throw new Error("github_mutation_preview should report execution enabled in the fake public-write process");
  }
  if (readCommandLog().length !== callsAfterStatus) {
    throw new Error("github_mutation_preview should not invoke gh or git");
  }

  const handoffStatus = await request("tools/call", {
    name: "github_pr_handoff_status",
    arguments: {
      cwd: pluginRoot,
      repo: "owner/repo",
      number: 1,
      expectedHeadSha: "aaaaaaaa",
      approvedReplies: [{ commentId: 101, body: "Fixed in the pushed change." }],
      expectedReviewers: ["octocat"],
      autoFetch: false
    }
  });
  const handoff = jsonContent(handoffStatus);
  if (handoff.abstract?.handoffComplete !== false || handoff.state?.pushedIsNotReplied !== true) {
    throw new Error("github_pr_handoff_status did not flag pushed-but-unreplied state");
  }
  if (handoff.threads?.botOrCodeql?.length !== 1) {
    throw new Error("github_pr_handoff_status did not separate bot/CodeQL threads");
  }

  const callsBeforeHandoffPreview = readCommandLog().length;
  const handoffPreview = await request("tools/call", {
    name: "github_review_handoff_preview",
    arguments: {
      cwd: pluginRoot,
      repo: "owner/repo",
      number: 1,
      expectedHeadSha: "aaaaaaaa",
      prBody: "Updated PR body",
      approvedReplies: [{ commentId: 101, body: "Fixed in the pushed change." }],
      reviewers: ["octocat"],
      autoFetch: false
    }
  });
  const handoffPreviewJson = jsonContent(handoffPreview);
  if (!handoffPreviewJson.approvalToken || handoffPreviewJson.steps?.[0]?.kind !== "post_review_thread_reply") {
    throw new Error("github_review_handoff_preview did not return an ordered handoff preview");
  }
  const previewCalls = readCommandLog().slice(callsBeforeHandoffPreview);
  if (previewCalls.some((call) => call.args.includes("--method") || (call.args[0] === "pr" && call.args[1] === "edit"))) {
    throw new Error("github_review_handoff_preview should only read GitHub state");
  }

  const handoffExecute = await request("tools/call", {
    name: "github_mutation_execute",
    arguments: {
      approvalToken: handoffPreviewJson.approvalToken
    }
  });
  const handoffExecuteJson = jsonContent(handoffExecute);
  if (handoffExecuteJson.readback?.[0]?.body !== "Fixed in the pushed change.") {
    throw new Error("review handoff execution did not return reply readback");
  }
  if (handoffExecuteJson.reviewerRequest?.skipped !== false) {
    throw new Error("review handoff execution did not request reviewers after passing checks");
  }

  fs.writeFileSync(checksFile, "fail", "utf8");
  const failingHandoffPreview = await request("tools/call", {
    name: "github_review_handoff_preview",
    arguments: {
      cwd: pluginRoot,
      repo: "owner/repo",
      number: 1,
      expectedHeadSha: "aaaaaaaa",
      reviewers: ["reviewer-two"],
      autoFetch: false
    }
  });
  if (failingHandoffPreview.result?.isError !== true) {
    throw new Error("github_review_handoff_preview should block reviewer requests while checks fail");
  }
  fs.writeFileSync(checksFile, "pass", "utf8");

  const callsBeforeMissingToken = readCommandLog().length;
  const execute = await request("tools/call", {
    name: "github_mutation_execute",
    arguments: {}
  });
  if (execute.result?.isError !== true) {
    throw new Error("github_mutation_execute without token should fail");
  }
  if (readCommandLog().length !== callsBeforeMissingToken) {
    throw new Error("github_mutation_execute without token should not invoke gh or git");
  }

  child.stdin.end();
  child.kill("SIGTERM");
  console.log(JSON.stringify({
    ok: true,
    server: initialize.result.serverInfo,
    toolCount: names.length,
    checkedTools: names,
    stderr: stderr.join("").trim() || null
  }, null, 2));
}

main().catch((error) => {
  child.kill("SIGTERM");
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
