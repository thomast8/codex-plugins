#!/usr/bin/env node

import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLIENT_INFO = {
  name: "codex-worktree-rebind",
  title: "Codex Worktree Rebind",
  version: "0.1.0",
};

const DEFAULT_CAPABILITIES = {
  experimentalApi: true,
};

const DEFAULT_COPY_GLOBS = [".env", ".env.local", ".env.*.local", ".envrc"];
const VALID_BRANCH_RE =
  /^(feat|feature|fix|chore|docs|refactor|test|ci|build|perf|hotfix|release|revert|codex)\/[a-z0-9._-]+$/;

function printUsageAndExit() {
  process.stderr.write(
    [
      "Usage:",
      "  rebind-current-thread.mjs --branch <branch> --source <repo-root> [--thread-id <id>] [--dry-run] [--open-app-fallback]",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

export function parseArgs(argv) {
  const options = {
    dryRun: false,
    openAppFallback: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--branch":
        options.branch = argv[(i += 1)];
        break;
      case "--source":
        options.source = argv[(i += 1)];
        break;
      case "--thread-id":
        options.threadId = argv[(i += 1)];
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--open-app-fallback":
        options.openAppFallback = true;
        break;
      case "-h":
      case "--help":
        printUsageAndExit();
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.branch || !options.source) {
    throw new Error("--branch and --source are required.");
  }

  return options;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 1024 * 1024 * 10,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null,
  };
}

function runChecked(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    const commandText = [command, ...args].join(" ");
    const detail = result.stderr.trim() || result.stdout.trim() || result.error?.message || "command failed";
    throw new Error(`${commandText}: ${detail}`);
  }
  return result.stdout;
}

function realpathMaybe(value) {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return value;
  }
}

function samePath(left, right) {
  return realpathMaybe(left) === realpathMaybe(right);
}

export function resolveCodexHome(env = process.env, homeDir = os.homedir()) {
  return env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(homeDir, ".codex");
}

export function resolveRepoRoot(source) {
  const absoluteSource = path.resolve(source);
  const root = runChecked("git", ["-C", absoluteSource, "rev-parse", "--show-toplevel"]).trim();
  return root || absoluteSource;
}

export function buildStableWorktreeId(sourceRoot, branch) {
  return crypto
    .createHash("sha256")
    .update(`${realpathMaybe(sourceRoot)}\0${branch}`)
    .digest("hex")
    .slice(0, 8);
}

export function buildWorktreePath({ codexHome, sourceRoot, branch }) {
  const repoName = path.basename(sourceRoot);
  return path.join(codexHome, "worktrees", buildStableWorktreeId(sourceRoot, branch), repoName);
}

function git(sourceRoot, args) {
  return run("git", ["-C", sourceRoot, ...args]);
}

function gitChecked(sourceRoot, args) {
  return runChecked("git", ["-C", sourceRoot, ...args]);
}

function hasRef(sourceRoot, ref) {
  return git(sourceRoot, ["show-ref", "--verify", "--quiet", ref]).status === 0;
}

function listRegisteredWorktrees(sourceRoot) {
  const result = gitChecked(sourceRoot, ["worktree", "list", "--porcelain"]);
  const worktrees = [];
  for (const line of result.split("\n")) {
    if (line.startsWith("worktree ")) {
      worktrees.push(line.slice("worktree ".length));
    }
  }
  return worktrees;
}

function resolveDefaultBranch(sourceRoot) {
  const symbolic = git(sourceRoot, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const ref = symbolic.stdout.trim();
    const branch = ref.split("/").pop();
    if (branch) {
      return branch;
    }
  }

  for (const candidate of ["main", "master"]) {
    if (
      hasRef(sourceRoot, `refs/remotes/origin/${candidate}`) ||
      hasRef(sourceRoot, `refs/heads/${candidate}`)
    ) {
      return candidate;
    }
  }
  return "main";
}

function branchTargetForDetach(sourceRoot, branch) {
  if (hasRef(sourceRoot, `refs/heads/${branch}`)) {
    return branch;
  }
  if (hasRef(sourceRoot, `refs/remotes/origin/${branch}`)) {
    return `origin/${branch}`;
  }
  return branch;
}

