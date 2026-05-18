#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const serverPath = join(pluginRoot, "scripts", "github-mcp.mjs");
const fakeBinDir = fs.mkdtempSync(join(os.tmpdir(), "github-local-ops-contract-"));
const commandLog = join(fakeBinDir, "commands.jsonl");
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
if (args[0] === "branch" && args[1] === "--show-current") {
  console.log("main");
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

const child = spawn(process.execPath, [serverPath], {
  cwd: pluginRoot,
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    GITHUB_LOCAL_OPS_GH_BIN: fakeGh,
    GITHUB_LOCAL_OPS_GIT_BIN: fakeGit,
    FAKE_COMMAND_LOG: commandLog
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
  if (previewJson.executableByTool !== false) {
    throw new Error("github_mutation_preview should report execution disabled by default");
  }
  if (readCommandLog().length !== callsAfterStatus) {
    throw new Error("github_mutation_preview should not invoke gh or git");
  }

  const execute = await request("tools/call", {
    name: "github_mutation_execute",
    arguments: {}
  });
  if (execute.result?.isError !== true) {
    throw new Error("github_mutation_execute without token should fail");
  }
  if (readCommandLog().length !== callsAfterStatus) {
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
