#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import process from "node:process";

const SERVER_NAME = "github-local-ops";
const SERVER_VERSION = "0.1.0";
const GH_BIN = process.env.GITHUB_LOCAL_OPS_GH_BIN || "gh";
const GIT_BIN = process.env.GITHUB_LOCAL_OPS_GIT_BIN || "git";
const TOKEN_TTL_MS = Number(process.env.GITHUB_LOCAL_OPS_APPROVAL_TTL_MS || 10 * 60 * 1000);
const FETCH_TTL_MS = Number(process.env.GITHUB_LOCAL_OPS_FETCH_TTL_MS || 5 * 60 * 1000);
const PUBLIC_WRITES_ENABLED = /^(1|true|yes)$/i.test(process.env.GITHUB_LOCAL_OPS_ENABLE_PUBLIC_WRITES || "");
const DEFAULT_LIMIT = 30;
const DEFAULT_MAX_BYTES = 200000;
const approvals = new Map();
const fetchCache = new Map();

const repoSchema = {
  repo: {
    type: "string",
    description: "Repository in OWNER/REPO form. Defaults to the repository for cwd."
  },
  cwd: {
    type: "string",
    description: "Working directory to run gh or git from. Defaults to the MCP server cwd."
  }
};

const autoFetchSchema = {
  autoFetch: {
    type: "boolean",
    description: "Fetch refs before resolving local repository context. Defaults to false; pass true only after the workflow needs fresh refs."
  }
};

const limitSchema = {
  limit: {
    type: "integer",
    minimum: 1,
    maximum: 100,
    description: "Maximum number of items to return."
  }
};

const maxBytesSchema = {
  maxBytes: {
    type: "integer",
    minimum: 1000,
    maximum: 5000000,
    description: "Maximum stdout bytes to return before truncating."
  }
};

function objectSchema(properties, required = []) {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required
  };
}

const TOOLS = [
  {
    name: "github_setup_status",
    description: "Check whether local git, gh authentication, and repository resolution are ready for GitHub Local Ops.",
    inputSchema: objectSchema({
      ...repoSchema,
      ...autoFetchSchema
    })
  },
  {
    name: "github_current_context",
    description: "Inspect the current git checkout, branch, remote, gh auth status, and resolved GitHub repo.",
    inputSchema: objectSchema({
      cwd: repoSchema.cwd,
      ...autoFetchSchema
    })
  },
  {
    name: "github_repo_view",
    description: "Read repository metadata using gh repo view.",
    inputSchema: objectSchema({
      ...repoSchema,
      ...autoFetchSchema,
      fields: {
        type: "array",
        items: { type: "string" },
        description: "Optional gh repo view JSON fields."
      }
    })
  },
  {
    name: "github_pr_list",
    description: "List pull requests for a repository.",
    inputSchema: objectSchema({
      ...repoSchema,
      ...autoFetchSchema,
      ...limitSchema,
      state: {
        type: "string",
        enum: ["open", "closed", "merged", "all"],
        description: "PR state filter."
      },
      search: {
        type: "string",
        description: "Optional gh search expression for PR list."
      }
    })
  },
  {
    name: "github_pr_view",
    description: "Read detailed pull request metadata.",
    inputSchema: objectSchema({
      ...repoSchema,
      ...autoFetchSchema,
      number: {
        type: ["integer", "string"],
        description: "PR number, URL, or branch. Defaults to the current branch PR."
      },
      fields: {
        type: "array",
        items: { type: "string" },
        description: "Optional gh pr view JSON fields."
      }
    })
  },
  {
    name: "github_pr_diff",
    description: "Read a pull request diff or changed file list.",
    inputSchema: objectSchema({
      ...repoSchema,
      ...autoFetchSchema,
      ...maxBytesSchema,
      number: {
        type: ["integer", "string"],
        description: "PR number, URL, or branch. Defaults to the current branch PR."
      },
      patch: {
        type: "boolean",
        description: "Return patch format."
      },
      nameOnly: {
        type: "boolean",
        description: "Return changed file names only."
      },
      exclude: {
        type: "array",
        items: { type: "string" },
        description: "File patterns to exclude."
      }
    })
  },
  {
    name: "github_pr_review_threads",
    description: "Read pull request review threads and inline comments through GitHub GraphQL.",
    inputSchema: objectSchema({
      ...repoSchema,
      ...autoFetchSchema,
      number: {
        type: "integer",
        minimum: 1,
        description: "PR number."
      }
    }, ["number"])
  },
  {
    name: "github_checks",
    description: "Read checks for a pull request.",
    inputSchema: objectSchema({
      ...repoSchema,
      ...autoFetchSchema,
      number: {
        type: ["integer", "string"],
        description: "PR number, URL, or branch. Defaults to the current branch PR."
      },
      requiredOnly: {
        type: "boolean",
        description: "Show only required checks."
      }
    })
  },
  {
    name: "github_actions_runs",
    description: "List recent GitHub Actions workflow runs.",
    inputSchema: objectSchema({
      ...repoSchema,
      ...autoFetchSchema,
      ...limitSchema,
      branch: { type: "string" },
      commit: { type: "string" },
      event: { type: "string" },
      status: { type: "string" },
      workflow: { type: "string" },
      includeDisabled: { type: "boolean" }
    })
  },
  {
    name: "github_issue_list",
    description: "List GitHub issues for a repository.",
    inputSchema: objectSchema({
      ...repoSchema,
      ...autoFetchSchema,
      ...limitSchema,
      state: {
        type: "string",
        enum: ["open", "closed", "all"]
      },
      search: { type: "string" },
      label: {
        type: "array",
        items: { type: "string" }
      },
      assignee: { type: "string" },
      author: { type: "string" }
    })
  },
  {
    name: "github_issue_view",
    description: "Read detailed issue metadata.",
    inputSchema: objectSchema({
      ...repoSchema,
      ...autoFetchSchema,
      number: {
        type: ["integer", "string"],
        description: "Issue number or URL."
      },
      comments: {
        type: "boolean",
        description: "Include issue comments."
      }
    }, ["number"])
  },
  {
    name: "github_release_list",
    description: "List releases for a repository.",
    inputSchema: objectSchema({
      ...repoSchema,
      ...autoFetchSchema,
      ...limitSchema,
      excludeDrafts: { type: "boolean" },
      excludePreReleases: { type: "boolean" },
      order: {
        type: "string",
        enum: ["asc", "desc"]
      }
    })
  },
  {
    name: "github_search",
    description: "Search GitHub issues, PRs, code, or repositories.",
    inputSchema: objectSchema({
      type: {
        type: "string",
        enum: ["issues", "prs", "code", "repos"]
      },
      query: {
        type: "string",
        description: "GitHub search query."
      },
      ...limitSchema,
      repo: repoSchema.repo,
      owner: {
        type: "string",
        description: "Optional owner filter for code or repo search."
      }
    }, ["type", "query"])
  },
  {
    name: "github_mutation_preview",
    description: "Preview a public GitHub write. Does not mutate GitHub state.",
    inputSchema: objectSchema({
      cwd: repoSchema.cwd,
      operation: {
        type: "string",
        enum: [
          "pr_comment",
          "review_thread_reply",
          "pr_edit",
          "request_reviewers",
          "issue_comment",
          "issue_label",
          "workflow_dispatch",
          "rerun_failed_workflow",
          "create_release"
        ]
      },
      payload: {
        type: "object",
        description: "Operation-specific payload. The preview response shows the exact gh command or GraphQL call."
      }
    }, ["operation", "payload"])
  },
  {
    name: "github_mutation_execute",
    description: "Execute a previously previewed public GitHub write. Disabled unless GITHUB_LOCAL_OPS_ENABLE_PUBLIC_WRITES is set in the MCP process environment.",
    inputSchema: objectSchema({
      approvalToken: {
        type: "string",
        description: "Token returned by github_mutation_preview."
      },
      maxBytes: maxBytesSchema.maxBytes
    }, ["approvalToken"])
  }
];