function addWorktree(sourceRoot, worktreePath, branch) {
  const hasLocal = hasRef(sourceRoot, `refs/heads/${branch}`);
  const hasRemote = hasRef(sourceRoot, `refs/remotes/origin/${branch}`);
  let args;
  let mode;

  if (hasLocal) {
    args = ["worktree", "add", worktreePath, branch];
    mode = "local-branch";
  } else if (hasRemote) {
    args = ["worktree", "add", "--track", "-b", branch, worktreePath, `origin/${branch}`];
    mode = "remote-branch";
  } else {
    if (!VALID_BRANCH_RE.test(branch)) {
      throw new Error(`branch not found locally or on origin, and name is not a valid new branch: ${branch}`);
    }
    const defaultBranch = resolveDefaultBranch(sourceRoot);
    const baseRef = hasRef(sourceRoot, `refs/remotes/origin/${defaultBranch}`)
      ? `origin/${defaultBranch}`
      : defaultBranch;
    args = ["worktree", "add", "-b", branch, worktreePath, baseRef];
    mode = "new-branch";
  }

  const addResult = git(sourceRoot, args);
  if (addResult.status === 0) {
    return { mode, detached: false, warning: null };
  }

  const detail = `${addResult.stderr}\n${addResult.stdout}`;
  if (!detail.includes("already checked out") && !detail.includes("is already used by worktree")) {
    throw new Error(detail.trim() || `git ${args.join(" ")} failed`);
  }

  const detachTarget = branchTargetForDetach(sourceRoot, branch);
  const detachedResult = git(sourceRoot, ["worktree", "add", "--detach", worktreePath, detachTarget]);
  if (detachedResult.status !== 0) {
    throw new Error(detachedResult.stderr.trim() || detachedResult.stdout.trim() || "detached worktree add failed");
  }

  return {
    mode: "detached",
    detached: true,
    warning: "branch is already checked out elsewhere; worktree is detached, so do not commit directly",
  };
}

