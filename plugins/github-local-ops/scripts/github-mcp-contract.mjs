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
const reviewLog = join(fakeBinDir, "reviews.jsonl");
const reviewerLog = join(fakeBinDir, "reviewers.jsonl");
const bodyFile = join(fakeBinDir, "body.txt");
const checksFile = join(fakeBinDir, "checks.txt");
const stateFile = join(fakeBinDir, "state.json");
const identityFile = join(fakeBinDir, "identity-rules.json");
const fakeGh = join(fakeBinDir, "gh.mjs");
const fakeGit = join(fakeBinDir, "git.mjs");
const fakeSshAdd = join(fakeBinDir, "ssh-add.mjs");
const requestTimeoutMs = Number.parseInt(process.env.GITHUB_LOCAL_OPS_CONTRACT_TIMEOUT_MS || "15000", 10);
fs.writeFileSync(stateFile, JSON.stringify({
  detached: false,
  head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  prListMode: "match",
  prNumber: 292,
  sshLoaded: true,
  gitConfig: {
    "user.email": "owner@example.com",
    "gpg.format": "ssh",
    "user.signingkey": "owner-signing-key"
  }
}), "utf8");
fs.writeFileSync(identityFile, JSON.stringify({
  rules: [
    {
      id: "owner-repo",
      repo: "owner/repo",
      githubAccount: "owner",
      gitEmail: "owner@example.com",
      gpgFormat: "ssh",
      signingKey: "owner-signing-key",
      sshKeyPath: join(fakeBinDir, "id_owner"),
      sshKeyFingerprint: "SHA256:owner"
    },
    {
      id: "personal-owner",
      owner: "thomast8",
      githubAccount: "thomast8",
      gitEmail: "personal@example.com",
      gpgFormat: "ssh",
      signingKey: "personal-signing-key"
    },
    {
      id: "corp-owner",
      owner: "enterprise-org",
      githubAccount: "corp-user",
      gitEmail: "corp-user@example.com",
      gpgFormat: "ssh",
      signingKey: "corp-signing-key"
    }
  ]
}, null, 2), "utf8");