function cwdFrom(input = {}) {
  return input.cwd || process.cwd();
}

function truncate(value, maxBytes = DEFAULT_MAX_BYTES) {
  if (value.length <= maxBytes) {
    return { text: value, truncated: false, bytes: Buffer.byteLength(value) };
  }
  const buffer = Buffer.from(value);
  return {
    text: buffer.subarray(0, maxBytes).toString("utf8"),
    truncated: true,
    bytes: buffer.length,
    returnedBytes: maxBytes
  };
}

function run(bin, args, options = {}) {
  const cwd = options.cwd || process.cwd();
  const result = spawnSync(bin, args.map(String), {
    cwd,
    encoding: "utf8",
    maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
    env: process.env
  });
  const command = [bin, ...args.map(String)];
  if (result.error) {
    const error = new Error(`Failed to run ${command.join(" ")}: ${result.error.message}`);
    error.command = command;
    throw error;
  }
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  if (result.status !== 0 && !options.allowFailure) {
    const message = stderr.trim() || stdout.trim() || `exit ${result.status}`;
    const error = new Error(`${command.join(" ")} failed: ${message}`);
    error.command = command;
    error.stdout = stdout;
    error.stderr = stderr;
    error.status = result.status;
    throw error;
  }
  return {
    command,
    cwd,
    status: result.status,
    stdout,
    stderr
  };
}

function runGh(args, options = {}) {
  const result = run(GH_BIN, args, options);
  if (!options.json) {
    return result;
  }
  const text = result.stdout.trim();
  return {
    ...result,
    data: text ? JSON.parse(text) : null
  };
}

function runGit(args, options = {}) {
  return run(GIT_BIN, args, options);
}

function safeRunGh(args, options = {}) {
  try {
    return runGh(args, { ...options, allowFailure: true });
  } catch (error) {
    return failedRun(GH_BIN, args, options, error);
  }
}

function safeRunGit(args, options = {}) {
  try {
    return runGit(args, { ...options, allowFailure: true });
  } catch (error) {
    return failedRun(GIT_BIN, args, options, error);
  }
}

function failedRun(bin, args, options, error) {
  return {
    command: error.command || [bin, ...args.map(String)],
    cwd: options.cwd || process.cwd(),
    status: null,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
    data: null
  };
}

function addRepo(args, repo) {
  if (!repo) {
    return args;
  }
  return [...args, "--repo", repo];
}