function pullFastForward(worktreePath) {
  const upstream = git(worktreePath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (upstream.status !== 0) {
    return "not tracking a remote";
  }

  const pull = git(worktreePath, ["pull", "--ff-only"]);
  if (pull.status !== 0) {
    return "pull failed (non-ff or remote unavailable) - check manually";
  }
  if (pull.stdout.includes("Already up to date")) {
    return "already at remote tip";
  }
  return "pulled latest from remote";
}

function globSegmentToRegex(segment) {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
}

function expandGlob(root, pattern) {
  const parts = pattern.split(/[\\/]+/).filter(Boolean);
  const results = [];

  function visit(currentDir, index) {
    if (index >= parts.length) {
      if (fs.existsSync(currentDir) && fs.statSync(currentDir).isFile()) {
        results.push(currentDir);
      }
      return;
    }

    const part = parts[index];
    const hasWildcard = part.includes("*") || part.includes("?");
    if (!hasWildcard) {
      visit(path.join(currentDir, part), index + 1);
      return;
    }

    if (!fs.existsSync(currentDir) || !fs.statSync(currentDir).isDirectory()) {
      return;
    }
    const matcher = globSegmentToRegex(part);
    for (const entry of fs.readdirSync(currentDir)) {
      if (matcher.test(entry)) {
        visit(path.join(currentDir, entry), index + 1);
      }
    }
  }

  visit(root, 0);
  return results;
}

function readCopyGlobs(sourceRoot) {
  const confPath = path.join(sourceRoot, ".codex", "worktree.conf");
  if (!fs.existsSync(confPath)) {
    return DEFAULT_COPY_GLOBS;
  }

  const content = fs.readFileSync(confPath, "utf8");
  const match = content.match(/^\s*WORKTREE_COPY_GLOBS\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\n#]*))/m);
  const raw = match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
  const globs = raw.split(/\s+/).map((item) => item.trim()).filter(Boolean);
  return globs.length > 0 ? globs : DEFAULT_COPY_GLOBS;
}

function copyDevFiles(sourceRoot, worktreePath) {
  const copied = [];
  const skipped = [];
  for (const pattern of readCopyGlobs(sourceRoot)) {
    for (const src of expandGlob(sourceRoot, pattern)) {
      const rel = path.relative(sourceRoot, src);
      const dst = path.join(worktreePath, rel);
      if (fs.existsSync(dst)) {
        skipped.push(rel);
        continue;
      }
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      copied.push(rel);
    }
  }
  return { copied, skipped };
}

export function prepareWorktree({ sourceRoot, branch, worktreePath, dryRun = false }) {
  const registered = listRegisteredWorktrees(sourceRoot);
  const alreadyRegistered = registered.some((candidate) => samePath(candidate, worktreePath));

  if (dryRun) {
    return {
      prepared: false,
      reused: alreadyRegistered,
      created: false,
      worktreePath,
      pull: "dry-run",
      copied: [],
      skipped: [],
      warning: null,
    };
  }

  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

  let addInfo = { mode: "reused", detached: false, warning: null };
  if (!alreadyRegistered) {
    if (fs.existsSync(worktreePath)) {
      throw new Error(`collision: ${worktreePath} exists but is not a registered worktree`);
    }
    addInfo = addWorktree(sourceRoot, worktreePath, branch);
  }

  const pull = pullFastForward(worktreePath);
  const { copied, skipped } = copyDevFiles(sourceRoot, worktreePath);

  return {
    prepared: true,
    reused: alreadyRegistered,
    created: !alreadyRegistered,
    mode: addInfo.mode,
    detached: addInfo.detached,
    worktreePath,
    pull,
    copied,
    skipped,
    warning: addInfo.warning,
  };
}

function workspaceStateSlug(cwd) {
  const slugSource = path.basename(cwd) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = crypto.createHash("sha256").update(realpathMaybe(cwd)).digest("hex").slice(0, 16);
  return `${slug}-${hash}`;
}

export function companionStateDir(cwd, env = process.env) {
  const stateRoot = env.CLAUDE_PLUGIN_DATA
    ? path.join(env.CLAUDE_PLUGIN_DATA, "state")
    : path.join(os.tmpdir(), "codex-companion");
  return path.join(stateRoot, workspaceStateSlug(cwd));
}

function readBrokerEndpointFromState(stateFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return typeof parsed.endpoint === "string" ? parsed.endpoint : null;
  } catch {
    return null;
  }
}

function addEndpointCandidate(candidates, seen, source, endpoint) {
  if (!endpoint) {
    return;
  }
  const normalized = normalizeEndpoint(endpoint);
  if (!normalized || seen.has(`${normalized.kind}:${normalized.path}`)) {
    return;
  }
  seen.add(`${normalized.kind}:${normalized.path}`);
  candidates.push({ source, endpoint, ...normalized });
}

function scanBrokerStateFiles(candidates, seen) {
  const root = path.join(os.tmpdir(), "codex-companion");
  if (!fs.existsSync(root)) {
    return;
  }
  for (const entry of fs.readdirSync(root).slice(0, 50)) {
    const stateFile = path.join(root, entry, "broker.json");
    if (fs.existsSync(stateFile)) {
      addEndpointCandidate(candidates, seen, `broker-state:${stateFile}`, readBrokerEndpointFromState(stateFile));
    }
  }
}

export function discoverEndpointCandidates({
  env = process.env,
  sourceRoot,
  worktreePath,
  codexHome,
  homeDir = os.homedir(),
}) {
  const candidates = [];
  const seen = new Set();
  const envNames = [
    "CODEX_COMPANION_APP_SERVER_ENDPOINT",
    "CODEX_APP_SERVER_ENDPOINT",
    "CODEX_APP_SERVER_CONTROL_ENDPOINT",
    "CODEX_APP_SERVER_SOCKET",
    "CODEX_APP_SERVER_CONTROL_SOCKET",
  ];

  for (const name of envNames) {
    addEndpointCandidate(candidates, seen, `env:${name}`, env[name]);
  }

  for (const cwd of [sourceRoot, worktreePath].filter(Boolean)) {
    const stateFile = path.join(companionStateDir(cwd, env), "broker.json");
    if (fs.existsSync(stateFile)) {
      addEndpointCandidate(candidates, seen, `broker-state:${stateFile}`, readBrokerEndpointFromState(stateFile));
    }
  }
  scanBrokerStateFiles(candidates, seen);

  for (const root of new Set([codexHome, path.join(homeDir, ".codex"), path.join(homeDir, ".Codex")])) {
    addEndpointCandidate(
      candidates,
      seen,
      `default-socket:${root}`,
      path.join(root, "app-server-control", "app-server-control.sock"),
    );
  }

  return candidates;
}

export function normalizeEndpoint(endpoint) {
  if (typeof endpoint !== "string" || !endpoint.trim()) {
    return null;
  }
  const value = endpoint.trim();
  if (value.startsWith("unix://")) {
    return { kind: "unix", path: value.slice("unix://".length) };
  }
  if (value.startsWith("unix:")) {
    return { kind: "unix", path: value.slice("unix:".length) };
  }
  if (value.startsWith("pipe:")) {
    return { kind: "pipe", path: value.slice("pipe:".length) };
  }
  if (value.startsWith("ws://") || value.startsWith("wss://")) {
    return { kind: "websocket", path: value, url: value };
  }
  if (path.isAbsolute(value)) {
    return { kind: "unix", path: value };
  }
  return null;
}

function timeoutError(label) {
  return new Error(`${label} timed out`);
}

function removeOneTrailingNewline(value) {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

function encodeWebSocketTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const mask = crypto.randomBytes(4);
  let headerLength = 2;
  if (payload.length >= 126 && payload.length <= 0xffff) {
    headerLength += 2;
  } else if (payload.length > 0xffff) {
    headerLength += 8;
  }

  const frame = Buffer.alloc(headerLength + 4 + payload.length);
  frame[0] = 0x81;
  if (payload.length < 126) {
    frame[1] = 0x80 | payload.length;
  } else if (payload.length <= 0xffff) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(payload.length, 2);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  mask.copy(frame, headerLength);
  for (let i = 0; i < payload.length; i += 1) {
    frame[headerLength + 4 + i] = payload[i] ^ mask[i % 4];
  }
  return frame;
}

class WebSocketUnixTextTransport extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => this.handleData(chunk));
    socket.on("error", (error) => this.emit("error", error));
    socket.on("end", () => this.emit("end"));
    socket.on("close", () => this.emit("close"));
  }

  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      let offset = 2;
      let length = second & 0x7f;
      if (length === 126) {
        if (this.buffer.length < offset + 2) {
          return;
        }
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) {
          return;
        }
        const bigLength = this.buffer.readBigUInt64BE(offset);
        if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.emit("error", new Error("websocket frame is too large"));
          this.socket.destroy();
          return;
        }
        length = Number(bigLength);
        offset += 8;
      }

      const masked = (second & 0x80) !== 0;
      let mask = null;
      if (masked) {
        if (this.buffer.length < offset + 4) {
          return;
        }
        mask = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      if (this.buffer.length < offset + length) {
        return;
      }

      let payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if (mask) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i += 1) {
          payload[i] ^= mask[i % 4];
        }
      }

      if (opcode === 0x1) {
        this.emit("data", `${payload.toString("utf8")}\n`);
      } else if (opcode === 0x8) {
        this.socket.end();
        this.emit("close");
        return;
      } else if (opcode === 0x9) {
        this.socket.write(Buffer.from([0x8a, 0x00]));
      }
    }
  }

  write(value) {
    this.socket.write(encodeWebSocketTextFrame(removeOneTrailingNewline(value)));
  }

  end() {
    this.socket.end();
  }
}