fs.writeFileSync(fakeGh, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
function tokenAccount() {
  if (process.env.GH_TOKEN === "token-owner") {
    return "owner";
  }
  if (process.env.GH_TOKEN === "token-thomast8") {
    return "thomast8";
  }
  if (process.env.GH_TOKEN === "token-corp") {
    return "corp-user";
  }
  return null;
}
fs.appendFileSync(process.env.FAKE_COMMAND_LOG, JSON.stringify({ bin: "gh", args, cwd: process.cwd(), tokenAccount: tokenAccount() }) + "\\n");
function state() {
  try {
    return JSON.parse(fs.readFileSync(process.env.FAKE_STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}
if (args[0] === "--version") {
  console.log("gh version 2.0.0");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  const showToken = args.includes("--show-token");
  console.log("github.com");
  console.log("  \\u2713 Logged in to github.com account thomast8");
  console.log("  - Active account: true");
  if (showToken) {
    console.log("  - Token: token-thomast8");
  }
  console.log("");
  console.log("  \\u2713 Logged in to github.com account owner");
  console.log("  - Active account: false");
  if (showToken) {
    console.log("  - Token: token-owner");
  }
  console.log("");
  console.log("  \\u2713 Logged in to github.com account corp-user");
  console.log("  - Active account: false");
  if (showToken) {
    console.log("  - Token: token-corp");
  }
  console.log("");
  console.log("  \\u2713 Logged in to github.com account fallback");
  console.log("  - Active account: false");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "token") {
  const current = state();
  const userIndex = args.indexOf("--user");
  const user = userIndex === -1 ? "thomast8" : args[userIndex + 1];
  if ((current.tokenCommandFailsFor || []).includes(user)) {
    console.error("no oauth token found for github.com account " + user);
    process.exit(1);
  }
  if (user === "owner") {
    console.log("token-owner");
    process.exit(0);
  }
  if (user === "thomast8") {
    console.log("token-thomast8");
    process.exit(0);
  }
  if (user === "corp-user") {
    console.log("token-corp");
    process.exit(0);
  }
  if (user === "fallback") {
    console.error("token unavailable for fallback");
    process.exit(1);
  }
  console.error("unknown fake account " + user);
  process.exit(1);
}
if (args[0] === "auth" && args[1] === "switch") {
  console.error("contract must not switch global gh accounts");
  process.exit(1);
}
if (args[0] === "auth" && args[1] === "setup-git") {
  console.error("contract must not rewrite global git credential configuration");
  process.exit(1);
}
if (args[0] === "repo" && args[1] === "view") {
  const current = state();
  const targetRepo = args.find((arg, index) => index > 1 && !String(arg).startsWith("-") && String(arg).includes("/"));
  if (current.denyRepoViewFor && targetRepo === current.denyRepoViewFor) {
    console.error("repo access denied for " + targetRepo);
    process.exit(1);
  }
  if (targetRepo === "enterprise-org/PolicyAsCode" && tokenAccount() !== "corp-user") {
    console.error("repo access denied for " + targetRepo);
    process.exit(1);
  }
  if (targetRepo === "thomast8/codex-plugins" && tokenAccount() !== "thomast8") {
    console.error("repo access denied for " + targetRepo);
    process.exit(1);
  }
  const nameWithOwner = targetRepo || "owner/repo";
  console.log(JSON.stringify({
    nameWithOwner,
    url: "https://github.com/" + nameWithOwner,
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
  const queryArg = args.find((arg) => arg.startsWith("query=")) || "";
  if (queryArg.includes("pullRequests(states: OPEN")) {
    const viewer = tokenAccount() || "thomast8";
    const includeChecks = queryArg.includes("statusCheckRollup");
    const checks = includeChecks
      ? {
          statusCheckRollup: {
            state: "SUCCESS",
            contexts: {
              totalCount: 1,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  __typename: "CheckRun",
                  name: "unit",
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                  detailsUrl: "https://github.com/owner/repo/actions/runs/1",
                  startedAt: "2026-05-19T10:15:00Z",
                  completedAt: "2026-05-19T10:20:00Z",
                  checkSuite: { workflowRun: { workflow: { name: "CI" } } }
                }
              ]
            }
          }
        }
      : {};
    console.log(JSON.stringify({
      data: {
        subject: {
          login: viewer,
          pullRequests: {
            totalCount: 2,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                number: 1,
                title: "Base PR",
                url: "https://github.com/owner/repo/pull/1",
                state: "OPEN",
                isDraft: false,
                updatedAt: "2026-05-19T10:00:00Z",
                reviewDecision: "REVIEW_REQUIRED",
                baseRefName: "main",
                baseRefOid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                headRefName: "feature/base",
                headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                author: { login: viewer },
                repository: { nameWithOwner: "owner/repo" },
                headRepository: { nameWithOwner: "owner/repo" },
                ...checks
              },
              {
                number: 2,
                title: "Child PR",
                url: "https://github.com/owner/repo/pull/2",
                state: "OPEN",
                isDraft: true,
                updatedAt: "2026-05-19T10:01:00Z",
                reviewDecision: null,
                baseRefName: "feature/base",
                baseRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                headRefName: "feature/child",
                headRefOid: "cccccccccccccccccccccccccccccccccccccccc",
                author: { login: viewer },
                repository: { nameWithOwner: "owner/repo" },
                headRepository: { nameWithOwner: "owner/repo" },
                ...checks
              }
            ]
          }
        },
        rateLimit: { limit: 5000, cost: 1, remaining: 4999, resetAt: "2026-05-19T11:00:00Z", used: 1 }
      }
    }));
    process.exit(0);
  }
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
if (args[0] === "api" && args[1]?.startsWith("repos/owner/repo/compare/")) {
  const stale = args[1].includes("feature%2Fchild");
  console.log(JSON.stringify({
    status: stale ? "diverged" : "ahead",
    aheadBy: stale ? 2 : 1,
    behindBy: stale ? 1 : 0,
    baseCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    mergeBaseCommit: stale
      ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      : "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
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
if (args[0] === "api" && args[1] === "--method" && args[2] === "POST" && args[3] === "repos/owner/repo/pulls/1/reviews") {
  const input = fs.readFileSync(0, "utf8");
  const payload = JSON.parse(input);
  writeJsonl(process.env.FAKE_REVIEW_LOG, { payload });
  console.log(JSON.stringify({
    id: 80,
    node_id: "PRR_80",
    body: payload.body || "",
    state: "COMMENTED",
    html_url: "https://github.com/owner/repo/pull/1#pullrequestreview-80"
  }));
  process.exit(0);
}
if (args[0] === "api" && args[1]?.startsWith("repos/owner/repo/pulls/1/reviews/80/comments")) {
  const current = state();
  if (current.reviewReadbackMode === "fail") {
    console.error("readback failed after review creation");
    process.exit(1);
  }
  const reviews = readJsonl(process.env.FAKE_REVIEW_LOG);
  const payload = reviews.at(-1)?.payload || { comments: [] };
  console.log(JSON.stringify(payload.comments.map((comment, index) => ({
    id: 8100 + index,
    body: comment.body,
    path: comment.path,
    line: current.reviewReadbackMode === "mismatch" ? comment.line + 1 : comment.line,
    start_line: comment.start_line,
    side: comment.side,
    start_side: comment.start_side,
    html_url: "https://github.com/owner/repo/pull/1#discussion_r" + (8100 + index),
    url: "https://api.github.com/repos/owner/repo/pulls/comments/" + (8100 + index)
  }))));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "list") {
  const current = state();
  const head = current.head || "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const basePr = {
    author: { login: "reviewer" },
    baseRefName: "main",
    headRefName: "feature/review",
    headRefOid: head,
    isDraft: false,
    number: current.prNumber || 292,
    reviewDecision: "REVIEW_REQUIRED",
    reviewRequests: [],
    state: "OPEN",
    title: "Fixture PR",
    updatedAt: "2026-05-19T10:00:00Z",
    url: "https://github.com/owner/repo/pull/" + (current.prNumber || 292)
  };
  if (current.prListMode === "empty") {
    console.log(JSON.stringify([]));
    process.exit(0);
  }
  if (current.prListMode === "multi") {
    console.log(JSON.stringify([
      basePr,
      { ...basePr, number: 293, headRefName: "feature/duplicate", url: "https://github.com/owner/repo/pull/293" }
    ]));
    process.exit(0);
  }
  console.log(JSON.stringify([basePr]));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "view") {
  const current = state();
  const target = args[2] || "feature/review";
  const number = /^[0-9]+$/.test(target) ? Number(target) : (current.prNumber || 292);
  const head = current.head || "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const viewHead = current.viewHead || head;
  console.log(JSON.stringify({
    number,
    title: "Fixture PR",
    state: "OPEN",
    isDraft: false,
    author: { login: "reviewer" },
    baseRefName: "main",
    baseRefOid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    headRefName: "feature/review",
    headRefOid: viewHead,
    body: "Initial PR body",
    changedFiles: 1,
    files: [{ path: "src/example.js" }],
    reviewDecision: "REVIEW_REQUIRED",
    reviewRequests: [],
    latestReviews: [],
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    statusCheckRollup: null,
    updatedAt: "2026-05-19T10:00:00Z",
    url: "https://github.com/owner/repo/pull/" + number
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
if (args[0] === "pr" && args[1] === "create") {
  if (!args.includes("--draft")) {
    console.error("contract PR creation must be draft");
    process.exit(1);
  }
  console.log("https://github.com/owner/repo/pull/300");
  process.exit(0);
}
console.error("unexpected gh args " + JSON.stringify(args));
process.exit(1);
`, "utf8");
fs.writeFileSync(fakeGit, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const effectiveArgs = args[0] === "-c" ? args.slice(2) : args;
function askpassTokenAccount() {
  if (process.env.GITHUB_LOCAL_OPS_ASKPASS_TOKEN === "token-owner") {
    return "owner";
  }
  if (process.env.GITHUB_LOCAL_OPS_ASKPASS_TOKEN === "token-thomast8") {
    return "thomast8";
  }
  if (process.env.GITHUB_LOCAL_OPS_ASKPASS_TOKEN === "token-corp") {
    return "corp-user";
  }
  return null;
}
fs.appendFileSync(process.env.FAKE_COMMAND_LOG, JSON.stringify({ bin: "git", args, cwd: process.cwd(), askpassTokenAccount: askpassTokenAccount(), gitAskpass: process.env.GIT_ASKPASS || null }) + "\\n");
function state() {
  try {
    return JSON.parse(fs.readFileSync(process.env.FAKE_STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}
function writeState(next) {
  fs.writeFileSync(process.env.FAKE_STATE_FILE, JSON.stringify(next), "utf8");
}
if (args[0] === "--version") {
  console.log("git version 2.0.0");
  process.exit(0);
}
if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
  console.log(process.cwd());
  process.exit(0);
}
if (args[0] === "rev-parse" && args[1] === "HEAD") {
  console.log(state().head || "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  process.exit(0);
}
if (args[0] === "symbolic-ref" && args[1] === "-q" && args[2] === "--short" && args[3] === "HEAD") {
  if (state().detached) {
    process.exit(1);
  }
  console.log("feature/review");
  process.exit(0);
}
if (args[0] === "worktree" && args[1] === "list" && args[2] === "--porcelain") {
  console.log("worktree " + process.cwd());
  console.log("HEAD " + (state().head || "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
  if (state().detached) {
    console.log("");
    console.log("worktree /tmp/other-worktree");
    console.log("HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    console.log("detached");
  } else {
    console.log("branch refs/heads/feature/review");
  }
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
  if (state().detached) {
    console.log("");
    process.exit(0);
  }
  console.log("feature/review");
  process.exit(0);
}
if (effectiveArgs[0] === "for-each-ref" && effectiveArgs.includes("--contains")) {
  const current = state();
  const branches = current.containingBranches || (current.detached ? [] : ["feature/review"]);
  console.log(branches.join("\\n"));
  process.exit(0);
}
if (args[0] === "remote") {
  if (args.length === 1) {
    console.log("origin");
    process.exit(0);
  }
}
if (args[0] === "remote" && args[1] === "get-url" && args[2] === "origin") {
  console.log(state().remoteUrl || "https://token@github.com/owner/repo.git");
  process.exit(0);
}
if (args[0] === "config" && args[1] === "--get") {
  const value = state().gitConfig?.[args[2]];
  if (value == null) {
    process.exit(1);
  }
  console.log(value);
  process.exit(0);
}
if (args[0] === "config" && args.length === 3) {
  const current = state();
  current.gitConfig = { ...(current.gitConfig || {}), [args[1]]: args[2] };
  writeState(current);
  process.exit(0);
}
if (args[0] === "fetch") {
  console.log("");
  process.exit(0);
}
if (effectiveArgs[0] === "push") {
  console.log("pushed");
  process.exit(0);
}
console.error("unexpected git args " + JSON.stringify(args));
process.exit(1);
`, "utf8");
fs.writeFileSync(fakeSshAdd, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_COMMAND_LOG, JSON.stringify({ bin: "ssh-add", args, cwd: process.cwd() }) + "\\n");
function state() {
  try {
    return JSON.parse(fs.readFileSync(process.env.FAKE_STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}
function writeState(next) {
  fs.writeFileSync(process.env.FAKE_STATE_FILE, JSON.stringify(next), "utf8");
}
if (args[0] === "-l") {
  if (!state().sshLoaded) {
    console.error("The agent has no identities.");
    process.exit(1);
  }
  console.log("256 SHA256:owner owner@example.com (ED25519)");
  process.exit(0);
}
if (args[0]) {
  const current = state();
  current.sshLoaded = true;
  writeState(current);
  process.exit(0);
}
console.error("unexpected ssh-add args " + JSON.stringify(args));
process.exit(1);
`, "utf8");
fs.chmodSync(fakeGh, 0o755);
fs.chmodSync(fakeGit, 0o755);
fs.chmodSync(fakeSshAdd, 0o755);

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
    GITHUB_LOCAL_OPS_SSH_ADD_BIN: fakeSshAdd,
    GITHUB_LOCAL_OPS_IDENTITY_FILE: identityFile,
    FAKE_COMMAND_LOG: commandLog,
    FAKE_REPLY_LOG: replyLog,
    FAKE_REVIEW_LOG: reviewLog,
    FAKE_REVIEWER_LOG: reviewerLog,
    FAKE_BODY_FILE: bodyFile,
    FAKE_CHECKS_FILE: checksFile,
    FAKE_STATE_FILE: stateFile
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
    }, requestTimeoutMs);
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

function readJsonlFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs.readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function expectToolError(toolName, args, expectedText) {
  const response = await request("tools/call", {
    name: toolName,
    arguments: args
  });
  if (response.result?.isError !== true || !textContent(response).includes(expectedText)) {
    throw new Error(`${toolName} should fail with ${expectedText}`);
  }
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
    "github_identity_status",
    "github_identity_fix_preview",
    "github_identity_fix_execute",
    "github_pr_view",
    "github_my_pull_requests",
    "github_pr_rebase_plan",
    "github_pr_handoff_status",
    "github_review_handoff_preview",
    "github_mutation_preview",
    "github_git_push_preview",
    "github_git_push_execute",
    "github_mutation_execute"
  ]) {
    if (!names.includes(name)) {
      throw new Error(`Missing expected tool: ${name}`);
    }
  }
  const mutationPreviewTool = toolsResult.result.tools.find((tool) => tool.name === "github_mutation_preview");
  if (!mutationPreviewTool?.inputSchema?.properties?.operation?.enum?.includes("pull_request_review")) {
    throw new Error("github_mutation_preview schema did not expose pull_request_review");
  }
  if (!mutationPreviewTool?.inputSchema?.properties?.operation?.enum?.includes("pr_create_draft")) {
    throw new Error("github_mutation_preview schema did not expose pr_create_draft");
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
  if (setup.authSelection?.strategy !== "identity_rule" || setup.authSelection?.account !== "owner") {
    throw new Error("github_setup_status did not select the local identity-rule gh account without switching globally");
  }
  if (setup.identity?.identity?.status !== "ready" || setup.identity?.identity?.localOnly !== true) {
    throw new Error("github_setup_status did not include ready local-only identity status");
  }
  const setupRepoView = readCommandLog().find((call) => call.bin === "gh" && call.args[0] === "repo" && call.args[1] === "view");
  if (setupRepoView?.tokenAccount !== "owner") {
    throw new Error("repo-aware gh calls should use the owner account token for owner/repo");
  }
  const identityStatus = await request("tools/call", {
    name: "github_identity_status",
    arguments: { cwd: pluginRoot, repo: "owner/repo" }
  });
  const identityStatusJson = jsonContent(identityStatus);
  if (
    identityStatusJson.identity?.status !== "ready"
    || identityStatusJson.identity?.selectedAccount !== "owner"
    || identityStatusJson.configFile !== identityFile
    || identityStatusJson.fixes?.length !== 0
  ) {
    throw new Error("github_identity_status did not report the ready local owner identity");
  }
  const personalIdentityStatus = await request("tools/call", {
    name: "github_identity_status",
    arguments: { cwd: pluginRoot, repo: "thomast8/codex-plugins" }
  });
  if (jsonContent(personalIdentityStatus).identity?.selectedAccount !== "thomast8") {
    throw new Error("github_identity_status did not select the personal account from local-only owner rules");
  }
  fs.writeFileSync(stateFile, JSON.stringify({
    detached: false,
    head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    prListMode: "match",
    prNumber: 292,
    sshLoaded: true,
    tokenCommandFailsFor: ["corp-user"],
    gitConfig: {
      "user.email": "owner@example.com",
      "gpg.format": "ssh",
      "user.signingkey": "owner-signing-key"
    }
  }), "utf8");
  const corpIdentityStatus = await request("tools/call", {
    name: "github_identity_status",
    arguments: { cwd: pluginRoot, repo: "enterprise-org/PolicyAsCode" }
  });
  const corpIdentityStatusJson = jsonContent(corpIdentityStatus);
  if (
    corpIdentityStatusJson.identity?.selectedAccount !== "corp-user"
    || corpIdentityStatusJson.authSelection?.account !== "corp-user"
  ) {
    throw new Error("github_identity_status did not select the corporate account from local-only owner rules with auth status token fallback");
  }
  const missingIdentityBackup = `${identityFile}.bak`;
  fs.renameSync(identityFile, missingIdentityBackup);
  try {
    const noLocalRulesStatus = await request("tools/call", {
      name: "github_identity_status",
      arguments: { cwd: pluginRoot, repo: "owner/repo" }
    });
    const noLocalRulesJson = jsonContent(noLocalRulesStatus);
    if (
      fs.existsSync(identityFile)
      || noLocalRulesJson.identity?.status !== "unverified"
      || noLocalRulesJson.identity?.matched !== false
      || noLocalRulesJson.identity?.selectedAccount !== "owner"
      || noLocalRulesJson.authSelection?.strategy !== "owner_login_permission_probe"
      || noLocalRulesJson.authSelection?.localIdentityVerified !== false
    ) {
      throw new Error("missing local identity rules should infer only API identity without creating files or verifying git signing identity");
    }
  } finally {
    fs.renameSync(missingIdentityBackup, identityFile);
  }
  fs.writeFileSync(stateFile, JSON.stringify({
    detached: false,
    head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    prListMode: "match",
    prNumber: 292,
    sshLoaded: false,
    gitConfig: {
      "user.email": "wrong@example.com",
      "gpg.format": "openpgp",
      "user.signingkey": "wrong-key"
    }
  }), "utf8");
  const identityFixPreview = await request("tools/call", {
    name: "github_identity_fix_preview",
    arguments: { cwd: pluginRoot, repo: "owner/repo" }
  });
  const identityFixPreviewJson = jsonContent(identityFixPreview);
  if (
    !identityFixPreviewJson.approvalToken
    || identityFixPreviewJson.fixes?.map((fix) => fix.kind).join(",") !== "git_email,gpg_format,signing_key,ssh_add"
  ) {
    throw new Error("github_identity_fix_preview did not preview all required local identity fixes");
  }
  const identityFixExecute = await request("tools/call", {
    name: "github_identity_fix_execute",
    arguments: { approvalToken: identityFixPreviewJson.approvalToken }
  });
  const identityFixExecuteJson = jsonContent(identityFixExecute);
  if (identityFixExecuteJson.finalIdentity?.status !== "ready") {
    throw new Error("github_identity_fix_execute did not make the local identity ready");
  }
  const fixCommands = readCommandLog().filter((call) => (
    (call.bin === "git" && call.args[0] === "config")
    || call.bin === "ssh-add"
  ));
  if (!fixCommands.some((call) => call.bin === "ssh-add" && call.args[0] === join(fakeBinDir, "id_owner"))) {
    throw new Error("github_identity_fix_execute did not load the configured SSH key");
  }
  fs.writeFileSync(stateFile, JSON.stringify({
    detached: false,
    head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    prListMode: "match",
    prNumber: 292,
    sshLoaded: true,
    gitConfig: {
      "user.email": "owner@example.com",
      "gpg.format": "ssh",
      "user.signingkey": "owner-signing-key"
    }
  }), "utf8");
  const originalIdentityRules = fs.readFileSync(identityFile, "utf8");
  fs.writeFileSync(identityFile, JSON.stringify({
    rules: [
      { id: "owner-a", repo: "owner/repo", githubAccount: "owner" },
      { id: "owner-b", repo: "owner/repo", githubAccount: "thomast8" }
    ]
  }), "utf8");
  await expectToolError(
    "github_repo_view",
    { cwd: pluginRoot, repo: "owner/repo" },
    "GitHub identity selection for owner/repo is ambiguous"
  );
  fs.writeFileSync(identityFile, originalIdentityRules, "utf8");
  const ambiguousRepo = await request("tools/call", {
    name: "github_repo_view",
    arguments: { cwd: pluginRoot, repo: "shared/repo" }
  });
  if (ambiguousRepo.result?.isError !== true || !textContent(ambiguousRepo).includes("GitHub account selection for shared/repo is ambiguous")) {
    throw new Error("github_repo_view should fail closed when multiple accounts have the same top repo permission");
  }
  const ambiguousPreview = await request("tools/call", {
    name: "github_mutation_preview",
    arguments: {
      operation: "issue_comment",
      payload: {
        repo: "shared/repo",
        number: 1,
        body: "Ambiguous auth should not execute."
      }
    }
  });
  const ambiguousExecute = await request("tools/call", {
    name: "github_mutation_execute",
    arguments: {
      approvalToken: jsonContent(ambiguousPreview).approvalToken
    }
  });
  if (ambiguousExecute.result?.isError !== true || !textContent(ambiguousExecute).includes("GitHub account selection for shared/repo is ambiguous")) {
    throw new Error("github_mutation_execute should fail closed when account selection is ambiguous");
  }

  const detachedHead = "dddddddddddddddddddddddddddddddddddddddd";
  fs.writeFileSync(stateFile, JSON.stringify({
    detached: true,
    head: detachedHead,
    prListMode: "match",
    prNumber: 292
  }), "utf8");
  const callsBeforeDetachedContext = readCommandLog().length;
  const detachedContext = await request("tools/call", {
    name: "github_current_context",
    arguments: { cwd: pluginRoot, autoFetch: true }
  });
  const detachedContextJson = jsonContent(detachedContext);
  if (detachedContextJson.git?.detached !== true || detachedContextJson.git?.branch !== null) {
    throw new Error("github_current_context did not report detached checkout state");
  }
  if (detachedContextJson.freshness?.mode !== "isolated-detached") {
    throw new Error("detached autoFetch did not use isolated freshness mode");
  }
  const detachedFetchCalls = readCommandLog()
    .slice(callsBeforeDetachedContext)
    .filter((call) => call.bin === "git" && call.args[0] === "fetch");
  if (detachedFetchCalls.length !== 1 || detachedFetchCalls[0].args[3] !== "origin") {
    throw new Error("detached autoFetch did not fetch from the resolved remote");
  }
  if (detachedFetchCalls[0].args.includes("--all")) {
    throw new Error("detached autoFetch must not update shared remote-tracking refs with fetch --all");
  }
  if (!detachedFetchCalls[0].args.includes("--no-tags") || !detachedFetchCalls[0].args.includes("--refmap=")) {
    throw new Error("detached autoFetch must disable tag fetching and configured remote refmaps");
  }
  if (!String(detachedFetchCalls[0].args[4] || "").startsWith("+refs/heads/*:refs/codex-fetch/")) {
    throw new Error("detached autoFetch did not fetch into an isolated refs/codex-fetch namespace");
  }

  const detachedPrView = await request("tools/call", {
    name: "github_pr_view",
    arguments: { cwd: pluginRoot, repo: "owner/repo", autoFetch: false }
  });
  const detachedPrViewJson = jsonContent(detachedPrView);
  if (detachedPrViewJson.prIdentity?.strategy !== "detached_head_sha") {
    throw new Error("github_pr_view did not resolve detached checkout by exact HEAD SHA");
  }
  if (detachedPrViewJson.prIdentity?.number !== 292 || detachedPrViewJson.pullRequest?.headRefOid !== detachedHead) {
    throw new Error("github_pr_view resolved the wrong PR for detached HEAD");
  }
  if (!detachedPrViewJson.resolutionCommands?.[0]?.includes("pr")) {
    throw new Error("github_pr_view did not expose detached PR resolution evidence");
  }

  const detachedBranchHead = "ffffffffffffffffffffffffffffffffffffffff";
  fs.writeFileSync(stateFile, JSON.stringify({
    detached: true,
    head: detachedHead,
    viewHead: detachedBranchHead,
    prListMode: "empty",
    prNumber: 292,
    containingBranches: ["feature/review"]
  }), "utf8");
  const detachedBranchFallback = await request("tools/call", {
    name: "github_pr_view",
    arguments: { cwd: pluginRoot, repo: "owner/repo", autoFetch: false }
  });
  const detachedBranchFallbackJson = jsonContent(detachedBranchFallback);
  if (detachedBranchFallbackJson.prIdentity?.strategy !== "detached_containing_branch") {
    throw new Error("github_pr_view did not fall back to a local branch containing detached HEAD");
  }
  if (
    detachedBranchFallbackJson.prIdentity?.branch !== "feature/review"
    || detachedBranchFallbackJson.pullRequest?.headRefOid !== detachedBranchHead
  ) {
    throw new Error("github_pr_view resolved the wrong containing-branch PR");
  }
  if (!detachedBranchFallbackJson.warnings?.some((warning) => warning.includes("stale local checkout"))) {
    throw new Error("github_pr_view did not warn when detached HEAD is stale against the PR branch");
  }
  if (!detachedBranchFallbackJson.resolutionCommands?.some((command) => command.includes("for-each-ref"))) {
    throw new Error("github_pr_view did not expose local branch fallback evidence");
  }

  fs.writeFileSync(stateFile, JSON.stringify({
    detached: true,
    head: detachedHead,
    viewHead: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    prListMode: "match",
    prNumber: 292
  }), "utf8");
  const staleDetachedPr = await request("tools/call", {
    name: "github_pr_view",
    arguments: { cwd: pluginRoot, repo: "owner/repo", autoFetch: false }
  });
  if (staleDetachedPr.result?.isError !== true) {
    throw new Error("github_pr_view should fail closed when the PR head changes after detached resolution");
  }

  fs.writeFileSync(stateFile, JSON.stringify({
    detached: true,
    head: detachedHead,
    prListMode: "empty",
    prNumber: 292,
    containingBranches: []
  }), "utf8");
  const missingDetachedPr = await request("tools/call", {
    name: "github_pr_view",
    arguments: { cwd: pluginRoot, repo: "owner/repo", autoFetch: false }
  });
  if (missingDetachedPr.result?.isError !== true) {
    throw new Error("github_pr_view should fail closed when detached HEAD does not map to exactly one PR");
  }

  fs.writeFileSync(stateFile, JSON.stringify({
    detached: false,
    head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    prListMode: "match",
    prNumber: 292
  }), "utf8");

  const callsBeforeMyPullRequests = readCommandLog().length;
  const myPullRequests = await request("tools/call", {
    name: "github_my_pull_requests",
    arguments: {
      cwd: pluginRoot,
      limit: 10,
      includeChecks: true
    }
  });
  const myPullRequestsJson = jsonContent(myPullRequests);
  if (myPullRequestsJson.discovery?.strategy !== "graphql_viewer_pull_requests") {
    throw new Error("github_my_pull_requests did not use GraphQL viewer discovery");
  }
  const myPullRequestApiCalls = readCommandLog()
    .slice(callsBeforeMyPullRequests)
    .filter((call) => call.bin === "gh" && call.args[0] === "api");
  if (myPullRequestApiCalls.length === 0 || myPullRequestApiCalls.some((call) => call.tokenAccount !== "owner")) {
    throw new Error("github_my_pull_requests did not use the selected local identity for GraphQL viewer discovery");
  }
  if (myPullRequestsJson.pullRequests?.length !== 2 || myPullRequestsJson.abstract?.drafts !== 1) {
    throw new Error("github_my_pull_requests did not return authored open PRs including drafts");
  }
  if (myPullRequestsJson.pullRequests[0]?.checks?.pass !== 1) {
    throw new Error("github_my_pull_requests did not include requested check summary");
  }

  const rebasePlan = await request("tools/call", {
    name: "github_pr_rebase_plan",
    arguments: {
      cwd: pluginRoot,
      pullRequests: myPullRequestsJson.pullRequests,
      checkStaleness: true
    }
  });
  const rebasePlanJson = jsonContent(rebasePlan);
  const orderedNumbers = rebasePlanJson.orderedPullRequests.map((pr) => pr.number).join(",");
  if (orderedNumbers !== "1,2") {
    throw new Error("github_pr_rebase_plan did not order stacked PRs parent-first");
  }
  const childPlan = rebasePlanJson.orderedPullRequests.find((pr) => pr.number === 2);
  if (childPlan?.dependsOn?.[0]?.number !== 1 || childPlan?.staleness?.status !== "stale") {
    throw new Error("github_pr_rebase_plan did not report child dependency and stale status");
  }

  const callsBeforeExplicitRebasePlan = readCommandLog().length;
  await request("tools/call", {
    name: "github_pr_rebase_plan",
    arguments: {
      cwd: pluginRoot,
      repo: "owner/repo",
      checkStaleness: true,
      githubAccount: "owner"
    }
  });
  const explicitRebaseApiCalls = readCommandLog()
    .slice(callsBeforeExplicitRebasePlan)
    .filter((call) => call.bin === "gh" && call.args[0] === "api");
  if (explicitRebaseApiCalls.length === 0 || explicitRebaseApiCalls.some((call) => call.tokenAccount !== "owner")) {
    throw new Error("github_pr_rebase_plan did not preserve explicit githubAccount through discovery and staleness reads");
  }

  const callsBeforeReviewThreads = readCommandLog().length;
  const reviewThreads = await request("tools/call", {
    name: "github_pr_review_threads",
    arguments: {
      cwd: pluginRoot,
      repo: "owner/repo",
      number: 1,
      githubAccount: "owner"
    }
  });
  const reviewThreadsJson = jsonContent(reviewThreads);
  const reviewThreadApiCalls = readCommandLog()
    .slice(callsBeforeReviewThreads)
    .filter((call) => call.bin === "gh" && call.args[0] === "api");
  if (reviewThreadsJson.authSelection?.account !== "owner" || reviewThreadApiCalls.some((call) => call.tokenAccount !== "owner")) {
    throw new Error("github_pr_review_threads did not preserve explicit githubAccount for GraphQL reads");
  }
  const callsBeforeMutationPreview = readCommandLog().length;

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
  if (readCommandLog().length !== callsBeforeMutationPreview) {
    throw new Error("github_mutation_preview should not invoke gh or git");
  }

  fs.writeFileSync(stateFile, JSON.stringify({
    detached: false,
    head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    prListMode: "match",
    prNumber: 292,
    sshLoaded: true,
    gitConfig: {
      "user.email": "owner@example.com",
      "gpg.format": "ssh",
      "user.signingkey": "owner-signing-key"
    }
  }), "utf8");
  const pushPreview = await request("tools/call", {
    name: "github_git_push_preview",
    arguments: {
      cwd: pluginRoot,
      refspec: "HEAD:refs/heads/feature/review",
      dryRun: true
    }
  });
  const pushPreviewJson = jsonContent(pushPreview);
  if (
    pushPreviewJson.identity?.selectedAccount !== "owner"
    || !pushPreviewJson.command?.args?.includes("--dry-run")
    || !pushPreviewJson.approvalToken
  ) {
    throw new Error("github_git_push_preview did not build an identity-aware push plan");
  }
  const callsBeforePushExecute = readCommandLog().length;
  const pushExecute = await request("tools/call", {
    name: "github_git_push_execute",
    arguments: { approvalToken: pushPreviewJson.approvalToken }
  });
  const pushExecuteJson = jsonContent(pushExecute);
  const pushCalls = readCommandLog()
    .slice(callsBeforePushExecute)
    .filter((call) => call.bin === "git" && call.args.includes("push"));
  if (
    pushExecuteJson.status !== 0
    || pushCalls.length !== 1
    || pushCalls[0].args[0] !== "-c"
    || pushCalls[0].args[1] !== "credential.helper="
    || pushCalls[0].askpassTokenAccount !== "owner"
    || !pushCalls[0].gitAskpass
  ) {
    throw new Error("github_git_push_execute did not use command-scoped owner credentials for HTTPS push");
  }

  const draftPrPreview = await request("tools/call", {
    name: "github_mutation_preview",
    arguments: {
      operation: "pr_create_draft",
      payload: {
        repo: "owner/repo",
        title: "Contract draft PR",
        body: "Draft body",
        base: "main",
        head: "feature/review"
      }
    }
  });
  const draftPrPreviewJson = jsonContent(draftPrPreview);
  if (
    draftPrPreviewJson.operation !== "pr_create_draft"
    || !draftPrPreviewJson.command?.args?.includes("--draft")
    || !draftPrPreviewJson.command?.args?.includes("--title")
  ) {
    throw new Error("pr_create_draft preview did not build the expected draft PR command");
  }
  const callsBeforeDraftPrExecute = readCommandLog().length;
  const draftPrExecute = await request("tools/call", {
    name: "github_mutation_execute",
    arguments: { approvalToken: draftPrPreviewJson.approvalToken }
  });
  const draftPrCalls = readCommandLog()
    .slice(callsBeforeDraftPrExecute)
    .filter((call) => call.bin === "gh" && call.args[0] === "pr" && call.args[1] === "create");
  if (jsonContent(draftPrExecute).status !== 0 || draftPrCalls.length !== 1 || draftPrCalls[0].tokenAccount !== "owner") {
    throw new Error("pr_create_draft execution did not use command-scoped owner identity");
  }

  const callsBeforeInlinePreview = readCommandLog().length;
  const inlinePreview = await request("tools/call", {
    name: "github_mutation_preview",
    arguments: {
      operation: "pull_request_review_comment",
      payload: {
        repo: "owner/repo",
        number: 1,
        body: "Inline contract preview only.",
        commitId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        path: "src/app.py",
        line: 42,
        side: "RIGHT"
      }
    }
  });
  const inlinePreviewJson = jsonContent(inlinePreview);
  if (inlinePreviewJson.operation !== "pull_request_review_comment") {
    throw new Error("inline review comment preview did not preserve operation");
  }
  if (
    !inlinePreviewJson.command?.args?.includes("repos/owner/repo/pulls/1/comments")
    || !inlinePreviewJson.command.args.includes("line=42")
    || !inlinePreviewJson.command.args.includes(
      "commit_id=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    )
  ) {
    throw new Error("inline review comment preview did not build the expected gh api command");
  }
  if (readCommandLog().length !== callsBeforeInlinePreview) {
    throw new Error("inline review comment preview should not invoke gh or git");
  }

  await expectToolError(
    "github_mutation_preview",
    {
      operation: "pull_request_review",
      payload: {
        repo: "owner/repo",
        number: 1,
        commitId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        comments: []
      }
    },
    "payload.comments must contain between 1 and 50 comments"
  );
  await expectToolError(
    "github_mutation_preview",
    {
      operation: "pull_request_review",
      payload: {
        repo: "owner/repo",
        number: 1,
        commitId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        comments: Array.from({ length: 51 }, () => ({
          path: "src/app.py",
          line: 1,
          body: "Too many"
        }))
      }
    },
    "payload.comments must contain between 1 and 50 comments"
  );
  await expectToolError(
    "github_mutation_preview",
    {
      operation: "pull_request_review",
      payload: {
        repo: "owner/repo",
        number: 1,
        commitId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        comments: [{ path: "src/app.py", line: 1 }]
      }
    },
    "payload.comments[0].body is required"
  );
  await expectToolError(
    "github_mutation_preview",
    {
      operation: "pull_request_review",
      payload: {
        repo: "owner/repo",
        number: 1,
        commitId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        comments: [{ path: "src/app.py", line: 1, side: "CENTER", body: "Invalid side" }]
      }
    },
    "payload.comments[0].side must be LEFT or RIGHT"
  );
  await expectToolError(
    "github_mutation_preview",
    {
      operation: "pull_request_review",
      payload: {
        repo: "owner/repo",
        number: 1,
        commitId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        event: "REQUEST_CHANGES",
        comments: [{ path: "src/app.py", line: 1, body: "Unsupported event" }]
      }
    },
    "payload.event must be COMMENT"
  );
  await expectToolError(
    "github_mutation_preview",
    {
      operation: "pull_request_review",
      payload: {
        repo: "owner/repo",
        number: 1,
        commitId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        comments: [{ path: "src/app.py", line: 1, body: "Missing review summary" }]
      }
    },
    "payload.body is required"
  );

  const callsBeforeBatchPreview = readCommandLog().length;
  const batchPreview = await request("tools/call", {
    name: "github_mutation_preview",
    arguments: {
      operation: "pull_request_review",
      payload: {
        repo: "owner/repo",
        number: 1,
        commitId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        body: "Batch review summary",
        comments: [
          {
            path: "src/app.py",
            line: 42,
            body: "First batch comment."
          },
          {
            path: "src/app.py",
            startLine: 44,
            line: 45,
            side: "RIGHT",
            body: "Second batch comment."
          }
        ]
      }
    }
  });
  const batchPreviewJson = jsonContent(batchPreview);
  if (
    batchPreviewJson.operation !== "pull_request_review"
    || !batchPreviewJson.approvalToken
    || batchPreviewJson.request?.endpoint !== "repos/owner/repo/pulls/1/reviews"
    || batchPreviewJson.requestBody?.comments?.length !== 2
    || batchPreviewJson.requestBody?.comments?.[1]?.start_line !== 44
    || !batchPreviewJson.command?.args?.includes("--input")
  ) {
    throw new Error("pull_request_review preview did not expose the expected batch request");
  }
  if (readCommandLog().length !== callsBeforeBatchPreview) {
    throw new Error("pull_request_review preview should not invoke gh or git");
  }

  const callsBeforeBatchExecute = readCommandLog().length;
  const batchExecute = await request("tools/call", {
    name: "github_mutation_execute",
    arguments: {
      approvalToken: batchPreviewJson.approvalToken
    }
  });
  const batchExecuteJson = jsonContent(batchExecute);
  const batchCalls = readCommandLog()
    .slice(callsBeforeBatchExecute)
    .filter((call) => call.bin === "gh" && call.args[0] === "api");
  if (
    batchCalls.length !== 2
    || batchCalls[0].args[1] !== "--method"
    || batchCalls[0].args[2] !== "POST"
    || batchCalls[0].args[3] !== "repos/owner/repo/pulls/1/reviews"
    || !batchCalls[0].args.includes("--input")
    || batchCalls[1].args[1] !== "repos/owner/repo/pulls/1/reviews/80/comments?per_page=100"
  ) {
    throw new Error("pull_request_review execute did not create one review and read back its comments");
  }
  const reviewPayload = readJsonlFile(reviewLog).at(-1)?.payload;
  if (
    reviewPayload?.comments?.length !== 2
    || reviewPayload.comments[0]?.body !== "First batch comment."
    || reviewPayload.comments[1]?.start_line !== 44
  ) {
    throw new Error("pull_request_review execute did not pass the expected JSON payload on stdin");
  }
  if (
    batchExecuteJson.review?.id !== 80
    || batchExecuteJson.readbackVerified !== true
    || batchExecuteJson.postedCommentCount !== 2
    || batchExecuteJson.comments?.some((comment) => comment.exactMatch !== true)
  ) {
    throw new Error("pull_request_review execute did not return review readback evidence");
  }

  fs.writeFileSync(stateFile, JSON.stringify({
    detached: false,
    head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    prListMode: "match",
    prNumber: 292,
    reviewReadbackMode: "mismatch"
  }), "utf8");
  const mismatchedBatchPreview = await request("tools/call", {
    name: "github_mutation_preview",
    arguments: {
      operation: "pull_request_review",
      payload: {
        repo: "owner/repo",
        number: 1,
        commitId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        body: "Batch review summary",
        comments: [{ path: "src/app.py", line: 42, body: "Mismatch batch comment." }]
      }
    }
  });
  const mismatchedBatchExecute = await request("tools/call", {
    name: "github_mutation_execute",
    arguments: {
      approvalToken: jsonContent(mismatchedBatchPreview).approvalToken
    }
  });
  const mismatchedBatchExecuteJson = jsonContent(mismatchedBatchExecute);
  if (
    mismatchedBatchExecuteJson.writeSucceeded !== true
    || mismatchedBatchExecuteJson.readbackVerified !== false
    || mismatchedBatchExecuteJson.comments?.[0]?.lineMatches !== false
    || !mismatchedBatchExecuteJson.warnings?.[0]?.includes("could not be verified exactly")
  ) {
    throw new Error("pull_request_review execute should report exact readback mismatch evidence");
  }

  fs.writeFileSync(stateFile, JSON.stringify({
    detached: false,
    head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    prListMode: "match",
    prNumber: 292,
    reviewReadbackMode: "fail"
  }), "utf8");
  const failedReadbackBatchPreview = await request("tools/call", {
    name: "github_mutation_preview",
    arguments: {
      operation: "pull_request_review",
      payload: {
        repo: "owner/repo",
        number: 1,
        commitId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        body: "Batch review summary",
        comments: [{ path: "src/app.py", line: 42, body: "Readback failure batch comment." }]
      }
    }
  });
  const failedReadbackBatchExecute = await request("tools/call", {
    name: "github_mutation_execute",
    arguments: {
      approvalToken: jsonContent(failedReadbackBatchPreview).approvalToken
    }
  });
  const failedReadbackBatchExecuteJson = jsonContent(failedReadbackBatchExecute);
  if (
    failedReadbackBatchExecute.result?.isError === true
    || failedReadbackBatchExecuteJson.writeSucceeded !== true
    || failedReadbackBatchExecuteJson.readbackVerified !== false
    || failedReadbackBatchExecuteJson.review?.id !== 80
    || !failedReadbackBatchExecuteJson.warnings?.[0]?.includes("Do not retry blindly")
  ) {
    throw new Error("pull_request_review execute should return created review evidence when readback fails");
  }
  fs.writeFileSync(stateFile, JSON.stringify({
    detached: false,
    head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    prListMode: "match",
    prNumber: 292
  }), "utf8");

  const callsBeforeInlineEditPreview = readCommandLog().length;
  const inlineEditPreview = await request("tools/call", {
    name: "github_mutation_preview",
    arguments: {
      operation: "pull_request_review_comment_edit",
      payload: {
        repo: "owner/repo",
        commentId: 456,
        body: "Edited inline contract preview only."
      }
    }
  });
  const inlineEditPreviewJson = jsonContent(inlineEditPreview);
  if (
    inlineEditPreviewJson.operation !== "pull_request_review_comment_edit"
    || !inlineEditPreviewJson.command?.args?.includes("repos/owner/repo/pulls/comments/456")
  ) {
    throw new Error("inline review comment edit preview did not build expected command");
  }
  if (readCommandLog().length !== callsBeforeInlineEditPreview) {
    throw new Error("inline review comment edit preview should not invoke gh or git");
  }

  const callsBeforeIssueCommentEditPreview = readCommandLog().length;
  const issueCommentEditPreview = await request("tools/call", {
    name: "github_mutation_preview",
    arguments: {
      operation: "issue_comment_edit",
      payload: {
        repo: "owner/repo",
        commentId: 789,
        body: "Edited issue contract preview only."
      }
    }
  });
  const issueCommentEditPreviewJson = jsonContent(issueCommentEditPreview);
  if (
    issueCommentEditPreviewJson.operation !== "issue_comment_edit"
    || !issueCommentEditPreviewJson.command?.args?.includes("repos/owner/repo/issues/comments/789")
  ) {
    throw new Error("issue comment edit preview did not build expected command");
  }
  if (readCommandLog().length !== callsBeforeIssueCommentEditPreview) {
    throw new Error("issue comment edit preview should not invoke gh or git");
  }

  fs.writeFileSync(stateFile, JSON.stringify({
    detached: false,
    head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    prListMode: "match",
    prNumber: 292,
    denyRepoViewFor: "fallback/repo"
  }), "utf8");
  const fallbackPreview = await request("tools/call", {
    name: "github_mutation_preview",
    arguments: {
      operation: "issue_comment",
      payload: {
        repo: "fallback/repo",
        number: 1,
        body: "Fallback auth should not execute."
      }
    }
  });
  const fallbackPreviewJson = jsonContent(fallbackPreview);
  const fallbackExecute = await request("tools/call", {
    name: "github_mutation_execute",
    arguments: {
      approvalToken: fallbackPreviewJson.approvalToken
    }
  });
  if (fallbackExecute.result?.isError !== true || !textContent(fallbackExecute).includes("without verified command-scoped GitHub auth")) {
    throw new Error("github_mutation_execute must fail closed instead of writing with active-account fallback auth");
  }
  fs.writeFileSync(stateFile, JSON.stringify({
    detached: false,
    head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    prListMode: "match",
    prNumber: 292
  }), "utf8");

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