function limitValue(limit) {
  if (limit == null) {
    return DEFAULT_LIMIT;
  }
  const value = Number(limit);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("limit must be an integer between 1 and 100");
  }
  return value;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requireNumberLike(value, name) {
  if (value == null || String(value).trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return String(value);
}

function requirePositiveInteger(value, name) {
  const text = requireNumberLike(value, name).trim();
  if (!/^[1-9]\d*$/.test(text)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return text;
}

function requireNonOptionString(value, name) {
  const text = requireString(value, name);
  if (text.startsWith("-")) {
    throw new Error(`${name} must not start with '-'`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(text)) {
    throw new Error(`${name} must not contain control characters`);
  }
  return text;
}

function requireNonOptionList(value, name) {
  if (Array.isArray(value)) {
    return value.map((item, index) => requireNonOptionString(item, `${name}[${index}]`)).join(",");
  }
  return requireNonOptionString(value, name);
}

function requireFieldKey(value, name) {
  const text = requireNonOptionString(value, name);
  if (!/^[A-Za-z0-9_.-]+$/.test(text)) {
    throw new Error(`${name} must contain only letters, numbers, dots, underscores, or hyphens`);
  }
  return text;
}

function redactGitRemote(value) {
  const remote = trimOrNull(value);
  if (!remote) {
    return null;
  }
  return remote.replace(/^(https?:\/\/)([^/@\s]+)@/i, "$1[redacted]@");
}

function fields(values, fallback) {
  if (Array.isArray(values) && values.length > 0) {
    return values.map(String).join(",");
  }
  return fallback;
}

function parseRepoName(value) {
  const repo = requireNonOptionString(value, "repo");
  const clean = repo.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  const parts = clean.split("/");
  if (parts.length < 2 || !/^[A-Za-z0-9_.-]+$/.test(parts[0]) || !/^[A-Za-z0-9_.-]+$/.test(parts[1])) {
    throw new Error("repo must be in OWNER/REPO form");
  }
  return { owner: parts[0], name: parts[1], nameWithOwner: `${parts[0]}/${parts[1]}` };
}

function parseRepoFromGitRemote(value) {
  if (!value) {
    return null;
  }
  const match = value.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (!match) {
    return null;
  }
  return parseRepoName(`${match[1]}/${match[2]}`);
}

function resolveRepo(input = {}) {
  if (input.repo) {
    return parseRepoName(input.repo);
  }
  const cwd = cwdFrom(input);
  const result = runGh(["repo", "view", "--json", "nameWithOwner"], { cwd, json: true });
  return parseRepoName(result.data.nameWithOwner);
}

function trimOrNull(value) {
  const trimmed = String(value || "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function compactSha(value) {
  const trimmed = trimOrNull(value);
  return trimmed ? trimmed.slice(0, 12) : null;
}

function maybeAutoFetch(input = {}) {
  const cwd = cwdFrom(input);
  if (input.autoFetch !== true) {
    return { attempted: false, ok: null, skippedReason: "autoFetch disabled" };
  }

  const gitRoot = safeRunGit(["rev-parse", "--show-toplevel"], { cwd });
  if (gitRoot.status !== 0) {
    return { attempted: false, ok: null, skippedReason: "cwd is not inside a git repository" };
  }

  const root = gitRoot.stdout.trim();
  const remotes = safeRunGit(["remote"], { cwd: root });
  const remoteNames = remotes.status === 0
    ? remotes.stdout.split("\n").map((remote) => remote.trim()).filter(Boolean)
    : [];
  if (remoteNames.length === 0) {
    return { attempted: false, ok: null, gitRoot: root, skippedReason: "git checkout has no remotes" };
  }

  if (input.repo) {
    const origin = safeRunGit(["remote", "get-url", "origin"], { cwd: root });
    const originRepo = origin.status === 0 ? parseRepoFromGitRemote(origin.stdout) : null;
    const targetRepo = parseRepoName(input.repo);
    if (originRepo && originRepo.nameWithOwner.toLowerCase() !== targetRepo.nameWithOwner.toLowerCase()) {
      return {
        attempted: false,
        ok: null,
        gitRoot: root,
        remotes: remoteNames,
        skippedReason: `cwd origin is ${originRepo.nameWithOwner}, explicit repo is ${targetRepo.nameWithOwner}`
      };
    }
  }

  const cacheKey = `${root}\0${remoteNames.join("\0")}`;
  const cached = fetchCache.get(cacheKey);
  if (cached && Date.now() - cached.checkedAt <= FETCH_TTL_MS) {
    return {
      ...cached.freshness,
      cached: true,
      cacheAgeMs: Date.now() - cached.checkedAt
    };
  }

  const fetchedAt = new Date().toISOString();
  const fetch = safeRunGit(["fetch", "--all"], { cwd: root });
  const freshness = {
    attempted: true,
    ok: fetch.status === 0,
    command: fetch.command,
    cwd: root,
    remotes: remoteNames,
    fetchedAt,
    cached: false,
    stdout: trimOrNull(fetch.stdout),
    stderr: trimOrNull(fetch.stderr),
    status: fetch.status
  };
  if (freshness.ok) {
    fetchCache.set(cacheKey, { checkedAt: Date.now(), freshness });
  }
  return freshness;
}

function freshnessWarnings(freshness) {
  if (!freshness || !freshness.attempted || freshness.ok) {
    return [];
  }
  return [`auto-fetch failed: ${freshness.stderr || freshness.stdout || `exit ${freshness.status}`}`];
}

function summarizeRepo(repo, freshness = null) {
  if (!repo) {
    return { kind: "repository", fetched: freshness?.ok ?? null };
  }
  return {
    kind: "repository",
    repository: repo.nameWithOwner || repo.fullName || null,
    defaultBranch: repo.defaultBranchRef?.name || null,
    visibility: repo.visibility || (repo.isPrivate ? "PRIVATE" : "PUBLIC"),
    viewerPermission: repo.viewerPermission || null,
    isArchived: repo.isArchived ?? null,
    isFork: repo.isFork ?? null,
    pushedAt: repo.pushedAt || null,
    url: repo.url || null,
    fetched: freshness?.ok ?? null
  };
}

function summarizePr(pr, freshness = null) {
  if (!pr) {
    return { kind: "pull_request", fetched: freshness?.ok ?? null };
  }
  return {
    kind: "pull_request",
    number: pr.number ?? null,
    title: pr.title || null,
    state: pr.state || null,
    isDraft: pr.isDraft ?? null,
    base: pr.baseRefName || null,
    head: pr.headRefName || null,
    headOid: compactSha(pr.headRefOid),
    reviewDecision: pr.reviewDecision || null,
    mergeable: pr.mergeable || null,
    changedFiles: pr.changedFiles ?? pr.files?.length ?? null,
    url: pr.url || null,
    fetched: freshness?.ok ?? null
  };
}

function summarizePrList(pullRequests, freshness = null) {
  const prs = Array.isArray(pullRequests) ? pullRequests : [];
  return {
    kind: "pull_request_list",
    count: prs.length,
    drafts: prs.filter((pr) => pr.isDraft).length,
    reviewRequired: prs.filter((pr) => pr.reviewDecision === "REVIEW_REQUIRED").length,
    bases: [...new Set(prs.map((pr) => pr.baseRefName).filter(Boolean))],
    fetched: freshness?.ok ?? null
  };
}

function summarizeDiff(text, truncated, freshness = null) {
  const files = text.trim() ? text.trim().split("\n").filter(Boolean) : [];
  return {
    kind: "pull_request_diff",
    changedFiles: files.length > 0 ? files.length : null,
    truncated,
    fetched: freshness?.ok ?? null
  };
}

function summarizeReviewThreads(pullRequest, freshness = null) {
  const threads = pullRequest?.reviewThreads?.nodes || [];
  return {
    kind: "review_threads",
    pullRequest: pullRequest?.number || null,
    count: threads.length,
    unresolved: threads.filter((thread) => !thread.isResolved).length,
    outdated: threads.filter((thread) => thread.isOutdated).length,
    fetched: freshness?.ok ?? null
  };
}

function summarizeChecks(checks, pending, freshness = null) {
  const items = Array.isArray(checks) ? checks : [];
  return {
    kind: "checks",
    pending,
    total: items.length,
    pass: items.filter((check) => check.bucket === "pass" || check.state === "SUCCESS").length,
    fail: items.filter((check) => check.bucket === "fail" || check.state === "FAILURE").length,
    skipping: items.filter((check) => check.bucket === "skipping" || check.state === "SKIPPED").length,
    fetched: freshness?.ok ?? null
  };
}

function summarizeList(kind, items, freshness = null) {
  const values = Array.isArray(items) ? items : [];
  return {
    kind,
    count: values.length,
    fetched: freshness?.ok ?? null
  };
}

function normalizeSearchQuery(query, inputRepo) {
  const repoPattern = /\brepo:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/g;
  const repos = [...query.matchAll(repoPattern)].map((match) => match[1]);
  const warnings = [];
  let normalizedQuery = query;
  let repo = inputRepo || null;

  if (repos.length > 0) {
    normalizedQuery = query.replace(repoPattern, "").replace(/\s+/g, " ").trim();
    const queryRepo = repos[0];
    if (!repo) {
      repo = queryRepo;
      warnings.push("repo: qualifier moved to the repo argument for gh search compatibility");
    } else if (repo.toLowerCase() === queryRepo.toLowerCase()) {
      warnings.push("repo: qualifier normalized into the repo argument for gh search compatibility");
    } else {
      warnings.push(`repo argument ${repo} ignored because query specifies repo:${queryRepo}`);
      repo = queryRepo;
    }
    if (repos.length > 1) {
      warnings.push("multiple repo: qualifiers found; using the first one");
    }
  }

  return {
    query: normalizedQuery || query,
    repo,
    warnings
  };
}

function commandPreview(command) {
  return command.map(quoteArg).join(" ");
}

function quoteArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) {
    return text;
  }
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function firstLine(value) {
  const text = value.trim();
  return text ? text.split("\n")[0] : null;
}

function outputText(result) {
  return result.stdout.trim() || result.stderr.trim() || null;
}

function parseGhAccounts(statusText) {
  const accounts = [];
  let current = null;
  for (const line of statusText.split("\n")) {
    const login = line.match(/^\s*✓ Logged in to github\.com account (\S+)/);
    if (login) {
      current = { login: login[1], active: false };
      accounts.push(current);
      continue;
    }
    if (current && line.includes("- Active account: true")) {
      current.active = true;
    }
  }
  return accounts;
}

function accountSwitchHint(targetRepo, accounts) {
  if (!targetRepo || accounts.length < 2) {
    return null;
  }
  const owner = targetRepo.owner.toLowerCase();
  const active = accounts.find((account) => account.active);
  if (owner.includes("kyndryl")) {
    const kyndryl = accounts.find((account) => account.login.toLowerCase().includes("kyndryl"));
    if (kyndryl && !kyndryl.active) {
      return `Active gh account is ${active?.login || "unknown"}; run gh auth switch --user ${kyndryl.login} for ${targetRepo.nameWithOwner}.`;
    }
  }
  if (active) {
    return `Active gh account is ${active.login}; run gh auth switch --user <account> if another authenticated account has access to ${targetRepo.nameWithOwner}.`;
  }
  return `Run gh auth switch --user <account> if another authenticated account has access to ${targetRepo.nameWithOwner}.`;
}

async function githubSetupStatus(input = {}) {
  const cwd = cwdFrom(input);
  const freshness = maybeAutoFetch(input);
  const ghVersion = safeRunGh(["--version"], { cwd });
  const gitVersion = safeRunGit(["--version"], { cwd });
  const auth = safeRunGh(["auth", "status"], { cwd });
  const gitRoot = safeRunGit(["rev-parse", "--show-toplevel"], { cwd });
  const branch = safeRunGit(["branch", "--show-current"], { cwd });
  const origin = safeRunGit(["remote", "get-url", "origin"], { cwd });
  const originRepo = origin.status === 0 ? parseRepoFromGitRemote(origin.stdout) : null;
  const targetRepo = input.repo ? parseRepoName(input.repo) : originRepo;
  const repoArgs = targetRepo
    ? ["repo", "view", targetRepo.nameWithOwner, "--json", "nameWithOwner,url,defaultBranchRef,viewerPermission,isPrivate,description"]
    : ["repo", "view", "--json", "nameWithOwner,url,defaultBranchRef,viewerPermission,isPrivate,description"];
  const repo = safeRunGh(repoArgs, { cwd, json: true });
  const authText = outputText(auth) || "";
  const accounts = parseGhAccounts(authText);
  const switchHint = accountSwitchHint(targetRepo, accounts);

  const ghAvailable = ghVersion.status === 0;
  const gitAvailable = gitVersion.status === 0;
  const authOk = auth.status === 0;
  const repoResolved = repo.status === 0 && repo.data !== null;
  const configured = ghAvailable && gitAvailable && authOk && repoResolved;

  const warnings = [
    gitAvailable ? null : `git is unavailable at ${GIT_BIN}`,
    ghAvailable ? null : `gh is unavailable at ${GH_BIN}`,
    authOk ? null : "gh authentication is not ready or cannot be inspected from this environment",
    repoResolved ? null : "gh could not resolve the target repository",
    ...freshnessWarnings(freshness)
  ].filter(Boolean);

  const nextSteps = [];
  if (!ghAvailable) {
    nextSteps.push("Install GitHub CLI or set GITHUB_LOCAL_OPS_GH_BIN to the gh binary path.");
  }
  if (!gitAvailable) {
    nextSteps.push("Install git or set GITHUB_LOCAL_OPS_GIT_BIN to the git binary path.");
  }
  if (!authOk) {
    nextSteps.push("Run gh auth status, then gh auth login or gh auth switch outside repo files if the active account is wrong.");
  }
  if (!repoResolved) {
    if (targetRepo) {
      nextSteps.push(switchHint || `Verify the active gh account can access ${targetRepo.nameWithOwner}.`);
    } else {
      nextSteps.push("Pass repo as OWNER/REPO or run from a checkout with a GitHub origin.");
    }
  }
  if (configured) {
    nextSteps.push("Use read tools for evidence, then github_mutation_preview before any public write.");
  }

  return {
    configured,
    cwd,
    checks: {
      gitAvailable,
      ghAvailable,
      authOk,
      repoResolved
    },
    binaries: {
      gh: {
        path: GH_BIN,
        version: firstLine(ghVersion.stdout),
        status: ghVersion.status
      },
      git: {
        path: GIT_BIN,
        version: firstLine(gitVersion.stdout),
        status: gitVersion.status
      }
    },
    freshness,
    abstract: {
      kind: "setup_status",
      configured,
      repository: repoResolved ? repo.data.nameWithOwner : null,
      branch: branch.status === 0 ? branch.stdout.trim() : null,
      activeAccount: accounts.find((account) => account.active)?.login || null,
      fetched: freshness.ok,
      warnings: warnings.length
    },
    auth: {
      ok: authOk,
      activeAccount: accounts.find((account) => account.active)?.login || null,
      accounts,
      status: authText || null
    },
    git: {
      root: gitRoot.status === 0 ? gitRoot.stdout.trim() : null,
      branch: branch.status === 0 ? branch.stdout.trim() : null,
      origin: origin.status === 0 ? redactGitRemote(origin.stdout) : null
    },
    repositoryTarget: targetRepo,
    repository: repoResolved ? repo.data : null,
    warnings,
    nextSteps
  };
}

async function githubCurrentContext(input = {}) {
  const cwd = cwdFrom(input);
  const freshness = maybeAutoFetch(input);
  const gitRoot = safeRunGit(["rev-parse", "--show-toplevel"], { cwd });
  const branch = safeRunGit(["branch", "--show-current"], { cwd });
  const head = safeRunGit(["rev-parse", "HEAD"], { cwd });
  const remote = safeRunGit(["remote", "get-url", "origin"], { cwd });
  const repo = safeRunGh(["repo", "view", "--json", "nameWithOwner,url,defaultBranchRef,viewerPermission,isPrivate,description"], {
    cwd,
    json: true,
    allowFailure: true
  });
  const auth = safeRunGh(["auth", "status"], { cwd });
  const git = {
    root: gitRoot.status === 0 ? gitRoot.stdout.trim() : null,
    branch: branch.status === 0 ? branch.stdout.trim() : null,
    head: head.status === 0 ? head.stdout.trim() : null,
    origin: remote.status === 0 ? redactGitRemote(remote.stdout) : null
  };
  const github = repo.status === 0 ? repo.data : null;
  const warnings = [
    gitRoot.status === 0 ? null : "cwd is not inside a git repository",
    repo.status === 0 ? null : "gh could not resolve a repository for cwd",
    ...freshnessWarnings(freshness)
  ].filter(Boolean);
  return {
    cwd,
    git,
    github,
    freshness,
    abstract: {
      kind: "current_context",
      repository: github?.nameWithOwner || null,
      branch: git.branch,
      head: compactSha(git.head),
      defaultBranch: github?.defaultBranchRef?.name || null,
      viewerPermission: github?.viewerPermission || null,
      fetched: freshness.ok,
      warnings: warnings.length
    },
    ghAuthStatus: auth.stdout.trim() || auth.stderr.trim(),
    warnings
  };
}

async function githubRepoView(input = {}) {
  const cwd = cwdFrom(input);
  const freshness = maybeAutoFetch(input);
  const jsonFields = fields(
    input.fields,
    "nameWithOwner,description,defaultBranchRef,homepageUrl,isArchived,isFork,isPrivate,owner,pushedAt,updatedAt,url,viewerPermission,visibility"
  );
  const args = ["repo", "view"];
  if (input.repo) {
    args.push(input.repo);
  }
  args.push("--json", jsonFields);
  const result = runGh(args, { cwd, json: true });
  return {
    command: result.command,
    freshness,
    abstract: summarizeRepo(result.data, freshness),
    repo: result.data,
    warnings: freshnessWarnings(freshness)
  };
}

async function githubPrList(input = {}) {
  const cwd = cwdFrom(input);
  const freshness = maybeAutoFetch(input);
  const args = [
    "pr",
    "list",
    "--json",
    "number,title,state,isDraft,author,baseRefName,headRefName,reviewDecision,reviewRequests,updatedAt,url",
    "--limit",
    limitValue(input.limit)
  ];
  if (input.state) {
    args.push("--state", input.state);
  }
  if (input.search) {
    args.push("--search", input.search);
  }
  const result = runGh(addRepo(args, input.repo), { cwd, json: true });
  return {
    command: result.command,
    freshness,
    abstract: summarizePrList(result.data, freshness),
    pullRequests: result.data,
    warnings: freshnessWarnings(freshness)
  };
}

async function githubPrView(input = {}) {
  const cwd = cwdFrom(input);
  const freshness = maybeAutoFetch(input);
  const args = ["pr", "view"];
  if (input.number != null) {
    args.push(String(input.number));
  }
  args.push(
    "--json",
    fields(
      input.fields,
      "number,title,state,isDraft,author,baseRefName,baseRefOid,headRefName,headRefOid,body,changedFiles,files,reviewDecision,reviewRequests,latestReviews,mergeable,mergeStateStatus,statusCheckRollup,updatedAt,url"
    )
  );
  const result = runGh(addRepo(args, input.repo), { cwd, json: true });
  return {
    command: result.command,
    freshness,
    abstract: summarizePr(result.data, freshness),
    pullRequest: result.data,
    warnings: freshnessWarnings(freshness)
  };
}

async function githubPrDiff(input = {}) {
  const cwd = cwdFrom(input);
  const freshness = maybeAutoFetch(input);
  const args = ["pr", "diff"];
  if (input.number != null) {
    args.push(String(input.number));
  }
  args.push("--color", "never");
  if (input.patch) {
    args.push("--patch");
  }
  if (input.nameOnly) {
    args.push("--name-only");
  }
  if (Array.isArray(input.exclude)) {
    for (const pattern of input.exclude) {
      args.push("--exclude", String(pattern));
    }
  }
  const result = runGh(addRepo(args, input.repo), { cwd });
  const diff = truncate(result.stdout, input.maxBytes || DEFAULT_MAX_BYTES);
  return {
    command: result.command,
    freshness,
    abstract: summarizeDiff(diff.text, diff.truncated, freshness),
    diff,
    stderr: result.stderr.trim() || null,
    warnings: freshnessWarnings(freshness)
  };
}

async function githubPrReviewThreads(input = {}) {
  const cwd = cwdFrom(input);
  const freshness = maybeAutoFetch(input);
  const repo = resolveRepo(input);
  const number = Number(input.number);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error("number must be a positive integer");
  }
  const query = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      number
      title
      url
      reviewDecision
      isDraft
      reviewThreads(first: 100) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          startLine
          originalLine
          originalStartLine
          subjectType
          comments(first: 100) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              body
              author { login }
              createdAt
              updatedAt
              url
              path
              line
              originalLine
              diffHunk
              outdated
              replyTo { id }
            }
          }
        }
      }
    }
  }
}`;
  const result = runGh(
    [
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-f",
      `owner=${repo.owner}`,
      "-f",
      `name=${repo.name}`,
      "-F",
      `number=${number}`
    ],
    { cwd, json: true }
  );
  const pullRequest = result.data.data.repository.pullRequest;
  const truncated = Boolean(
    pullRequest?.reviewThreads?.pageInfo?.hasNextPage
    || pullRequest?.reviewThreads?.nodes?.some((thread) => thread.comments?.pageInfo?.hasNextPage)
  );
  const warnings = freshnessWarnings(freshness);
  if (truncated) {
    warnings.push("Review thread result is truncated at 100 threads or 100 comments per thread.");
  }
  return {
    command: result.command,
    repository: repo.nameWithOwner,
    freshness,
    abstract: summarizeReviewThreads(pullRequest, freshness),
    pullRequest,
    truncated,
    warnings
  };
}

async function githubChecks(input = {}) {
  const cwd = cwdFrom(input);
  const freshness = maybeAutoFetch(input);
  const args = ["pr", "checks"];
  if (input.number != null) {
    args.push(String(input.number));
  }
  args.push("--json", "bucket,completedAt,description,event,link,name,startedAt,state,workflow");
  if (input.requiredOnly) {
    args.push("--required");
  }
  const result = runGh(addRepo(args, input.repo), { cwd, json: true, allowFailure: true });
  if (result.status !== 0 && result.status !== 8) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "gh pr checks failed");
  }
  return {
    command: result.command,
    pending: result.status === 8,
    freshness,
    abstract: summarizeChecks(result.data, result.status === 8, freshness),
    checks: result.data,
    warnings: freshnessWarnings(freshness)
  };
}

async function githubActionsRuns(input = {}) {
  const cwd = cwdFrom(input);
  const freshness = maybeAutoFetch(input);
  const args = [
    "run",
    "list",
    "--json",
    "attempt,conclusion,createdAt,databaseId,displayTitle,event,headBranch,headSha,name,number,startedAt,status,updatedAt,url,workflowDatabaseId,workflowName",
    "--limit",
    limitValue(input.limit)
  ];
  if (input.includeDisabled) {
    args.push("--all");
  }
  for (const [flag, key] of [
    ["--branch", "branch"],
    ["--commit", "commit"],
    ["--event", "event"],
    ["--status", "status"],
    ["--workflow", "workflow"]
  ]) {
    if (input[key]) {
      args.push(flag, String(input[key]));
    }
  }
  const result = runGh(addRepo(args, input.repo), { cwd, json: true });
  return {
    command: result.command,
    freshness,
    abstract: summarizeList("actions_runs", result.data, freshness),
    runs: result.data,
    warnings: freshnessWarnings(freshness)
  };
}

async function githubIssueList(input = {}) {
  const cwd = cwdFrom(input);
  const freshness = maybeAutoFetch(input);
  const args = [
    "issue",
    "list",
    "--json",
    "number,title,state,stateReason,author,assignees,labels,comments,createdAt,updatedAt,url",
    "--limit",
    limitValue(input.limit)
  ];
  if (input.state) {
    args.push("--state", input.state);
  }
  if (input.search) {
    args.push("--search", input.search);
  }
  if (Array.isArray(input.label)) {
    for (const label of input.label) {
      args.push("--label", String(label));
    }
  }
  if (input.assignee) {
    args.push("--assignee", input.assignee);
  }
  if (input.author) {
    args.push("--author", input.author);
  }
  const result = runGh(addRepo(args, input.repo), { cwd, json: true });
  return {
    command: result.command,
    freshness,
    abstract: summarizeList("issue_list", result.data, freshness),
    issues: result.data,
    warnings: freshnessWarnings(freshness)
  };
}

async function githubIssueView(input = {}) {
  const cwd = cwdFrom(input);
  const freshness = maybeAutoFetch(input);
  const args = [
    "issue",
    "view",
    requireNumberLike(input.number, "number"),
    "--json",
    "number,title,state,stateReason,author,assignees,body,comments,labels,milestone,createdAt,updatedAt,url"
  ];
  if (input.comments) {
    args.push("--comments");
  }
  const result = runGh(addRepo(args, input.repo), { cwd, json: true });
  return {
    command: result.command,
    freshness,
    abstract: {
      kind: "issue",
      number: result.data.number,
      title: result.data.title,
      state: result.data.state,
      labels: Array.isArray(result.data.labels) ? result.data.labels.map((label) => label.name) : [],
      fetched: freshness.ok
    },
    issue: result.data,
    warnings: freshnessWarnings(freshness)
  };
}

async function githubReleaseList(input = {}) {
  const cwd = cwdFrom(input);
  const freshness = maybeAutoFetch(input);
  const args = [
    "release",
    "list",
    "--json",
    "createdAt,isDraft,isImmutable,isLatest,isPrerelease,name,publishedAt,tagName",
    "--limit",
    limitValue(input.limit)
  ];
  if (input.excludeDrafts) {
    args.push("--exclude-drafts");
  }
  if (input.excludePreReleases) {
    args.push("--exclude-pre-releases");
  }
  if (input.order) {
    args.push("--order", input.order);
  }
  const result = runGh(addRepo(args, input.repo), { cwd, json: true });
  return {
    command: result.command,
    freshness,
    abstract: summarizeList("release_list", result.data, freshness),
    releases: result.data,
    warnings: freshnessWarnings(freshness)
  };
}

async function githubSearch(input = {}) {
  const rawQuery = requireString(input.query, "query");
  const search = normalizeSearchQuery(rawQuery, input.repo);
  const query = search.query;
  const limit = limitValue(input.limit);
  const type = requireString(input.type, "type");
  const base = ["search", type, query, "--limit", limit];
  if (search.repo) {
    base.push("--repo", search.repo);
  }
  if (input.owner) {
    base.push("--owner", input.owner);
  }
  const jsonFields = {
    issues: "number,title,state,repository,author,updatedAt,url,labels",
    prs: "number,title,state,repository,author,updatedAt,url,isDraft,labels",
    code: "path,repository,sha,textMatches,url",
    repos: "fullName,description,updatedAt,url,visibility"
  }[type];
  const result = runGh([...base, "--json", jsonFields], { json: true });
  return {
    command: result.command,
    abstract: summarizeList(`search_${type}`, result.data, null),
    results: result.data,
    warnings: search.warnings
  };
}

function buildMutation(operation, payload = {}, cwd = process.cwd()) {
  const repo = payload.repo ? parseRepoName(payload.repo).nameWithOwner : undefined;
  const riskNotes = ["This is a public GitHub write unless the target repository is private."];
  const command = (args) => ({ kind: "gh", bin: GH_BIN, args: addRepo(args, repo), cwd, riskNotes: [...riskNotes] });
  switch (operation) {
    case "pr_comment": {
      const number = requirePositiveInteger(payload.number, "payload.number");
      const body = requireString(payload.body, "payload.body");
      riskNotes.push("Adds a PR conversation comment.");
      return command(["pr", "comment", number, "--body", body]);
    }
    case "review_thread_reply": {
      const threadId = requireString(payload.threadId, "payload.threadId");
      const body = requireString(payload.body, "payload.body");
      const query = "mutation($threadId: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) { comment { id body url } } }";
      riskNotes.push("Posts an inline review-thread reply through GraphQL.");
      return {
        kind: "gh",
        bin: GH_BIN,
        args: ["api", "graphql", "--raw-field", `query=${query}`, "--raw-field", `threadId=${threadId}`, "--raw-field", `body=${body}`],
        cwd,
        riskNotes: [...riskNotes]
      };
    }
    case "pr_edit": {
      const number = requirePositiveInteger(payload.number, "payload.number");
      const args = ["pr", "edit", number];
      for (const [flag, key] of [
        ["--title", "title"],
        ["--body", "body"],
        ["--base", "base"],
        ["--add-label", "addLabel"],
        ["--remove-label", "removeLabel"],
        ["--add-reviewer", "addReviewer"],
        ["--remove-reviewer", "removeReviewer"]
      ]) {
        if (payload[key]) {
          const value = ["base", "addLabel", "removeLabel", "addReviewer", "removeReviewer"].includes(key)
            ? requireNonOptionList(payload[key], `payload.${key}`)
            : requireString(String(payload[key]), `payload.${key}`);
          args.push(flag, value);
        }
      }
      if (args.length === 3) {
        throw new Error("payload must include at least one supported PR edit field");
      }
      riskNotes.push("Edits PR metadata.");
      return command(args);
    }
    case "request_reviewers": {
      const number = requirePositiveInteger(payload.number, "payload.number");
      const reviewers = requireNonOptionList(payload.reviewers, "payload.reviewers");
      riskNotes.push("Requests reviewers on a PR.");
      return command(["pr", "edit", number, "--add-reviewer", reviewers]);
    }
    case "issue_comment": {
      const number = requirePositiveInteger(payload.number, "payload.number");
      const body = requireString(payload.body, "payload.body");
      riskNotes.push("Adds an issue conversation comment.");
      return command(["issue", "comment", number, "--body", body]);
    }
    case "issue_label": {
      const number = requirePositiveInteger(payload.number, "payload.number");
      const args = ["issue", "edit", number];
      if (payload.addLabel) {
        args.push("--add-label", requireNonOptionList(payload.addLabel, "payload.addLabel"));
      }
      if (payload.removeLabel) {
        args.push("--remove-label", requireNonOptionList(payload.removeLabel, "payload.removeLabel"));
      }
      if (args.length === 3) {
        throw new Error("payload.addLabel or payload.removeLabel is required");
      }
      riskNotes.push("Changes labels on an issue.");
      return command(args);
    }
    case "workflow_dispatch": {
      const workflow = requireNonOptionString(payload.workflow, "payload.workflow");
      const args = ["workflow", "run", workflow];
      if (payload.ref) {
        args.push("--ref", requireNonOptionString(payload.ref, "payload.ref"));
      }
      if (payload.fields && typeof payload.fields === "object") {
        for (const [key, value] of Object.entries(payload.fields)) {
          args.push("-f", `${requireFieldKey(key, "payload.fields key")}=${value}`);
        }
      }
      riskNotes.push("Dispatches a GitHub Actions workflow run.");
      return command(args);
    }
    case "rerun_failed_workflow": {
      const runId = requirePositiveInteger(payload.runId, "payload.runId");
      riskNotes.push("Reruns failed jobs for a workflow run.");
      return command(["run", "rerun", runId, "--failed"]);
    }
    case "create_release": {
      const tag = requireNonOptionString(payload.tag, "payload.tag");
      const args = ["release", "create", tag];
      for (const [flag, key] of [
        ["--title", "title"],
        ["--notes", "notes"],
        ["--target", "target"]
      ]) {
        if (payload[key]) {
          const value = key === "target"
            ? requireNonOptionString(payload[key], "payload.target")
            : requireString(String(payload[key]), `payload.${key}`);
          args.push(flag, value);
        }
      }
      const publish = payload.publish === true;
      if (payload.draft || !publish) {
        args.push("--draft");
      }
      if (payload.prerelease) {
        args.push("--prerelease");
      }
      riskNotes.push(publish ? "Creates and publishes a release object." : "Creates a draft release by default.");
      return command(args);
    }
    default:
      throw new Error(`Unsupported mutation operation: ${operation}`);
  }
}

function hashMutation(plan) {
  return createHash("sha256").update(JSON.stringify({
    kind: plan.kind,
    bin: plan.bin,
    args: plan.args,
    cwd: plan.cwd
  })).digest("hex");
}

async function githubMutationPreview(input = {}) {
  cleanupApprovals();
  const operation = requireString(input.operation, "operation");
  const payload = input.payload || {};
  const cwd = cwdFrom(input);
  const plan = buildMutation(operation, payload, cwd);
  const token = randomBytes(18).toString("base64url");
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
  const approval = {
    token,
    operation,
    payload,
    plan,
    hash: hashMutation(plan),
    createdAt: new Date().toISOString(),
    expiresAt
  };
  approvals.set(token, approval);
  return {
    operation,
    payload,
    command: {
      executable: plan.bin,
      args: plan.args,
      cwd: plan.cwd,
      shellPreview: commandPreview([plan.bin, ...plan.args])
    },
    riskNotes: plan.riskNotes,
    approvalToken: token,
    expiresAt,
    executableByTool: PUBLIC_WRITES_ENABLED,
    approvalText: PUBLIC_WRITES_ENABLED
      ? `Approve ${operation} before calling github_mutation_execute with this token.`
      : "Execution is disabled in this MCP process. Set GITHUB_LOCAL_OPS_ENABLE_PUBLIC_WRITES=true outside chat to allow execute after preview."
  };
}

async function githubMutationExecute(input = {}) {
  cleanupApprovals();
  const token = requireString(input.approvalToken, "approvalToken");
  const approval = approvals.get(token);
  if (!approval) {
    throw new Error("approvalToken was not found or has expired. Run github_mutation_preview again.");
  }
  if (new Date(approval.expiresAt).getTime() <= Date.now()) {
    approvals.delete(token);
    throw new Error("approvalToken has expired. Run github_mutation_preview again.");
  }
  if (!PUBLIC_WRITES_ENABLED) {
    approvals.delete(token);
    throw new Error("Public GitHub writes are disabled. Set GITHUB_LOCAL_OPS_ENABLE_PUBLIC_WRITES=true outside chat to enable github_mutation_execute.");
  }
  approvals.delete(token);
  const result = run(approval.plan.bin, approval.plan.args, { cwd: approval.plan.cwd, maxBuffer: 20 * 1024 * 1024 });
  return {
    operation: approval.operation,
    command: {
      executable: approval.plan.bin,
      args: approval.plan.args,
      cwd: approval.plan.cwd,
      shellPreview: commandPreview([approval.plan.bin, ...approval.plan.args])
    },
    stdout: truncate(result.stdout, input.maxBytes || DEFAULT_MAX_BYTES),
    stderr: truncate(result.stderr, input.maxBytes || DEFAULT_MAX_BYTES),
    status: result.status
  };
}

function cleanupApprovals() {
  const now = Date.now();
  for (const [token, approval] of approvals.entries()) {
    if (new Date(approval.expiresAt).getTime() <= now) {
      approvals.delete(token);
    }
  }
}

const HANDLERS = {
  github_setup_status: githubSetupStatus,
  github_current_context: githubCurrentContext,
  github_repo_view: githubRepoView,
  github_pr_list: githubPrList,
  github_pr_view: githubPrView,
  github_pr_diff: githubPrDiff,
  github_pr_review_threads: githubPrReviewThreads,
  github_checks: githubChecks,
  github_actions_runs: githubActionsRuns,
  github_issue_list: githubIssueList,
  github_issue_view: githubIssueView,
  github_release_list: githubReleaseList,
  github_search: githubSearch,
  github_mutation_preview: githubMutationPreview,
  github_mutation_execute: githubMutationExecute
};

function mcpContent(value, isError = false) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
      }
    ],
    isError
  };
}

async function handleToolCall(params = {}) {
  const name = params.name;
  const args = params.arguments || {};
  const handler = HANDLERS[name];
  if (!handler) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return mcpContent(await handler(args));
}

async function handleMessage(message) {
  if (!message || typeof message !== "object") {
    return null;
  }
  if (!Object.hasOwn(message, "id")) {
    return null;
  }
  try {
    switch (message.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: message.params?.protocolVersion || "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
          }
        };
      case "ping":
        return { jsonrpc: "2.0", id: message.id, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } };
      case "tools/call":
        return { jsonrpc: "2.0", id: message.id, result: await handleToolCall(message.params) };
      default:
        return {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `Method not found: ${message.method}` }
        };
    }
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: mcpContent({
        error: error instanceof Error ? error.message : String(error),
        command: error.command || null,
        status: error.status ?? null,
        stderr: error.stderr || null,
        stdout: error.stdout || null
      }, true)
    };
  }
}

async function runSelfTest() {
  const initialize = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const list = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const names = list.result.tools.map((tool) => tool.name);
  const missing = TOOLS.filter((tool) => !HANDLERS[tool.name]);
  const preview = await githubMutationPreview({
    operation: "issue_comment",
    payload: {
      repo: "owner/repo",
      number: 1,
      body: "Self-test preview only."
    }
  });
  const executeDisabled = PUBLIC_WRITES_ENABLED
    ? { ok: true, skipped: true }
    : await expectReject(() => githubMutationExecute({ approvalToken: preview.approvalToken }));
  const optionNumberRejected = await expectReject(() => githubMutationPreview({
    operation: "issue_comment",
    payload: {
      repo: "owner/repo",
      number: "--body-file=/tmp/secret",
      body: "Self-test preview only."
    }
  }));
  const optionWorkflowRejected = await expectReject(() => githubMutationPreview({
    operation: "workflow_dispatch",
    payload: {
      repo: "owner/repo",
      workflow: "--ref=main"
    }
  }));
  const optionReleaseRejected = await expectReject(() => githubMutationPreview({
    operation: "create_release",
    payload: {
      repo: "owner/repo",
      tag: "--notes-file=/tmp/secret"
    }
  }));
  const releasePreview = await githubMutationPreview({
    operation: "create_release",
    payload: {
      repo: "owner/repo",
      tag: "v0.0.0"
    }
  });
  const noToken = await expectReject(() => githubMutationExecute({}));
  const mismatch = await expectReject(() => githubMutationExecute({ approvalToken: "not-a-real-token" }));
  const expiredPlan = buildMutation("issue_comment", {
    repo: "owner/repo",
    number: 1,
    body: "Expired token self-test only."
  });
  approvals.set("expired-token", {
    token: "expired-token",
    operation: "issue_comment",
    payload: {},
    plan: expiredPlan,
    hash: hashMutation(expiredPlan),
    createdAt: new Date(Date.now() - 2000).toISOString(),
    expiresAt: new Date(Date.now() - 1000).toISOString()
  });
  const expired = await expectReject(() => githubMutationExecute({ approvalToken: "expired-token" }));
  return {
    ok: missing.length === 0
      && initialize.result.serverInfo.name === SERVER_NAME
      && noToken.ok
      && mismatch.ok
      && expired.ok
      && executeDisabled.ok
      && optionNumberRejected.ok
      && optionWorkflowRejected.ok
      && optionReleaseRejected.ok
      && releasePreview.command.args.includes("--draft"),
    server: initialize.result.serverInfo,
    toolCount: names.length,
    tools: names,
    missingHandlers: missing.map((tool) => tool.name),
    writeSafety: {
      previewDidNotExecute: preview.command.args.includes("comment"),
      executeDisabledByDefault: executeDisabled,
      optionNumberRejected,
      optionWorkflowRejected,
      optionReleaseRejected,
      releaseDefaultsToDraft: releasePreview.command.args.includes("--draft"),
      missingTokenRejected: noToken,
      mismatchedTokenRejected: mismatch,
      expiredTokenRejected: expired
    }
  };
}

async function expectReject(fn) {
  try {
    await fn();
    return { ok: false, error: "expected rejection but call succeeded" };
  } catch (error) {
    return { ok: true, error: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  const [mode, toolName, rawArgs] = process.argv.slice(2);
  if (mode === "--self-test") {
    console.log(JSON.stringify(await runSelfTest(), null, 2));
    return;
  }
  if (mode === "--call") {
    if (!toolName) {
      throw new Error("--call requires a tool name");
    }
    const parsedArgs = rawArgs ? JSON.parse(rawArgs) : {};
    const result = await HANDLERS[toolName](parsedArgs);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const response = await handleMessage(JSON.parse(trimmed));
        if (response) {
          process.stdout.write(`${JSON.stringify(response)}\n`);
        }
      } catch (error) {
        process.stdout.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: error instanceof Error ? error.message : String(error) }
        })}\n`);
      }
    }
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