class WebSocketUrlTextTransport extends EventEmitter {
  constructor(ws) {
    super();
    this.ws = ws;
    ws.addEventListener("message", (event) => {
      this.emit("data", `${event.data.toString()}\n`);
    });
    ws.addEventListener("error", (event) => {
      this.emit("error", new Error(event.message || "websocket error"));
    });
    ws.addEventListener("close", () => this.emit("close"));
  }

  write(value) {
    this.ws.send(removeOneTrailingNewline(value));
  }

  end() {
    this.ws.close();
  }
}

function connectRawJsonlUnix(candidate, timeoutMs = 300) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: candidate.path });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(timeoutError("raw unix connection"));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function connectWebSocketUnix(candidate, timeoutMs = 750) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: candidate.path });
    const key = crypto.randomBytes(16).toString("base64");
    const expectedAccept = crypto
      .createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    let buffer = Buffer.alloc(0);

    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(timeoutError("websocket unix handshake"));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }
      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const rest = buffer.subarray(headerEnd + 4);
      const lines = header.split("\r\n");
      const status = lines[0] ?? "";
      const headers = new Map();
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(":");
        if (colon !== -1) {
          headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
        }
      }
      if (!status.includes("101") || headers.get("sec-websocket-accept") !== expectedAccept) {
        cleanup();
        socket.destroy();
        reject(new Error(`websocket unix handshake failed: ${status}`));
        return;
      }

      cleanup();
      const transport = new WebSocketUnixTextTransport(socket);
      if (rest.length > 0) {
        transport.handleData(rest);
      }
      resolve(transport);
    }

    socket.once("connect", () => {
      socket.write(
        [
          "GET / HTTP/1.1",
          "Host: localhost",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.on("data", onData);
    socket.once("error", onError);
  });
}

function connectWebSocketUrl(candidate, timeoutMs = 1000) {
  if (typeof WebSocket === "undefined") {
    return Promise.reject(new Error("global WebSocket is not available in this Node runtime"));
  }
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(candidate.url);
    const timer = setTimeout(() => {
      ws.close();
      reject(timeoutError("websocket connection"));
    }, timeoutMs);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(new WebSocketUrlTextTransport(ws));
    }, { once: true });
    ws.addEventListener("error", (event) => {
      clearTimeout(timer);
      reject(new Error(event.message || "websocket connection failed"));
    }, { once: true });
  });
}

async function connectToEndpoint(candidate, timeoutMs = 750) {
  if (candidate.kind === "websocket") {
    return connectWebSocketUrl(candidate, timeoutMs);
  }
  if (candidate.kind === "unix" || candidate.kind === "pipe") {
    try {
      return await connectWebSocketUnix(candidate, timeoutMs);
    } catch (websocketError) {
      try {
        return await connectRawJsonlUnix(candidate, timeoutMs);
      } catch (rawError) {
        throw new Error(`websocket=${websocketError.message}; raw=${rawError.message}`);
      }
    }
  }
  throw new Error(`unsupported endpoint kind: ${candidate.kind}`);
}

export function buildInitializeRequest(id) {
  return {
    id,
    method: "initialize",
    params: {
      clientInfo: CLIENT_INFO,
      capabilities: DEFAULT_CAPABILITIES,
    },
  };
}

export function buildThreadResumeRequest(id, threadId, cwd) {
  return {
    id,
    method: "thread/resume",
    params: {
      threadId,
      cwd,
    },
  };
}

class JsonRpcClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    socket.on("data", (chunk) => this.handleChunk(chunk));
  }

  handleChunk(chunk) {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      this.handleLine(line);
      index = this.buffer.indexOf("\n");
    }
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }
    const message = JSON.parse(line);
    if (message.id !== undefined && message.method) {
      this.send({
        id: message.id,
        error: { code: -32601, message: `Unsupported server request: ${message.method}` },
      });
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    if (message.error) {
      const error = new Error(message.error.message || "JSON-RPC request failed");
      error.data = message.error;
      pending.reject(error);
    } else {
      pending.resolve(message.result ?? {});
    }
  }

  send(message) {
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  async initialize() {
    const id = this.nextId;
    this.nextId += 1;
    await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send(buildInitializeRequest(id));
    });
    this.send({ method: "initialized", params: {} });
  }

  close() {
    this.socket.end();
  }
}

export function classifyRebindResult({ endpointFound, threadLoaded, resumeSucceeded }) {
  if (resumeSucceeded) {
    return "rebound";
  }
  if (!endpointFound || !threadLoaded) {
    return "unsupported";
  }
  return "prepared_only";
}

async function probeLoadedThread(candidates, threadId) {
  const attempts = [];
  for (const candidate of candidates) {
    let client = null;
    try {
      const socket = await connectToEndpoint(candidate);
      client = new JsonRpcClient(socket);
      await client.initialize();
      const loaded = await client.request("thread/loaded/list", {});
      const threadLoaded = Array.isArray(loaded.data) && loaded.data.includes(threadId);
      attempts.push({ ...candidate, reachable: true, threadLoaded });
      client.close();
      if (threadLoaded) {
        return { endpointFound: true, threadLoaded: true, candidate, attempts };
      }
    } catch (error) {
      attempts.push({ ...candidate, reachable: false, error: error.message });
      client?.close();
    }
  }
  return { endpointFound: attempts.some((attempt) => attempt.reachable), threadLoaded: false, candidate: null, attempts };
}

async function tryRebind(candidates, threadId, worktreePath) {
  const attempts = [];
  for (const candidate of candidates) {
    let client = null;
    try {
      const socket = await connectToEndpoint(candidate);
      client = new JsonRpcClient(socket);
      await client.initialize();
      const loaded = await client.request("thread/loaded/list", {});
      const threadLoaded = Array.isArray(loaded.data) && loaded.data.includes(threadId);
      if (!threadLoaded) {
        attempts.push({ ...candidate, reachable: true, threadLoaded: false });
        client.close();
        continue;
      }

      let resumed;
      try {
        resumed = await new Promise((resolve, reject) => {
          const id = client.nextId;
          client.nextId += 1;
          client.pending.set(id, { resolve, reject });
          client.send(buildThreadResumeRequest(id, threadId, worktreePath));
        });
      } catch (error) {
        attempts.push({
          ...candidate,
          reachable: true,
          threadLoaded: true,
          resumeSucceeded: false,
          error: error.message,
        });
        client.close();
        continue;
      }
      const returnedCwd = resumed.cwd ?? resumed.thread?.cwd ?? null;
      const resumeSucceeded = returnedCwd ? samePath(returnedCwd, worktreePath) : false;
      attempts.push({ ...candidate, reachable: true, threadLoaded: true, resumeSucceeded, returnedCwd });
      client.close();
      if (resumeSucceeded) {
        return { endpointFound: true, threadLoaded: true, resumeSucceeded: true, attempts, candidate };
      }
    } catch (error) {
      attempts.push({ ...candidate, reachable: false, error: error.message });
      client?.close();
    }
  }

  return {
    endpointFound: attempts.some((attempt) => attempt.reachable),
    threadLoaded: attempts.some((attempt) => attempt.threadLoaded),
    resumeSucceeded: false,
    attempts,
    candidate: null,
  };
}

function openCodexApp(worktreePath) {
  const child = spawn("codex", ["app", worktreePath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { pid: child.pid ?? null };
}

function writeResult(result, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(exitCode);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    writeResult({ status: "failed", error: error.message }, 1);
  }

  const threadId = options.threadId || process.env.CODEX_THREAD_ID || null;
  let sourceRoot;
  let worktreePath;

  try {
    sourceRoot = resolveRepoRoot(options.source);
    const codexHome = resolveCodexHome(process.env, os.homedir());
    worktreePath = buildWorktreePath({ codexHome, sourceRoot, branch: options.branch });
    const endpointCandidates = discoverEndpointCandidates({
      env: process.env,
      sourceRoot,
      worktreePath,
      codexHome,
      homeDir: os.homedir(),
    });

    if (options.dryRun) {
      const endpointProbe = threadId
        ? await probeLoadedThread(endpointCandidates, threadId)
        : { endpointFound: false, threadLoaded: false, attempts: [], missingThreadId: true };
      writeResult({
        status: "prepared_only",
        dryRun: true,
        branch: options.branch,
        sourceRoot,
        worktreePath,
        threadId,
        endpointCandidates,
        endpointProbe,
      });
    }

    const preparation = prepareWorktree({
      sourceRoot,
      branch: options.branch,
      worktreePath,
      dryRun: false,
    });

    if (!threadId) {
      writeResult({
        status: "unsupported",
        reason: "missing CODEX_THREAD_ID and no --thread-id was provided",
        branch: options.branch,
        sourceRoot,
        worktreePath,
        preparation,
      });
    }

    const rebind = await tryRebind(endpointCandidates, threadId, worktreePath);
    const status = classifyRebindResult(rebind);
    if (status === "rebound") {
      writeResult({
        status,
        branch: options.branch,
        sourceRoot,
        worktreePath,
        threadId,
        preparation,
        rebind,
      });
    }

    if (options.openAppFallback) {
      const opened = openCodexApp(worktreePath);
      writeResult({
        status: "fallback_opened",
        reason: "same-thread rebind was not available; opened Codex Desktop at the prepared worktree",
        branch: options.branch,
        sourceRoot,
        worktreePath,
        threadId,
        preparation,
        rebind,
        opened,
      });
    }

    writeResult({
      status,
      reason:
        status === "unsupported"
          ? "no reachable app-server endpoint had this thread loaded"
          : "thread was loaded but app-server did not accept a cwd rebind",
      branch: options.branch,
      sourceRoot,
      worktreePath,
      threadId,
      preparation,
      rebind,
    });
  } catch (error) {
    writeResult(
      {
        status: "failed",
        branch: options?.branch ?? null,
        sourceRoot: sourceRoot ?? null,
        worktreePath: worktreePath ?? null,
        threadId,
        error: error.message,
      },
      1,
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
