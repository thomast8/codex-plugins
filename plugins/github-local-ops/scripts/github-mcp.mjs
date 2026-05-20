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
const AUTH_CACHE_TTL_MS = Number(process.env.GITHUB_LOCAL_OPS_AUTH_CACHE_TTL_MS || 5 * 60 * 1000);
const PUBLIC_WRITES_ENABLED = publicWritesEnabled();
const DEFAULT_LIMIT = 30;
const DEFAULT_MAX_BYTES = 200000;
const GITHUB_TOKEN_ENV_KEYS = ["GH_TOKEN", "GITHUB_TOKEN"];
const approvals = new Map();
const fetchCache = new Map();
const ghAccountTokenCache = new Map();
const ghRepoAuthCache = new Map();

function publicWritesEnabled(env = process.env, argv = process.argv) {
  return /^(1|true|yes)$/i.test(env.GITHUB_LOCAL_OPS_ENABLE_PUBLIC_WRITES || "")
    || argv.slice(2).includes("--enable-public-writes");
}

const repoSchema = {
  repo: {
    type: "string",
    description: "Repository in OWNER/REPO form. Defaults to the repository for cwd."
  },
  cwd: {
    type: "string",
    description: "Working directory to run gh or git from. Defaults to the MCP server cwd."
  },
  githubAccount: {
    type: "string",
    description: "Optional GitHub login to use for this operation without switching the global gh active account. Defaults to repo-aware account selection."
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
      githubAccount: repoSchema.githubAccount,
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
    name: "github_my_pull_requests",
    description: "Discover open pull requests authored by the active gh account, or by an explicit author login, across accessible GitHub repositories using GraphQL.",
    inputSchema: objectSchema({
      cwd: repoSchema.cwd,
      githubAccount: repoSchema.githubAccount,
      ...limitSchema,
      repo: {
        type: "string",
        description: "Optional OWNER/REPO filter applied after GraphQL author discovery."
      },
      author: {
        type: "string",
        description: "Optional GitHub author login. Defaults to the active gh account through GraphQL viewer."
      },
      includeChecks: {
        type: "boolean",
        description: "Include a compact status-check summary for each PR. Defaults to false."
      },
      fallbackRepos: {
        type: "array",
        items: { type: "string" },
        description: "Optional OWNER/REPO list to use only if GraphQL author discovery fails."
      },
      allowSearchFallback: {
        type: "boolean",
        description: "Allow gh search prs fallback if GraphQL fails. This can be incomplete for private org PRs and is disabled by default."
      }
    })
  },
  {
    name: "github_pr_rebase_plan",
    description: "Build a parent-first rebase order for authored or supplied pull requests, including stacked PR dependencies and optional base staleness checks.",
    inputSchema: objectSchema({
      cwd: repoSchema.cwd,
      githubAccount: repoSchema.githubAccount,
      ...limitSchema,
      repo: {
        type: "string",
        description: "Optional OWNER/REPO filter when discovering PRs."
      },
      author: {
        type: "string",
        description: "Optional GitHub author login when discovering PRs. Defaults to the active gh account."
      },
      pullRequests: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true
        },
        description: "Optional PR metadata list, such as github_my_pull_requests.pullRequests. If omitted, the tool discovers authored PRs first."
      },
      checkStaleness: {
        type: "boolean",
        description: "Use GitHub compare API to mark PRs current, stale, or unknown against their actual base. Defaults to true."
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
        description: "PR number, URL, or branch. Defaults to the attached branch PR; detached checkouts resolve by exact local HEAD SHA."
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
        description: "PR number, URL, or branch. Defaults to the attached branch PR; detached checkouts resolve by exact local HEAD SHA."
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
        description: "PR number, URL, or branch. Defaults to the attached branch PR; detached checkouts resolve by exact local HEAD SHA."
      },
      requiredOnly: {
        type: "boolean",
        description: "Show only required checks."
      }
    })
  },
  {
    name: "github_pr_handoff_status",
    description: "Read the consolidated PR review-handoff state, including pushed code, review replies, checks, review requests, and rate-limit evidence.",
    inputSchema: objectSchema({
      ...repoSchema,
      ...autoFetchSchema,
      number: {
        type: "integer",
        minimum: 1,
        description: "PR number."
      },
      expectedHeadSha: {
        type: "string",
        description: "Expected PR head commit SHA or unique prefix."
      },
      expectedPrBodyContains: {
        type: ["string", "array"],
        items: { type: "string" },
        description: "Text or text snippets that must be present in the current PR body."
      },
      approvedReplies: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            commentId: { type: ["integer", "string"] },
            body: { type: "string" }
          },
          required: ["commentId"]
        },
        description: "Approved review-thread replies to verify as posted and read back."
      },
      expectedReviewers: {
        type: "array",
        items: { type: "string" },
        description: "Reviewer logins or team slugs expected to be requested."
      }
    }, ["number"])
  },
  {
    name: "github_review_handoff_preview",
    description: "Preview an ordered review handoff that posts approved replies, reads them back, optionally updates the PR body, re-checks CI, and then requests reviewers.",
    inputSchema: objectSchema({
      ...repoSchema,
      ...autoFetchSchema,
      number: {
        type: "integer",
        minimum: 1,
        description: "PR number."
      },
      expectedHeadSha: {
        type: "string",
        description: "Expected PR head commit SHA or unique prefix."
      },
      prBody: {
        type: "string",
        description: "Optional full PR body to apply during handoff."
      },
      approvedReplies: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            commentId: { type: ["integer", "string"] },
            body: { type: "string" }
          },
          required: ["commentId", "body"]
        },
        description: "Approved review-thread replies to post."
      },
      reviewers: {
        type: "array",
        items: { type: "string" },
        description: "Reviewers or teams to request after replies, readback, PR body update, and CI re-check."
      },
      allowReviewRequestWithFailingChecks: {
        type: "boolean",
        description: "Set true only when the user explicitly wants human re-review despite failing CI."
      }
    }, ["number"])
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
      githubAccount: repoSchema.githubAccount,
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
      githubAccount: repoSchema.githubAccount,
      operation: {
        type: "string",
        enum: [
          "pr_comment",
          "pull_request_review_comment",
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
    description: "Execute a previously previewed public GitHub write. Requires the plugin MCP process to be started with --enable-public-writes or GITHUB_LOCAL_OPS_ENABLE_PUBLIC_WRITES=true.",
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
  const env = { ...process.env, ...(options.env || {}) };
  for (const key of options.removeEnv || []) {
    delete env[key];
  }
  const result = spawnSync(bin, args.map(String), {
    cwd,
    encoding: "utf8",
    maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
    env
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
  const auth = options.disableAuthResolution ? null : ghAuthForCommand(args, options);
  if (options.requireScopedAuth && (!auth?.env || auth.summary?.strategy === "active_account_fallback")) {
    const repo = options.repoName || repoFromGhArgs(args) || null;
    throw new Error(`Refusing to execute GitHub write${repo ? ` for ${repo}` : ""} without verified command-scoped GitHub auth. Pass githubAccount or fix gh authentication for the target repo.`);
  }
  const result = run(GH_BIN, args, {
    ...options,
    env: auth?.env ? { ...(options.env || {}), ...auth.env } : options.env
  });
  if (!options.json) {
    return {
      ...result,
      auth: auth?.summary || null
    };
  }
  const text = result.stdout.trim();
  return {
    ...result,
    auth: auth?.summary || null,
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
  const result = runGh(["repo", "view", "--json", "nameWithOwner"], { cwd, json: true, githubAccount: input.githubAccount });
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

function inspectGitCheckout(cwd) {
  const gitRoot = safeRunGit(["rev-parse", "--show-toplevel"], { cwd });
  if (gitRoot.status !== 0) {
    return {
      available: false,
      reason: "cwd is not inside a git repository",
      root: null,
      branch: null,
      detached: null,
      head: null,
      worktreeCount: null
    };
  }

  const root = gitRoot.stdout.trim();
  const branch = safeRunGit(["symbolic-ref", "-q", "--short", "HEAD"], { cwd: root });
  const head = safeRunGit(["rev-parse", "HEAD"], { cwd: root });
  const worktrees = safeRunGit(["worktree", "list", "--porcelain"], { cwd: root });
  const worktreeCount = worktrees.status === 0
    ? (worktrees.stdout.match(/^worktree /gm) || []).length
    : null;

  return {
    available: true,
    reason: null,
    root,
    branch: branch.status === 0 ? trimOrNull(branch.stdout) : null,
    detached: branch.status !== 0,
    head: head.status === 0 ? trimOrNull(head.stdout) : null,
    worktreeCount
  };
}

function detachedFetchNamespace(root) {
  const rootHash = createHash("sha256").update(root || "").digest("hex").slice(0, 10);
  const unique = `${Date.now().toString(36)}-${process.pid}-${randomBytes(4).toString("hex")}`;
  return `github-local-ops/${rootHash}/${unique}`;
}

function detachedFetchRefspec(namespace) {
  return `+refs/heads/*:refs/codex-fetch/${namespace}/*`;
}

function maybeAutoFetch(input = {}) {
  const cwd = cwdFrom(input);
  if (input.autoFetch !== true) {
    return { attempted: false, ok: null, skippedReason: "autoFetch disabled" };
  }

  const checkout = inspectGitCheckout(cwd);
  if (!checkout.available) {
    return { attempted: false, ok: null, skippedReason: "cwd is not inside a git repository" };
  }

  const root = checkout.root;
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

  const fetchMode = checkout.detached ? "isolated-detached" : "shared";
  const cacheKey = `${root}\0${fetchMode}\0${remoteNames.join("\0")}`;
  const cached = fetchCache.get(cacheKey);
  if (cached && Date.now() - cached.checkedAt <= FETCH_TTL_MS) {
    return {
      ...cached.freshness,
      cached: true,
      cacheAgeMs: Date.now() - cached.checkedAt
    };
  }

  const fetchedAt = new Date().toISOString();
  const remoteName = remoteNames.includes("origin") ? "origin" : remoteNames[0];
  const isolatedNamespace = checkout.detached ? detachedFetchNamespace(root) : null;
  const refspec = isolatedNamespace ? detachedFetchRefspec(isolatedNamespace) : null;
  const fetchArgs = checkout.detached
    ? ["fetch", "--no-tags", "--refmap=", remoteName, refspec]
    : ["fetch", "--all"];
  const fetch = safeRunGit(fetchArgs, { cwd: root });
  const freshness = {
    attempted: true,
    ok: fetch.status === 0,
    command: fetch.command,
    cwd: root,
    remotes: remoteNames,
    mode: fetchMode,
    detached: checkout.detached,
    branch: checkout.branch,
    head: compactSha(checkout.head),
    worktreeCount: checkout.worktreeCount,
    isolatedNamespace,
    isolatedRefspec: refspec,
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

function summarizeAuthoredPullRequests(pullRequests, discovery) {
  const prs = Array.isArray(pullRequests) ? pullRequests : [];
  const repositories = [...new Set(prs.map((pr) => pr.repo).filter(Boolean))];
  return {
    kind: "authored_pull_request_discovery",
    count: prs.length,
    drafts: prs.filter((pr) => pr.isDraft).length,
    repositories,
    repositoryCount: repositories.length,
    author: discovery.author || null,
    activeAccount: discovery.activeAccount || null,
    strategy: discovery.strategy,
    truncated: discovery.truncated,
    warnings: discovery.warnings?.length || 0
  };
}

function summarizeRebasePlan(repositoryPlans, orderedPullRequests, warnings) {
  const allItems = repositoryPlans.flatMap((plan) => plan.pullRequests);
  return {
    kind: "pr_rebase_plan",
    count: allItems.length,
    repositories: repositoryPlans.length,
    orderedCount: orderedPullRequests.length,
    stale: allItems.filter((item) => item.staleness?.status === "stale").length,
    current: allItems.filter((item) => item.staleness?.status === "current").length,
    unknown: allItems.filter((item) => item.staleness?.status === "unknown").length,
    cycles: repositoryPlans.reduce((count, plan) => count + plan.cycles.length, 0),
    ambiguousBases: repositoryPlans.reduce((count, plan) => count + plan.ambiguousBases.length, 0),
    warnings: warnings.length
  };
}

function repoNameFromValue(value) {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  return value.nameWithOwner || value.fullName || null;
}

function loginFromAuthor(value) {
  if (!value) {
    return null;
  }
  return typeof value === "string" ? value : value.login || null;
}

function requireOptionalLogin(value, name = "author") {
  if (value == null || String(value).trim() === "") {
    return null;
  }
  const text = requireNonOptionString(value, name);
  if (!/^[A-Za-z0-9_.-]+$/.test(text)) {
    throw new Error(`${name} must contain only letters, numbers, dots, underscores, or hyphens`);
  }
  return text;
}

function normalizeOptionalRepoList(value, name = "fallbackRepos") {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array.`);
  }
  return value.map((repo, index) => parseRepoName(requireNonOptionString(repo, `${name}[${index}]`)).nameWithOwner);
}

function normalizeDiscoveryPullRequest(pr, index = 0) {
  if (!pr || typeof pr !== "object" || Array.isArray(pr)) {
    throw new Error(`pullRequests[${index}] must be an object.`);
  }
  const repo = repoNameFromValue(pr.repo || pr.repository || pr.repositoryNameWithOwner);
  const number = Number(pr.number);
  const headRepository = repoNameFromValue(pr.headRepository || pr.headRepo || pr.headRepositoryNameWithOwner);
  const normalizedRepo = repo ? parseRepoName(repo).nameWithOwner : null;
  const normalizedHeadRepository = headRepository ? parseRepoName(headRepository).nameWithOwner : null;
  return {
    repo: normalizedRepo,
    repository: normalizedRepo,
    number: Number.isFinite(number) ? number : pr.number,
    title: pr.title || null,
    url: pr.url || null,
    state: pr.state || null,
    isDraft: pr.isDraft ?? null,
    author: loginFromAuthor(pr.author) || pr.authorLogin || null,
    baseRefName: pr.baseRefName || pr.base || null,
    baseRefOid: pr.baseRefOid || pr.baseSha || null,
    headRefName: pr.headRefName || pr.head || null,
    headRepository: normalizedHeadRepository || normalizedRepo || null,
    headRefOid: pr.headRefOid || pr.headSha || null,
    headSha: pr.headSha || pr.headRefOid || null,
    updatedAt: pr.updatedAt || null,
    reviewDecision: pr.reviewDecision || null,
    checks: pr.checks || null
  };
}

function normalizeDiscoveryPullRequests(value) {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("pullRequests must be an array.");
  }
  return value.map((pr, index) => normalizeDiscoveryPullRequest(pr, index));
}

function checkSummaryFromRollup(rollup) {
  if (!rollup) {
    return null;
  }
  const contexts = rollup.contexts?.nodes || [];
  const normalized = contexts.map((context) => {
    if (context.__typename === "CheckRun") {
      return {
        type: "CheckRun",
        name: context.name || null,
        workflow: context.checkSuite?.workflowRun?.workflow?.name || null,
        status: context.status || null,
        conclusion: context.conclusion || null,
        detailsUrl: context.detailsUrl || null,
        startedAt: context.startedAt || null,
        completedAt: context.completedAt || null
      };
    }
    return {
      type: "StatusContext",
      name: context.context || null,
      status: context.state || null,
      conclusion: context.state || null,
      detailsUrl: context.targetUrl || null
    };
  });
  const failing = normalized.filter((context) => (
    ["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "CANCELLED"].includes(context.conclusion)
  ));
  const pending = normalized.filter((context) => (
    ["PENDING", "QUEUED", "IN_PROGRESS", "REQUESTED", "WAITING"].includes(context.status)
    || context.conclusion == null
  ));
  return {
    state: rollup.state || null,
    total: rollup.contexts?.totalCount ?? normalized.length,
    returned: normalized.length,
    truncated: rollup.contexts?.pageInfo?.hasNextPage === true,
    pass: normalized.filter((context) => ["SUCCESS", "NEUTRAL"].includes(context.conclusion)).length,
    fail: failing.length,
    pending: pending.length,
    skipping: normalized.filter((context) => context.conclusion === "SKIPPED").length,
    failing,
    pendingChecks: pending,
    contexts: normalized
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

function requireOptionalSha(value, name) {
  if (value == null || String(value).trim() === "") {
    return null;
  }
  const text = requireNonOptionString(String(value).trim(), name).toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(text)) {
    throw new Error(`${name} must be a commit SHA or unique SHA prefix.`);
  }
  return text;
}

function shaMatches(expected, actual) {
  const left = trimOrNull(expected)?.toLowerCase() || null;
  const right = trimOrNull(actual)?.toLowerCase() || null;
  if (!left || !right) {
    return null;
  }
  return left.startsWith(right) || right.startsWith(left);
}

function shaEquals(expected, actual) {
  const left = trimOrNull(expected)?.toLowerCase() || null;
  const right = trimOrNull(actual)?.toLowerCase() || null;
  return Boolean(left && right && left === right);
}

function normalizeStringArray(value, name) {
  if (value == null || value === "") {
    return [];
  }
  const values = Array.isArray(value) ? value : [value];
  return values.map((item, index) => requireString(String(item), `${name}[${index}]`));
}

function normalizeReviewers(value, name = "reviewers") {
  return normalizeStringArray(value, name).map((reviewer, index) => requireNonOptionString(reviewer, `${name}[${index}]`));
}

function normalizeApprovedReplies(value, options = {}) {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("approvedReplies must be an array.");
  }
  return value.map((reply, index) => {
    if (!reply || typeof reply !== "object" || Array.isArray(reply)) {
      throw new Error(`approvedReplies[${index}] must be an object.`);
    }
    const commentId = requirePositiveInteger(reply.commentId, `approvedReplies[${index}].commentId`);
    const body = reply.body == null
      ? null
      : requireString(String(reply.body), `approvedReplies[${index}].body`);
    if (options.requireBody && body == null) {
      throw new Error(`approvedReplies[${index}].body is required`);
    }
    return { commentId, body };
  });
}

function commentLogin(comment) {
  return comment?.author?.login || null;
}

function threadComments(thread) {
  return thread?.comments?.nodes || [];
}

function rootThreadComment(thread) {
  return threadComments(thread).find((comment) => !comment.replyTo) || threadComments(thread)[0] || null;
}

function commentIdValues(comment) {
  return [comment?.databaseId, comment?.id]
    .filter((value) => value != null && String(value).trim() !== "")
    .map((value) => String(value));
}

function commentIdMatches(comment, expectedId) {
  return commentIdValues(comment).includes(String(expectedId));
}

function replyTargetsComment(comment, expectedId) {
  return comment?.replyTo != null && commentIdMatches(comment.replyTo, expectedId);
}

function isBotOrCodeqlComment(comment) {
  const login = (commentLogin(comment) || "").toLowerCase();
  const body = String(comment?.body || "").toLowerCase();
  return login.endsWith("[bot]")
    || login.includes("codeql")
    || login === "github-actions"
    || login === "code-scanning"
    || body.includes("codeql")
    || body.includes("code scanning");
}

function hasAuthorReply(thread, authorLogin) {
  if (!authorLogin) {
    return false;
  }
  const root = rootThreadComment(thread);
  return threadComments(thread).some((comment) => (
    comment !== root
    && commentLogin(comment) === authorLogin
    && (comment.replyTo || !root?.createdAt || new Date(comment.createdAt) >= new Date(root.createdAt))
  ));
}

function findApprovedReplyReadback(thread, approvedReply) {
  return threadComments(thread).find((comment) => (
    replyTargetsComment(comment, approvedReply.commentId)
    && (approvedReply.body == null || comment.body === approvedReply.body)
  )) || null;
}

function summarizeThread(thread) {
  const root = rootThreadComment(thread);
  return {
    threadId: thread.id,
    rootCommentId: root?.databaseId != null ? String(root.databaseId) : null,
    rootGraphqlId: root?.id || null,
    author: commentLogin(root),
    path: thread.path || root?.path || null,
    line: thread.line ?? root?.line ?? null,
    url: root?.url || null,
    createdAt: root?.createdAt || null,
    isResolved: thread.isResolved,
    isOutdated: thread.isOutdated,
    body: root?.body || null
  };
}

function compareThreadCreatedAtDesc(left, right) {
  return String(right.createdAt || "").localeCompare(String(left.createdAt || ""));
}

function classifyReviewThreads(pullRequest, approvedReplies) {
  const threads = pullRequest?.reviewThreads?.nodes || [];
  const prAuthor = pullRequest?.author?.login || null;
  const humanMissingAuthorReply = [];
  const humanAlreadyReplied = [];
  const botOrCodeql = [];
  const resolvedOrOutdated = [];

  for (const thread of threads) {
    const root = rootThreadComment(thread);
    const summary = summarizeThread(thread);
    if (thread.isResolved || thread.isOutdated) {
      resolvedOrOutdated.push(summary);
      continue;
    }
    if (isBotOrCodeqlComment(root)) {
      botOrCodeql.push(summary);
      continue;
    }
    if (hasAuthorReply(thread, prAuthor)) {
      humanAlreadyReplied.push(summary);
    } else {
      humanMissingAuthorReply.push(summary);
    }
  }

  const approvedReplyReadbacks = approvedReplies.map((approvedReply) => {
    const thread = threads.find((candidate) => threadComments(candidate).some(
      (comment) => commentIdMatches(comment, approvedReply.commentId)
    ));
    const readback = thread ? findApprovedReplyReadback(thread, approvedReply) : null;
    return {
      commentId: approvedReply.commentId,
      posted: readback != null,
      readbackConfirmed: readback != null,
      bodyMatches: readback != null && (approvedReply.body == null || readback.body === approvedReply.body),
      body: readback?.body || null,
      url: readback?.url || null,
      thread: thread ? summarizeThread(thread) : null
    };
  });

  return {
    humanMissingAuthorReply: humanMissingAuthorReply.sort(compareThreadCreatedAtDesc),
    humanAlreadyReplied: humanAlreadyReplied.sort(compareThreadCreatedAtDesc),
    botOrCodeql: botOrCodeql.sort(compareThreadCreatedAtDesc),
    resolvedOrOutdated: resolvedOrOutdated.sort(compareThreadCreatedAtDesc),
    approvedReplyReadbacks,
    approvedButUnposted: approvedReplyReadbacks.filter((reply) => !reply.posted)
  };
}

function summarizeCheckState(checks, pending) {
  const items = Array.isArray(checks) ? checks : [];
  const failing = items.filter((check) => check.bucket === "fail" || check.state === "FAILURE");
  const pendingChecks = items.filter((check) => (
    check.bucket === "pending"
    || check.state === "PENDING"
    || check.state === "QUEUED"
    || check.state === "IN_PROGRESS"
  ));
  return {
    total: items.length,
    pass: items.filter((check) => check.bucket === "pass" || check.state === "SUCCESS").length,
    fail: failing.length,
    pending: pending || pendingChecks.length > 0,
    skipping: items.filter((check) => check.bucket === "skipping" || check.state === "SKIPPED").length,
    passing: failing.length === 0 && pending !== true && pendingChecks.length === 0,
    failing,
    pendingChecks
  };
}

function reviewRequestName(node) {
  const reviewer = node?.requestedReviewer;
  if (!reviewer) {
    return null;
  }
  return reviewer.login || reviewer.slug || reviewer.name || null;
}

function reviewerMatchesExpected(requestedName, expectedName) {
  const requested = String(requestedName || "").toLowerCase();
  const expected = String(expectedName || "").toLowerCase();
  return requested === expected || expected.endsWith(`/${requested}`);
}

function summarizeReviewRequests(pullRequest, expectedReviewers) {
  const requests = (pullRequest?.reviewRequests?.nodes || [])
    .map((node) => ({
      type: node?.requestedReviewer?.__typename || null,
      name: reviewRequestName(node)
    }))
    .filter((request) => request.name);
  const missingExpected = expectedReviewers.filter(
    (expected) => !requests.some((request) => reviewerMatchesExpected(request.name, expected))
  );
  return {
    current: requests,
    expected: expectedReviewers,
    missingExpected,
    allExpectedRequested: expectedReviewers.length === 0 ? null : missingExpected.length === 0
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

function accountAuthHint(targetRepo, accounts) {
  if (!targetRepo || accounts.length < 2) {
    return null;
  }
  const owner = targetRepo.owner.toLowerCase();
  const active = accounts.find((account) => account.active);
  if (owner.includes("kyndryl")) {
    const kyndryl = accounts.find((account) => account.login.toLowerCase().includes("kyndryl"));
    if (kyndryl && !kyndryl.active) {
      return `Active gh account is ${active?.login || "unknown"}; GitHub Local Ops will use ${kyndryl.login} for ${targetRepo.nameWithOwner} when repo-aware token selection can verify access.`;
    }
  }
  if (active) {
    return `Active gh account is ${active.login}; pass githubAccount only when automatic repo-aware token selection cannot choose the intended account for ${targetRepo.nameWithOwner}.`;
  }
  return `Pass githubAccount only when automatic repo-aware token selection cannot choose the intended account for ${targetRepo.nameWithOwner}.`;
}

function maybeRepoNameWithOwner(value) {
  try {
    return value ? parseRepoName(value).nameWithOwner : null;
  } catch {
    return null;
  }
}

function fieldValue(args, name) {
  const flags = new Set(["-f", "--raw-field", "-F", "--field"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    let value = null;
    if (flags.has(arg) && index + 1 < args.length) {
      value = String(args[index + 1]);
      index += 1;
    } else if (arg.startsWith("--raw-field=")) {
      value = arg.slice("--raw-field=".length);
    } else if (arg.startsWith("--field=")) {
      value = arg.slice("--field=".length);
    }
    if (value?.startsWith(`${name}=`)) {
      return value.slice(name.length + 1);
    }
  }
  return null;
}

function repoFromGhArgs(args) {
  const repoFlag = args.findIndex((arg) => arg === "--repo" || arg === "-R");
  if (repoFlag !== -1 && args[repoFlag + 1]) {
    return maybeRepoNameWithOwner(args[repoFlag + 1]);
  }
  const repoEquals = args.find((arg) => String(arg).startsWith("--repo="));
  if (repoEquals) {
    return maybeRepoNameWithOwner(String(repoEquals).slice("--repo=".length));
  }
  if (args[0] === "repo" && args[1] === "view") {
    const flagsWithValues = new Set(["--json", "-q", "--jq", "-t", "--template"]);
    for (let index = 2; index < args.length; index += 1) {
      const candidate = String(args[index]);
      if (flagsWithValues.has(candidate)) {
        index += 1;
        continue;
      }
      if (!candidate.startsWith("-")) {
        return maybeRepoNameWithOwner(candidate);
      }
    }
  }
  if (args[0] === "api") {
    const endpoint = args.find((arg) => /^\/?repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/|$)/.test(String(arg)));
    if (endpoint) {
      const [, owner, name] = String(endpoint).match(/^\/?repos\/([^/]+)\/([^/]+)/) || [];
      if (owner && name) {
        return maybeRepoNameWithOwner(`${owner}/${name}`);
      }
    }
    const owner = fieldValue(args, "owner");
    const name = fieldValue(args, "name");
    if (owner && name) {
      return maybeRepoNameWithOwner(`${owner}/${name}`);
    }
  }
  return null;
}

function repoFromCwd(cwd) {
  const origin = safeRunGit(["remote", "get-url", "origin"], { cwd });
  if (origin.status !== 0) {
    return null;
  }
  return parseRepoFromGitRemote(origin.stdout)?.nameWithOwner || null;
}

function commandDefaultsToCwdRepo(args) {
  if (args[0] === "repo" && args[1] === "view") {
    return true;
  }
  return ["pr", "issue", "release", "run", "workflow"].includes(args[0]);
}

function permissionRank(permission) {
  return {
    ADMIN: 5,
    MAINTAIN: 4,
    WRITE: 3,
    TRIAGE: 2,
    READ: 1
  }[String(permission || "").toUpperCase()] || 0;
}

function getAuthCache(map, key) {
  if (!map.has(key)) {
    return undefined;
  }
  const entry = map.get(key);
  if (entry.expiresAt <= Date.now()) {
    map.delete(key);
    return undefined;
  }
  return entry.value;
}

function setAuthCache(map, key, value) {
  map.set(key, {
    value,
    expiresAt: Date.now() + AUTH_CACHE_TTL_MS
  });
  return value;
}

function ghAuthStatus(cwd) {
  const auth = safeRunGh(["auth", "status"], {
    cwd,
    disableAuthResolution: true,
    removeEnv: GITHUB_TOKEN_ENV_KEYS
  });
  const text = outputText(auth) || "";
  const accounts = parseGhAccounts(text);
  return {
    command: auth.command,
    ok: auth.status === 0,
    activeAccount: accounts.find((account) => account.active)?.login || null,
    accounts,
    status: text || null
  };
}

function ghTokenForAccount(cwd, account) {
  const login = requireOptionalLogin(account, "githubAccount");
  if (!login) {
    return null;
  }
  const key = `${cwd}\0${login}`;
  const cached = getAuthCache(ghAccountTokenCache, key);
  if (cached !== undefined) {
    return cached;
  }
  const result = safeRunGh(
    ["auth", "token", "--hostname", "github.com", "--user", login],
    {
      cwd,
      disableAuthResolution: true,
      removeEnv: GITHUB_TOKEN_ENV_KEYS
    }
  );
  if (result.status !== 0) {
    const failure = {
      account: login,
      ok: false,
      error: result.stderr?.trim() || result.stdout?.trim() || "gh auth token failed"
    };
    return setAuthCache(ghAccountTokenCache, key, failure);
  }
  const token = trimOrNull(result.stdout);
  const value = {
    account: login,
    ok: Boolean(token),
    token,
    error: token ? null : "gh auth token returned an empty token"
  };
  return setAuthCache(ghAccountTokenCache, key, value);
}

function ghEnvForToken(token) {
  return token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : null;
}

function probeRepoAccount(cwd, repo, account) {
  const token = ghTokenForAccount(cwd, account);
  if (!token?.ok) {
    return {
      account,
      ok: false,
      error: token?.error || "token unavailable",
      viewerPermission: null,
      rank: 0
    };
  }
  const result = safeRunGh(
    ["repo", "view", repo, "--json", "nameWithOwner,viewerPermission"],
    {
      cwd,
      json: true,
      env: ghEnvForToken(token.token),
      disableAuthResolution: true,
      removeEnv: ["GITHUB_TOKEN"]
    }
  );
  if (result.status !== 0 || !result.data) {
    return {
      account,
      ok: false,
      error: result.stderr?.trim() || result.stdout?.trim() || "repo view failed",
      viewerPermission: null,
      rank: 0
    };
  }
  return {
    account,
    ok: true,
    error: null,
    viewerPermission: result.data.viewerPermission || null,
    rank: permissionRank(result.data.viewerPermission)
  };
}

function ghAuthForCommand(args, options = {}) {
  if (args[0] === "auth") {
    return null;
  }
  const cwd = options.cwd || process.cwd();
  const repo = options.repoName
    || repoFromGhArgs(args)
    || (commandDefaultsToCwdRepo(args) ? repoFromCwd(cwd) : null);
  const explicitAccount = requireOptionalLogin(options.githubAccount, "githubAccount");
  const cacheKey = `${cwd}\0${repo || ""}\0${explicitAccount || ""}`;
  const cached = getAuthCache(ghRepoAuthCache, cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  if (explicitAccount) {
    const token = ghTokenForAccount(cwd, explicitAccount);
    if (!token?.ok) {
      throw new Error(`GitHub account ${explicitAccount} is not available through gh auth token: ${token?.error || "unknown error"}`);
    }
    const auth = {
      env: ghEnvForToken(token.token),
      summary: {
        strategy: "explicit_account",
        account: explicitAccount,
        repo,
        viewerPermission: null
      }
    };
    return setAuthCache(ghRepoAuthCache, cacheKey, auth);
  }

  if (!repo) {
    return setAuthCache(ghRepoAuthCache, cacheKey, null);
  }

  const status = ghAuthStatus(cwd);
  if (!status.ok || status.accounts.length === 0) {
    return setAuthCache(ghRepoAuthCache, cacheKey, null);
  }

  const owner = parseRepoName(repo).owner.toLowerCase();
  const ownerAccount = status.accounts.find((account) => account.login.toLowerCase() === owner);
  if (ownerAccount) {
    const token = ghTokenForAccount(cwd, ownerAccount.login);
    if (token?.ok) {
      const auth = {
        env: ghEnvForToken(token.token),
        summary: {
          strategy: "owner_login_match",
          account: ownerAccount.login,
          repo,
          viewerPermission: null
        }
      };
      return setAuthCache(ghRepoAuthCache, cacheKey, auth);
    }
  }

  const probes = status.accounts.map((account) => probeRepoAccount(cwd, repo, account.login));
  const successful = probes.filter((probe) => probe.ok);
  if (successful.length === 0) {
    const auth = {
      env: null,
      summary: {
        strategy: "active_account_fallback",
        account: status.activeAccount,
        repo,
        viewerPermission: null,
        warnings: ["No authenticated gh account could be verified against the target repo; falling back to gh default account."]
      }
    };
    return setAuthCache(ghRepoAuthCache, cacheKey, auth);
  }

  successful.sort((left, right) => {
    if (right.rank !== left.rank) {
      return right.rank - left.rank;
    }
    return left.account.localeCompare(right.account);
  });
  const topRank = successful[0].rank;
  const topCandidates = successful.filter((probe) => probe.rank === topRank);
  if (topCandidates.length > 1) {
    const candidates = topCandidates
      .map((probe) => `${probe.account} (${probe.viewerPermission || "unknown"})`)
      .join(", ");
    throw new Error(`GitHub account selection for ${repo} is ambiguous: ${candidates}. Pass githubAccount to choose the account for this operation.`);
  }
  const selected = successful[0];
  const token = ghTokenForAccount(cwd, selected.account);
  const auth = {
    env: token?.ok ? ghEnvForToken(token.token) : null,
    summary: {
      strategy: "repo_permission_probe",
      account: selected.account,
      repo,
      viewerPermission: selected.viewerPermission,
      candidates: successful.map((probe) => ({
        account: probe.account,
        viewerPermission: probe.viewerPermission
      }))
    }
  };
  return setAuthCache(ghRepoAuthCache, cacheKey, auth);
}

async function githubSetupStatus(input = {}) {
  const cwd = cwdFrom(input);
  const freshness = maybeAutoFetch(input);
  const ghVersion = safeRunGh(["--version"], { cwd });
  const gitVersion = safeRunGit(["--version"], { cwd });
  const auth = safeRunGh(["auth", "status"], {
    cwd,
    disableAuthResolution: true,
    removeEnv: GITHUB_TOKEN_ENV_KEYS
  });
  const gitRoot = safeRunGit(["rev-parse", "--show-toplevel"], { cwd });
  const checkout = inspectGitCheckout(cwd);
  const origin = safeRunGit(["remote", "get-url", "origin"], { cwd });
  const originRepo = origin.status === 0 ? parseRepoFromGitRemote(origin.stdout) : null;
  const targetRepo = input.repo ? parseRepoName(input.repo) : originRepo;
  const repoArgs = targetRepo
    ? ["repo", "view", targetRepo.nameWithOwner, "--json", "nameWithOwner,url,defaultBranchRef,viewerPermission,isPrivate,description"]
    : ["repo", "view", "--json", "nameWithOwner,url,defaultBranchRef,viewerPermission,isPrivate,description"];
  const repo = safeRunGh(repoArgs, { cwd, json: true, githubAccount: input.githubAccount });
  const authText = outputText(auth) || "";
  const accounts = parseGhAccounts(authText);
  const authHint = accountAuthHint(targetRepo, accounts);

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
    nextSteps.push("Run gh auth status, then gh auth login if no account is available. Do not switch the global gh active account for repo-specific work; pass githubAccount only when automatic selection is ambiguous.");
  }
  if (!repoResolved) {
    if (targetRepo) {
      nextSteps.push(authHint || `Verify an authenticated gh account can access ${targetRepo.nameWithOwner}.`);
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
      branch: checkout.branch,
      detached: checkout.detached,
      activeAccount: accounts.find((account) => account.active)?.login || null,
      selectedAccount: repo.auth?.account || null,
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
      branch: checkout.branch,
      detached: checkout.detached,
      head: checkout.head,
      worktreeCount: checkout.worktreeCount,
      origin: origin.status === 0 ? redactGitRemote(origin.stdout) : null
    },
    repositoryTarget: targetRepo,
    repository: repoResolved ? repo.data : null,
    authSelection: repo.auth || null,
    warnings,
    nextSteps
  };
}

async function githubCurrentContext(input = {}) {
  const cwd = cwdFrom(input);
  const freshness = maybeAutoFetch(input);
  const checkout = inspectGitCheckout(cwd);
  const remote = safeRunGit(["remote", "get-url", "origin"], { cwd });
  const repo = safeRunGh(["repo", "view", "--json", "nameWithOwner,url,defaultBranchRef,viewerPermission,isPrivate,description"], {
    cwd,
    json: true,
    githubAccount: input.githubAccount,
    allowFailure: true
  });
  const auth = safeRunGh(["auth", "status"], {
    cwd,
    disableAuthResolution: true,
    removeEnv: GITHUB_TOKEN_ENV_KEYS
  });
  const git = {
    root: checkout.root,
    branch: checkout.branch,
    detached: checkout.detached,
    head: checkout.head,
    worktreeCount: checkout.worktreeCount,
    origin: remote.status === 0 ? redactGitRemote(remote.stdout) : null
  };
  const github = repo.status === 0 ? repo.data : null;
  const warnings = [
    checkout.available ? null : "cwd is not inside a git repository",
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
      detached: git.detached,
      head: compactSha(git.head),
      defaultBranch: github?.defaultBranchRef?.name || null,
      viewerPermission: github?.viewerPermission || null,
      selectedAccount: repo.auth?.account || null,
      fetched: freshness.ok,
      warnings: warnings.length
    },
    ghAuthStatus: auth.stdout.trim() || auth.stderr.trim(),
    authSelection: repo.auth || null,
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
  const result = runGh(args, { cwd, json: true, githubAccount: input.githubAccount });
  return {
    command: result.command,
    authSelection: result.auth,
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
  const result = runGh(addRepo(args, input.repo), { cwd, json: true, githubAccount: input.githubAccount });
  return {
    command: result.command,
    authSelection: result.auth,
    freshness,
    abstract: summarizePrList(result.data, freshness),
    pullRequests: result.data,
    warnings: freshnessWarnings(freshness)
  };
}

const PR_IDENTITY_FIELDS = "number,title,state,isDraft,author,baseRefName,headRefName,headRefOid,updatedAt,url";

function resolveDefaultPullRequestSelector({ cwd, repo, number, toolName, githubAccount }) {
  if (number != null) {
    return {
      selector: String(number),
      identity: {
        strategy: "explicit",
        selector: String(number)
      },
      commands: [],
      warnings: []
    };
  }

  const checkout = inspectGitCheckout(cwd);
  if (!checkout.available) {
    throw new Error(`${toolName} needs an explicit PR number, URL, or branch because cwd is not inside a git repository.`);
  }
  if (checkout.branch) {
    return {
      selector: checkout.branch,
      identity: {
        strategy: "attached_branch",
        branch: checkout.branch,
        localHead: checkout.head
      },
      commands: [],
      warnings: []
    };
  }
  if (!checkout.detached) {
    throw new Error(`${toolName} needs an explicit PR number, URL, or branch because the current branch could not be resolved.`);
  }
  if (!checkout.head) {
    throw new Error(`${toolName} needs an explicit PR number, URL, or branch because detached HEAD could not be read.`);
  }

  const args = [
    "pr",
    "list",
    "--json",
    PR_IDENTITY_FIELDS,
    "--limit",
    "100",
    "--state",
    "all",
    "--search",
    checkout.head
  ];
  const result = runGh(addRepo(args, repo), { cwd, json: true, githubAccount });
  const pullRequests = Array.isArray(result.data) ? result.data : [];
  const matches = pullRequests.filter((pr) => shaEquals(checkout.head, pr.headRefOid));

  if (matches.length === 0) {
    throw new Error(`${toolName} is running in a detached checkout at ${compactSha(checkout.head)}, but no PR has that exact head SHA. Pass a PR number, URL, or branch explicitly.`);
  }
  if (matches.length > 1) {
    const rendered = matches
      .map((pr) => `#${pr.number} ${pr.headRefName || "(no head branch)"} ${compactSha(pr.headRefOid)}`)
      .join("; ");
    throw new Error(`${toolName} found multiple PRs for detached HEAD ${compactSha(checkout.head)}: ${rendered}. Pass the PR number explicitly.`);
  }

  const match = matches[0];
  return {
    selector: String(match.number),
    identity: {
      strategy: "detached_head_sha",
      localHead: checkout.head,
      worktreeCount: checkout.worktreeCount,
      number: match.number,
      title: match.title || null,
      state: match.state || null,
      baseRefName: match.baseRefName || null,
      headRefName: match.headRefName || null,
      headRefOid: match.headRefOid || null,
      url: match.url || null
    },
    commands: [result.command],
    authSelection: result.auth,
    warnings: [
      `Detached checkout resolved by exact HEAD SHA ${compactSha(checkout.head)} to PR #${match.number}; no current-branch PR default was used.`
    ]
  };
}

function validateDetachedPrHead({ cwd, repo, prIdentity, toolName, pullRequest = null, githubAccount }) {
  if (prIdentity?.strategy !== "detached_head_sha") {
    return { commands: [] };
  }

  let headRefOid = trimOrNull(pullRequest?.headRefOid);
  const commands = [];
  if (!headRefOid) {
    const result = runGh(
      addRepo(["pr", "view", String(prIdentity.number), "--json", "headRefOid"], repo),
      { cwd, json: true, githubAccount }
    );
    commands.push(result.command);
    headRefOid = trimOrNull(result.data?.headRefOid);
  }

  if (!shaEquals(prIdentity.localHead, headRefOid)) {
    throw new Error(`${toolName} resolved detached HEAD ${compactSha(prIdentity.localHead)} to PR #${prIdentity.number}, but the PR head is now ${compactSha(headRefOid)}. Refusing to use a stale PR identity; pass an explicit PR number after refreshing context.`);
  }

  return { commands };
}

function errorSummary(error) {
  if (!error) {
    return "unknown error";
  }
  if (error instanceof Error) {
    return error.stderr?.trim() || error.stdout?.trim() || error.message;
  }
  return String(error);
}

function readActiveAccount(cwd) {
  const auth = safeRunGh(["auth", "status"], { cwd });
  const text = outputText(auth) || "";
  const accounts = parseGhAccounts(text);
  return {
    command: auth.command,
    ok: auth.status === 0,
    activeAccount: accounts.find((account) => account.active)?.login || null,
    accounts,
    status: text || null
  };
}

function authoredPullRequestsGraphqlQuery({ explicitAuthor, includeChecks }) {
  const subject = explicitAuthor ? "user(login: $author)" : "viewer";
  const authorVariable = explicitAuthor ? ", $author: String!" : "";
  const checks = includeChecks
    ? `
          statusCheckRollup {
            state
            contexts(first: 50) {
              totalCount
              pageInfo { hasNextPage endCursor }
              nodes {
                __typename
                ... on CheckRun {
                  name
                  status
                  conclusion
                  detailsUrl
                  startedAt
                  completedAt
                  checkSuite {
                    workflowRun {
                      workflow { name }
                    }
                  }
                }
                ... on StatusContext {
                  context
                  state
                  targetUrl
                }
              }
            }
          }`
    : "";
  return `query($first: Int!, $after: String${authorVariable}) {
  subject: ${subject} {
    login
    pullRequests(states: OPEN, first: $first, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        title
        url
        state
        isDraft
        updatedAt
        reviewDecision
        baseRefName
        baseRefOid
        headRefName
        headRefOid
        author { login }
        repository { nameWithOwner }
        headRepository { nameWithOwner }
        ${checks}
      }
    }
  }
  rateLimit {
    limit
    cost
    remaining
    resetAt
    used
  }
}`;
}

function normalizeGraphqlPullRequest(pr, includeChecks) {
  return normalizeDiscoveryPullRequest({
    ...pr,
    repo: pr.repository?.nameWithOwner || null,
    headRepository: pr.headRepository?.nameWithOwner || null,
    author: pr.author?.login || null,
    checks: includeChecks ? checkSummaryFromRollup(pr.statusCheckRollup) : null
  });
}

function graphqlVariableArgs({ query, first, after, author }) {
  const args = ["api", "graphql", "-f", `query=${query}`, "-F", `first=${first}`];
  if (after) {
    args.push("-f", `after=${after}`);
  }
  if (author) {
    args.push("-f", `author=${author}`);
  }
  return args;
}

function graphqlErrors(data) {
  const errors = data?.errors;
  if (!Array.isArray(errors) || errors.length === 0) {
    return [];
  }
  return errors.map((error) => error.message || JSON.stringify(error));
}

function filterPullRequestsByRepo(pullRequests, repo) {
  if (!repo) {
    return pullRequests;
  }
  const wanted = repo.toLowerCase();
  return pullRequests.filter((pr) => String(pr.repo || "").toLowerCase() === wanted);
}

function searchReliabilityWarnings(type, query, resultCount = null) {
  const warnings = [];
  if (type === "prs") {
    const authorScoped = /\bauthor:([^\s]+)/i.test(query);
    const openScoped = /\bis:(?:pr\s+)?open\b/i.test(query) || /\bstate:open\b/i.test(query);
    if (authorScoped || openScoped || resultCount === 0) {
      warnings.push("gh search prs is search-index backed and can return false zeroes for private org authored PRs; use github_my_pull_requests for authored PR discovery because it uses GraphQL viewer/user pullRequests and includes drafts.");
    } else {
      warnings.push("gh search prs is search-index backed; use github_my_pull_requests when private org authored PR completeness matters.");
    }
  }
  if (type === "repos") {
    warnings.push("gh search repos is search-index backed and is not a complete accessible-repository enumeration surface for private org automation.");
  }
  return warnings;
}

async function readAuthoredPullRequestsGraphql({ cwd, author, limit, repo, includeChecks, githubAccount }) {
  const query = authoredPullRequestsGraphqlQuery({ explicitAuthor: Boolean(author), includeChecks });
  const pullRequests = [];
  const commands = [];
  let cursor = null;
  let totalCount = null;
  let subjectLogin = null;
  let rateLimit = null;
  let hasNextPage = false;
  let pageCount = 0;

  while (pullRequests.length < limit) {
    const first = Math.min(100, limit - pullRequests.length);
    const result = runGh(graphqlVariableArgs({ query, first, after: cursor, author }), { cwd, json: true, repoName: repo, githubAccount });
    commands.push(result.command);
    const errors = graphqlErrors(result.data);
    if (errors.length > 0) {
      throw new Error(`GraphQL authored PR discovery failed: ${errors.join("; ")}`);
    }
    const subject = result.data?.data?.subject;
    if (!subject) {
      throw new Error(author ? `GitHub user ${author} was not found or is not visible to the selected GitHub account.` : "GraphQL viewer was not returned.");
    }
    const connection = subject.pullRequests;
    subjectLogin = subject.login || subjectLogin;
    totalCount = connection?.totalCount ?? totalCount;
    rateLimit = result.data?.data?.rateLimit || rateLimit;
    const nodes = connection?.nodes || [];
    pullRequests.push(...nodes.map((pr) => normalizeGraphqlPullRequest(pr, includeChecks)));
    pageCount += 1;
    hasNextPage = connection?.pageInfo?.hasNextPage === true;
    cursor = connection?.pageInfo?.endCursor || null;
    if (!hasNextPage || !cursor) {
      break;
    }
  }

  const warnings = [];
  if (hasNextPage || (totalCount != null && totalCount > pullRequests.length)) {
    warnings.push(`GraphQL result truncated at limit ${limit}; total authored open PRs reported as ${totalCount}.`);
  }
  if (repo && hasNextPage) {
    warnings.push("repo filter is applied after GraphQL author discovery; increase limit if filtered results look incomplete.");
  }
  if (includeChecks && pullRequests.some((pr) => pr.checks?.truncated)) {
    warnings.push("One or more PR check summaries are truncated at 50 check/status contexts.");
  }

  return {
    strategy: author ? "graphql_user_pull_requests" : "graphql_viewer_pull_requests",
    subjectLogin,
    totalCount,
    pageCount,
    commands,
    pullRequests: filterPullRequestsByRepo(pullRequests, repo),
    unfilteredCount: pullRequests.length,
    truncated: hasNextPage || (totalCount != null && totalCount > pullRequests.length),
    rateLimit,
    warnings
  };
}

async function readAuthoredPullRequestsFromRepos({ cwd, author, repos, limit, includeChecks, githubAccount }) {
  const pullRequests = [];
  const commands = [];
  const warnings = [];
  for (const repo of repos) {
    const list = await githubPrList({ cwd, repo, state: "open", limit: 100, githubAccount });
    commands.push(list.command);
    const repoMatches = list.pullRequests
      .filter((pr) => loginFromAuthor(pr.author) === author)
      .map((pr) => normalizeDiscoveryPullRequest({
        ...pr,
        repo,
        checks: includeChecks ? readPrChecks(cwd, repo, pr.number, githubAccount).summary : null
      }));
    pullRequests.push(...repoMatches);
    warnings.push(...list.warnings);
    if (list.pullRequests.length >= 100) {
      warnings.push(`Repo fallback for ${repo} reached the per-repo limit of 100 open PRs.`);
    }
    if (pullRequests.length >= limit) {
      warnings.push(`Repo fallback truncated at limit ${limit}.`);
      break;
    }
  }
  return {
    strategy: "repo_list_fallback",
    commands,
    pullRequests: pullRequests.slice(0, limit),
    truncated: pullRequests.length > limit,
    warnings
  };
}

async function readAuthoredPullRequestsFromSearch({ cwd, author, repo, limit, githubAccount }) {
  const query = `is:pr is:open author:${author} archived:false`;
  const args = ["search", "prs", query, "--limit", limit, "--json", "number,title,state,repository,author,updatedAt,url,isDraft"];
  if (repo) {
    args.push("--repo", repo);
  }
  const result = runGh(args, { cwd, json: true, repoName: repo, githubAccount });
  return {
    strategy: "gh_search_prs_fallback",
    commands: [result.command],
    pullRequests: result.data.map((pr, index) => normalizeDiscoveryPullRequest(pr, index)),
    truncated: result.data.length >= limit,
    warnings: [
      "gh search prs fallback is known incomplete for private org authored PR discovery and does not return base/head metadata required for rebase automation."
    ]
  };
}

async function githubMyPullRequests(input = {}) {
  const cwd = cwdFrom(input);
  const limit = limitValue(input.limit ?? 100);
  const includeChecks = input.includeChecks === true;
  const repo = input.repo ? parseRepoName(input.repo).nameWithOwner : null;
  const requestedAuthor = requireOptionalLogin(input.author);
  const fallbackRepos = normalizeOptionalRepoList(input.fallbackRepos);
  const auth = readActiveAccount(cwd);
  const warnings = auth.ok ? [] : ["gh authentication status could not be inspected."];
  let discovery;

  try {
    discovery = await readAuthoredPullRequestsGraphql({
      cwd,
      author: requestedAuthor,
      limit,
      repo,
      includeChecks,
      githubAccount: input.githubAccount
    });
  } catch (error) {
    warnings.push(errorSummary(error));
    const fallbackAuthor = requestedAuthor || auth.activeAccount;
    if (!fallbackAuthor) {
      throw error;
    }
    if (fallbackRepos.length > 0) {
      discovery = await readAuthoredPullRequestsFromRepos({
        cwd,
        author: fallbackAuthor,
        repos: repo ? fallbackRepos.filter((candidate) => candidate.toLowerCase() === repo.toLowerCase()) : fallbackRepos,
        limit,
        includeChecks,
        githubAccount: input.githubAccount
      });
      discovery.subjectLogin = fallbackAuthor;
    } else if (input.allowSearchFallback === true) {
      discovery = await readAuthoredPullRequestsFromSearch({ cwd, author: fallbackAuthor, repo, limit, githubAccount: input.githubAccount });
      discovery.subjectLogin = fallbackAuthor;
    } else {
      throw error;
    }
  }

  const author = discovery.subjectLogin || requestedAuthor || auth.activeAccount || null;
  const allWarnings = [
    ...warnings,
    ...discovery.warnings
  ];
  const evidence = {
    activeAccount: auth.activeAccount || (requestedAuthor ? auth.activeAccount : discovery.subjectLogin) || null,
    author,
    strategy: discovery.strategy,
    commands: discovery.commands,
    pageCount: discovery.pageCount || null,
    totalCount: discovery.totalCount ?? null,
    returnedCount: discovery.pullRequests.length,
    unfilteredCount: discovery.unfilteredCount ?? discovery.pullRequests.length,
    repoFilter: repo,
    includeChecks,
    truncated: discovery.truncated === true,
    rateLimit: discovery.rateLimit || null,
    auth
  };
  return {
    command: discovery.commands?.[0] || null,
    abstract: summarizeAuthoredPullRequests(discovery.pullRequests, {
      ...evidence,
      warnings: allWarnings
    }),
    discovery: evidence,
    pullRequests: discovery.pullRequests,
    warnings: allWarnings
  };
}

function pullRequestKey(pr) {
  return `${pr.repo}#${pr.number}`;
}

function compactPullRequestRef(pr) {
  return {
    repo: pr.repo || null,
    number: pr.number ?? null,
    title: pr.title || null,
    url: pr.url || null,
    baseRefName: pr.baseRefName || null,
    headRefName: pr.headRefName || null,
    headRepository: pr.headRepository || null,
    headSha: pr.headSha || pr.headRefOid || null
  };
}

function compareHeadSpec(pr) {
  if (!pr.headRefName) {
    return null;
  }
  if (!pr.headRepository || !pr.repo || pr.headRepository.toLowerCase() === pr.repo.toLowerCase()) {
    return pr.headRefName;
  }
  const headRepo = parseRepoName(pr.headRepository);
  return `${headRepo.owner}:${pr.headRefName}`;
}

function compareStatusToStaleness(status) {
  if (status === "ahead" || status === "identical") {
    return "current";
  }
  if (status === "behind" || status === "diverged") {
    return "stale";
  }
  return "unknown";
}

function readPullRequestStaleness(cwd, pr, githubAccount = null) {
  if (!pr.repo || !pr.baseRefName || !pr.headRefName) {
    return {
      status: "unknown",
      reason: "missing repo, baseRefName, or headRefName"
    };
  }
  const headSpec = compareHeadSpec(pr);
  if (!headSpec) {
    return {
      status: "unknown",
      reason: "missing head ref"
    };
  }
  const endpoint = `repos/${pr.repo}/compare/${encodeURIComponent(pr.baseRefName)}...${encodeURIComponent(headSpec)}`;
  const result = safeRunGh([
    "api",
    endpoint,
    "--jq",
    "{status: .status, aheadBy: .ahead_by, behindBy: .behind_by, baseCommit: .base_commit.sha, mergeBaseCommit: .merge_base_commit.sha}"
  ], { cwd, json: true, repoName: pr.repo, githubAccount });
  if (result.status !== 0 || !result.data) {
    return {
      status: "unknown",
      reason: result.stderr?.trim() || result.stdout?.trim() || "compare API failed",
      command: result.command,
      ghStatus: result.status
    };
  }
  const compareStatus = result.data.status || null;
  return {
    status: compareStatusToStaleness(compareStatus),
    compareStatus,
    aheadBy: result.data.aheadBy ?? null,
    behindBy: result.data.behindBy ?? null,
    baseCommit: result.data.baseCommit || null,
    mergeBaseCommit: result.data.mergeBaseCommit || null,
    command: result.command,
    authSelection: result.auth || null
  };
}

function buildRepositoryRebasePlan(repository, pullRequests, stalenessByKey) {
  const byHead = new Map();
  const originalIndex = new Map();
  for (const [index, pr] of pullRequests.entries()) {
    originalIndex.set(pullRequestKey(pr), index);
    if (!pr.headRefName) {
      continue;
    }
    const current = byHead.get(pr.headRefName) || [];
    current.push(pr);
    byHead.set(pr.headRefName, current);
  }

  const dependenciesByKey = new Map();
  const childrenByKey = new Map();
  const ambiguousBases = [];
  const externalBases = [];
  const duplicateHeads = [...byHead.entries()]
    .filter(([, prs]) => prs.length > 1)
    .map(([headRefName, prs]) => ({
      headRefName,
      pullRequests: prs.map(compactPullRequestRef)
    }));

  for (const pr of pullRequests) {
    const key = pullRequestKey(pr);
    dependenciesByKey.set(key, new Set());
    childrenByKey.set(key, new Set());
  }

  for (const pr of pullRequests) {
    const key = pullRequestKey(pr);
    const candidates = pr.baseRefName ? byHead.get(pr.baseRefName) || [] : [];
    if (candidates.length === 1) {
      const parent = candidates[0];
      const parentKey = pullRequestKey(parent);
      dependenciesByKey.get(key).add(parentKey);
      childrenByKey.get(parentKey).add(key);
    } else if (candidates.length > 1) {
      ambiguousBases.push({
        pullRequest: compactPullRequestRef(pr),
        baseRefName: pr.baseRefName,
        candidates: candidates.map(compactPullRequestRef)
      });
    } else if (pr.baseRefName) {
      externalBases.push({
        pullRequest: compactPullRequestRef(pr),
        baseRefName: pr.baseRefName
      });
    }
  }

  const keyToPr = new Map(pullRequests.map((pr) => [pullRequestKey(pr), pr]));
  const indegree = new Map([...dependenciesByKey.entries()].map(([key, deps]) => [key, deps.size]));
  const queue = [...indegree.entries()]
    .filter(([, count]) => count === 0)
    .map(([key]) => key)
    .sort((left, right) => originalIndex.get(left) - originalIndex.get(right));
  const orderedKeys = [];

  while (queue.length > 0) {
    const key = queue.shift();
    orderedKeys.push(key);
    const children = [...(childrenByKey.get(key) || [])]
      .sort((left, right) => originalIndex.get(left) - originalIndex.get(right));
    for (const child of children) {
      indegree.set(child, indegree.get(child) - 1);
      if (indegree.get(child) === 0) {
        queue.push(child);
      }
    }
    queue.sort((left, right) => originalIndex.get(left) - originalIndex.get(right));
  }

  const cycleKeys = [...indegree.entries()]
    .filter(([key, count]) => count > 0 && !orderedKeys.includes(key))
    .map(([key]) => key);
  const cycles = cycleKeys.map((key) => ({
    pullRequest: compactPullRequestRef(keyToPr.get(key)),
    dependsOn: [...(dependenciesByKey.get(key) || [])].map((parentKey) => compactPullRequestRef(keyToPr.get(parentKey)))
  }));
  const finalKeys = [...orderedKeys, ...cycleKeys];
  const ordered = finalKeys.map((key, index) => {
    const pr = keyToPr.get(key);
    return {
      order: index + 1,
      key,
      ...compactPullRequestRef(pr),
      isDraft: pr.isDraft ?? null,
      author: pr.author || null,
      reviewDecision: pr.reviewDecision || null,
      updatedAt: pr.updatedAt || null,
      dependsOn: [...(dependenciesByKey.get(key) || [])].map((parentKey) => compactPullRequestRef(keyToPr.get(parentKey))),
      children: [...(childrenByKey.get(key) || [])].map((childKey) => compactPullRequestRef(keyToPr.get(childKey))),
      staleness: stalenessByKey.get(key) || { status: "unknown", reason: "staleness check disabled" }
    };
  });

  return {
    repository,
    pullRequests: ordered,
    dependencies: ordered
      .filter((item) => item.dependsOn.length > 0)
      .map((item) => ({
        pullRequest: compactPullRequestRef(item),
        dependsOn: item.dependsOn,
        reason: "baseRefName matches another PR headRefName"
      })),
    externalBases,
    ambiguousBases,
    duplicateHeads,
    cycles
  };
}

async function githubPrRebasePlan(input = {}) {
  const cwd = cwdFrom(input);
  const repo = input.repo ? parseRepoName(input.repo).nameWithOwner : null;
  const checkStaleness = input.checkStaleness !== false;
  const warnings = [];
  let discovery = null;
  let pullRequests = normalizeDiscoveryPullRequests(input.pullRequests);
  if (pullRequests.length === 0 && input.pullRequests == null) {
    discovery = await githubMyPullRequests({
      cwd,
      repo,
      author: input.author,
      limit: input.limit ?? 100,
      includeChecks: false,
      githubAccount: input.githubAccount
    });
    pullRequests = discovery.pullRequests;
    warnings.push(...discovery.warnings);
  }
  if (repo) {
    pullRequests = filterPullRequestsByRepo(pullRequests, repo);
  }

  for (const [index, pr] of pullRequests.entries()) {
    if (!pr.repo || !pr.number) {
      throw new Error(`pullRequests[${index}] must include repo and number.`);
    }
    if (!pr.baseRefName || !pr.headRefName) {
      warnings.push(`PR ${pr.repo}#${pr.number} is missing baseRefName or headRefName; dependency and staleness evidence may be incomplete.`);
    }
  }

  const stalenessByKey = new Map();
  if (checkStaleness) {
    for (const pr of pullRequests) {
      stalenessByKey.set(pullRequestKey(pr), readPullRequestStaleness(cwd, pr, input.githubAccount));
    }
  }

  const groups = new Map();
  for (const pr of pullRequests) {
    const values = groups.get(pr.repo) || [];
    values.push(pr);
    groups.set(pr.repo, values);
  }
  const repositoryPlans = [...groups.entries()].map(([repository, prs]) => (
    buildRepositoryRebasePlan(repository, prs, stalenessByKey)
  ));
  const orderedPullRequests = repositoryPlans.flatMap((plan) => (
    plan.pullRequests.map((pr) => ({ ...pr, repository: plan.repository }))
  ));
  if (repositoryPlans.some((plan) => plan.cycles.length > 0)) {
    warnings.push("One or more stacked PR dependency cycles were detected.");
  }
  if (repositoryPlans.some((plan) => plan.ambiguousBases.length > 0)) {
    warnings.push("One or more PR bases match multiple PR head branches in the same repo.");
  }

  return {
    abstract: summarizeRebasePlan(repositoryPlans, orderedPullRequests, warnings),
    discovery: discovery?.discovery || null,
    repositories: repositoryPlans,
    orderedPullRequests,
    warnings
  };
}

async function githubPrView(input = {}) {
  const cwd = cwdFrom(input);
  const freshness = maybeAutoFetch(input);
  const prIdentity = resolveDefaultPullRequestSelector({
    cwd,
    repo: input.repo,
    number: input.number,
    toolName: "github_pr_view",
    githubAccount: input.githubAccount
  });
  const args = ["pr", "view"];
  args.push(prIdentity.selector);
  args.push(
    "--json",
    fields(
      input.fields,
      "number,title,state,isDraft,author,baseRefName,baseRefOid,headRefName,headRefOid,body,changedFiles,files,reviewDecision,reviewRequests,latestReviews,mergeable,mergeStateStatus,statusCheckRollup,updatedAt,url"
    )
  );
  const result = runGh(addRepo(args, input.repo), { cwd, json: true, githubAccount: input.githubAccount });
  const validation = validateDetachedPrHead({
    cwd,
    repo: input.repo,
    prIdentity: prIdentity.identity,
    toolName: "github_pr_view",
    pullRequest: result.data,
    githubAccount: input.githubAccount
  });
  return {
    command: result.command,
    resolutionCommands: prIdentity.commands,
    validationCommands: validation.commands,
    authSelection: result.auth || prIdentity.authSelection || null,
    freshness,
    prIdentity: prIdentity.identity,
    abstract: summarizePr(result.data, freshness),
    pullRequest: result.data,
    warnings: [...freshnessWarnings(freshness), ...prIdentity.warnings]
  };
}

async function githubPrDiff(input = {}) {
  const cwd = cwdFrom(input);
  const freshness = maybeAutoFetch(input);
  const prIdentity = resolveDefaultPullRequestSelector({
    cwd,
    repo: input.repo,
    number: input.number,
    toolName: "github_pr_diff",
    githubAccount: input.githubAccount
  });
  const args = ["pr", "diff"];
  args.push(prIdentity.selector);
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
  const validation = validateDetachedPrHead({
    cwd,
    repo: input.repo,
    prIdentity: prIdentity.identity,
    toolName: "github_pr_diff",
    githubAccount: input.githubAccount
  });
  const result = runGh(addRepo(args, input.repo), { cwd, githubAccount: input.githubAccount });
  const diff = truncate(result.stdout, input.maxBytes || DEFAULT_MAX_BYTES);
  return {
    command: result.command,
    resolutionCommands: prIdentity.commands,
    validationCommands: validation.commands,
    authSelection: result.auth || prIdentity.authSelection || null,
    freshness,
    prIdentity: prIdentity.identity,
    abstract: summarizeDiff(diff.text, diff.truncated, freshness),
    diff,
    stderr: result.stderr.trim() || null,
    warnings: [...freshnessWarnings(freshness), ...prIdentity.warnings]
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
              databaseId
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
              replyTo { id databaseId }
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
    { cwd, json: true, repoName: repo.nameWithOwner, githubAccount: input.githubAccount }
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
    authSelection: result.auth || null,
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
  const prIdentity = resolveDefaultPullRequestSelector({
    cwd,
    repo: input.repo,
    number: input.number,
    toolName: "github_checks",
    githubAccount: input.githubAccount
  });
  const args = ["pr", "checks"];
  args.push(prIdentity.selector);
  args.push("--json", "bucket,completedAt,description,event,link,name,startedAt,state,workflow");
  if (input.requiredOnly) {
    args.push("--required");
  }
  const validation = validateDetachedPrHead({
    cwd,
    repo: input.repo,
    prIdentity: prIdentity.identity,
    toolName: "github_checks",
    githubAccount: input.githubAccount
  });
  const result = runGh(addRepo(args, input.repo), { cwd, json: true, allowFailure: true, githubAccount: input.githubAccount });
  if (result.status !== 0 && result.status !== 8) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "gh pr checks failed");
  }
  return {
    command: result.command,
    resolutionCommands: prIdentity.commands,
    validationCommands: validation.commands,
    authSelection: result.auth || prIdentity.authSelection || null,
    pending: result.status === 8,
    freshness,
    prIdentity: prIdentity.identity,
    abstract: summarizeChecks(result.data, result.status === 8, freshness),
    checks: result.data,
    warnings: [...freshnessWarnings(freshness), ...prIdentity.warnings]
  };
}

function readHandoffGraphql(cwd, repo, number, githubAccount = null) {
  const query = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      number
      title
      state
      url
      body
      reviewDecision
      isDraft
      baseRefName
      headRefName
      headRefOid
      author { login }
      reviewRequests(first: 100) {
        nodes {
          requestedReviewer {
            __typename
            ... on User { login }
            ... on Team { slug name }
          }
        }
      }
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
              databaseId
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
              replyTo { id databaseId }
            }
          }
        }
      }
    }
  }
  rateLimit {
    limit
    cost
    remaining
    resetAt
    used
  }
}`;
  return runGh(
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
    { cwd, json: true, repoName: repo.nameWithOwner, githubAccount }
  );
}

function readPrChecks(cwd, repoNameWithOwner, number, githubAccount = null) {
  const result = runGh(
    addRepo([
      "pr",
      "checks",
      String(number),
      "--json",
      "bucket,completedAt,description,event,link,name,startedAt,state,workflow"
    ], repoNameWithOwner),
    { cwd, json: true, allowFailure: true, githubAccount }
  );
  if (result.status !== 0 && result.status !== 8) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "gh pr checks failed");
  }
  return {
    command: result.command,
    pending: result.status === 8,
    checks: result.data,
    summary: summarizeCheckState(result.data, result.status === 8)
  };
}

function inspectLocalBranch(cwd, prHeadRefName) {
  const gitRoot = safeRunGit(["rev-parse", "--show-toplevel"], { cwd });
  if (gitRoot.status !== 0) {
    return {
      available: false,
      reason: "cwd is not inside a git repository"
    };
  }
  const root = gitRoot.stdout.trim();
  const branch = safeRunGit(["branch", "--show-current"], { cwd: root });
  const head = safeRunGit(["rev-parse", "HEAD"], { cwd: root });
  const upstream = safeRunGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { cwd: root });
  const aheadBehind = upstream.status === 0
    ? safeRunGit(["rev-list", "--left-right", "--count", `HEAD...${upstream.stdout.trim()}`], { cwd: root })
    : null;
  const counts = aheadBehind?.status === 0
    ? aheadBehind.stdout.trim().split(/\s+/).map((value) => Number(value))
    : null;
  const remoteHead = prHeadRefName
    ? safeRunGit(["rev-parse", `refs/remotes/origin/${prHeadRefName}`], { cwd: root })
    : null;
  return {
    available: true,
    root,
    currentBranch: branch.status === 0 ? branch.stdout.trim() : null,
    localHead: head.status === 0 ? head.stdout.trim() : null,
    upstream: upstream.status === 0 ? upstream.stdout.trim() : null,
    aheadBehind: counts && Number.isFinite(counts[0]) && Number.isFinite(counts[1])
      ? { ahead: counts[0], behind: counts[1] }
      : null,
    headRefName: prHeadRefName || null,
    currentBranchMatchesPrHead: branch.status === 0 && prHeadRefName ? branch.stdout.trim() === prHeadRefName : null,
    remoteHead: remoteHead?.status === 0 ? remoteHead.stdout.trim() : null
  };
}

async function githubPrHandoffStatus(input = {}) {
  const cwd = cwdFrom(input);
  const freshness = maybeAutoFetch(input);
  const repo = resolveRepo(input);
  const number = Number(requirePositiveInteger(input.number, "number"));
  const expectedHeadSha = requireOptionalSha(input.expectedHeadSha, "expectedHeadSha");
  const expectedPrBodyContains = normalizeStringArray(input.expectedPrBodyContains, "expectedPrBodyContains");
  const approvedReplies = normalizeApprovedReplies(input.approvedReplies);
  const expectedReviewers = normalizeReviewers(input.expectedReviewers || input.reviewers || [], "expectedReviewers");
  const graph = readHandoffGraphql(cwd, repo, number, input.githubAccount);
  const pullRequest = graph.data?.data?.repository?.pullRequest;
  if (!pullRequest) {
    throw new Error(`Pull request ${number} was not found in ${repo.nameWithOwner}.`);
  }
  const checks = readPrChecks(cwd, repo.nameWithOwner, number, input.githubAccount);
  const local = inspectLocalBranch(cwd, pullRequest.headRefName);
  const threads = classifyReviewThreads(pullRequest, approvedReplies);
  const reviewRequests = summarizeReviewRequests(pullRequest, expectedReviewers);
  const remoteHasExpectedCommit = expectedHeadSha ? shaMatches(expectedHeadSha, pullRequest.headRefOid) : null;
  const localAheadOnPrBranch = local.currentBranchMatchesPrHead === true && (local.aheadBehind?.ahead || 0) > 0;
  const codePushed = remoteHasExpectedCommit === false
    ? false
    : localAheadOnPrBranch
      ? false
      : expectedHeadSha
        ? remoteHasExpectedCommit
        : null;
  const prBodyUpdated = expectedPrBodyContains.length === 0
    ? null
    : expectedPrBodyContains.every((snippet) => String(pullRequest.body || "").includes(snippet));
  const approvedRepliesPosted = threads.approvedButUnposted.length === 0;
  const readbackConfirmed = approvedRepliesPosted;
  const reviewersReRequested = reviewRequests.allExpectedRequested;
  const pushedIsNotReplied = remoteHasExpectedCommit === true
    && approvedReplies.length > 0
    && threads.approvedButUnposted.length > 0;
  const blockers = [
    remoteHasExpectedCommit === false ? "expected_head_sha_not_on_pr" : null,
    localAheadOnPrBranch ? "local_branch_ahead_of_remote" : null,
    pullRequest.isDraft ? "pr_is_draft" : null,
    prBodyUpdated === false ? "pr_body_not_updated" : null,
    threads.humanMissingAuthorReply.length > 0 ? "human_threads_missing_author_replies" : null,
    threads.approvedButUnposted.length > 0 ? "approved_replies_not_posted_or_read_back" : null,
    reviewersReRequested === false ? "expected_reviewers_not_requested" : null,
    checks.summary.passing ? null : "checks_not_passing"
  ].filter(Boolean);
  const warnings = freshnessWarnings(freshness);
  if (pullRequest.reviewThreads?.pageInfo?.hasNextPage
    || pullRequest.reviewThreads?.nodes?.some((thread) => thread.comments?.pageInfo?.hasNextPage)) {
    warnings.push("Review thread result is truncated at 100 threads or 100 comments per thread.");
  }

  return {
    command: graph.command,
    repository: repo.nameWithOwner,
    freshness,
    abstract: {
      kind: "review_handoff_status",
      pullRequest: number,
      handoffComplete: blockers.length === 0,
      blockers,
      headOid: compactSha(pullRequest.headRefOid),
      codePushed,
      prBodyUpdated,
      approvedRepliesPosted,
      readbackConfirmed,
      reviewersReRequested,
      checksPassing: checks.summary.passing,
      humanThreadsMissingAuthorReplies: threads.humanMissingAuthorReply.length,
      botOrCodeqlThreads: threads.botOrCodeql.length,
      pushedIsNotReplied,
      fetched: freshness.ok,
      warnings: warnings.length
    },
    state: {
      codePushed,
      remoteHasExpectedCommit,
      localBranchAheadBehind: local.aheadBehind,
      draft: pullRequest.isDraft,
      ready: !pullRequest.isDraft,
      prBodyUpdated,
      approvedRepliesPosted,
      readbackConfirmed,
      reviewersReRequested,
      pushedIsNotReplied
    },
    pullRequest: {
      id: pullRequest.id,
      number: pullRequest.number,
      title: pullRequest.title,
      state: pullRequest.state,
      url: pullRequest.url,
      author: pullRequest.author?.login || null,
      baseRefName: pullRequest.baseRefName,
      headRefName: pullRequest.headRefName,
      headRefOid: pullRequest.headRefOid,
      reviewDecision: pullRequest.reviewDecision,
      isDraft: pullRequest.isDraft
    },
    local,
    reviewRequests,
    threads,
    checks,
    rateLimit: graph.data?.data?.rateLimit || null,
    guards: {
      handoffComplete: blockers.length === 0,
      blockers,
      pushedIsNotReplied
    },
    warnings
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
  const result = runGh(addRepo(args, input.repo), { cwd, json: true, githubAccount: input.githubAccount });
  return {
    command: result.command,
    authSelection: result.auth,
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
  const result = runGh(addRepo(args, input.repo), { cwd, json: true, githubAccount: input.githubAccount });
  return {
    command: result.command,
    authSelection: result.auth,
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
  const result = runGh(addRepo(args, input.repo), { cwd, json: true, githubAccount: input.githubAccount });
  return {
    command: result.command,
    authSelection: result.auth,
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
  const result = runGh(addRepo(args, input.repo), { cwd, json: true, githubAccount: input.githubAccount });
  return {
    command: result.command,
    authSelection: result.auth,
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
  const result = runGh([...base, "--json", jsonFields], { json: true, repoName: search.repo, githubAccount: input.githubAccount });
  const warnings = [
    ...search.warnings,
    ...searchReliabilityWarnings(type, query, Array.isArray(result.data) ? result.data.length : null)
  ];
  return {
    command: result.command,
    authSelection: result.auth,
    search: {
      strategy: `gh_search_${type}`,
      normalizedQuery: query,
      repo: search.repo || null,
      owner: input.owner || null
    },
    abstract: summarizeList(`search_${type}`, result.data, null),
    results: result.data,
    warnings
  };
}

function buildMutation(operation, payload = {}, cwd = process.cwd(), githubAccount = null) {
  const repo = payload.repo ? parseRepoName(payload.repo).nameWithOwner : undefined;
  const riskNotes = ["This is a public GitHub write unless the target repository is private."];
  const account = requireOptionalLogin(githubAccount || payload.githubAccount, "githubAccount");
  const command = (args) => ({
    kind: "gh",
    bin: GH_BIN,
    args: addRepo(args, repo),
    cwd,
    repo,
    githubAccount: account,
    riskNotes: [...riskNotes]
  });
  switch (operation) {
    case "pr_comment": {
      const number = requirePositiveInteger(payload.number, "payload.number");
      const body = requireString(payload.body, "payload.body");
      riskNotes.push("Adds a PR conversation comment.");
      return command(["pr", "comment", number, "--body", body]);
    }
    case "pull_request_review_comment": {
      if (!repo) {
        throw new Error("payload.repo is required for pull_request_review_comment");
      }
      const number = requirePositiveInteger(payload.number, "payload.number");
      const body = requireString(payload.body, "payload.body");
      const commitId = requireNonOptionString(
        payload.commitId ?? payload.commit_id,
        "payload.commitId"
      );
      const path = requireString(payload.path, "payload.path");
      const line = requirePositiveInteger(payload.line, "payload.line");
      const side = (payload.side == null ? "RIGHT" : requireString(payload.side, "payload.side"))
        .toUpperCase();
      if (!["LEFT", "RIGHT"].includes(side)) {
        throw new Error("payload.side must be LEFT or RIGHT");
      }
      const args = [
        "api",
        "--method",
        "POST",
        `repos/${repo}/pulls/${number}/comments`,
        "-f",
        `body=${body}`,
        "-f",
        `commit_id=${commitId}`,
        "-f",
        `path=${path}`,
        "-F",
        `line=${line}`,
        "-f",
        `side=${side}`
      ];
      if (payload.startLine != null || payload.start_line != null) {
        const startLine = requirePositiveInteger(
          payload.startLine ?? payload.start_line,
          "payload.startLine"
        );
        const startSide = (
          payload.startSide == null && payload.start_side == null
            ? side
            : requireString(payload.startSide ?? payload.start_side, "payload.startSide")
        ).toUpperCase();
        if (!["LEFT", "RIGHT"].includes(startSide)) {
          throw new Error("payload.startSide must be LEFT or RIGHT");
        }
        args.push("-F", `start_line=${startLine}`, "-f", `start_side=${startSide}`);
      }
      riskNotes.push("Creates a new inline pull request review comment on a diff line.");
      return {
        kind: "gh",
        bin: GH_BIN,
        args,
        cwd,
        repo,
        githubAccount: account,
        riskNotes: [...riskNotes]
      };
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
        repo,
        githubAccount: account,
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

function previewReviewHandoffSteps(plan) {
  const steps = [];
  for (const reply of plan.approvedReplies) {
    steps.push({
      kind: "post_review_thread_reply",
      commentId: reply.commentId,
      command: commandPreview([
        GH_BIN,
        "api",
        "--method",
        "POST",
        `repos/${plan.repo}/pulls/${plan.number}/comments/${reply.commentId}/replies`,
        "-f",
        `body=${reply.body}`
      ])
    });
  }
  if (plan.approvedReplies.length > 0) {
    steps.push({ kind: "readback_review_thread_replies" });
  }
  if (plan.prBody != null) {
    steps.push({
      kind: "update_pr_body",
      command: commandPreview(addRepo([GH_BIN, "pr", "edit", String(plan.number), "--body", plan.prBody], plan.repo))
    });
  }
  steps.push({ kind: "recheck_ci" });
  if (plan.reviewers.length > 0) {
    steps.push({
      kind: "request_reviewers",
      command: commandPreview(addRepo([
        GH_BIN,
        "pr",
        "edit",
        String(plan.number),
        "--add-reviewer",
        plan.reviewers.join(",")
      ], plan.repo))
    });
  }
  return steps;
}

async function githubReviewHandoffPreview(input = {}) {
  cleanupApprovals();
  const cwd = cwdFrom(input);
  const number = Number(requirePositiveInteger(input.number, "number"));
  const expectedHeadSha = requireOptionalSha(input.expectedHeadSha, "expectedHeadSha");
  const approvedReplies = normalizeApprovedReplies(input.approvedReplies, { requireBody: true });
  const reviewers = normalizeReviewers(input.reviewers || [], "reviewers");
  const prBody = input.prBody == null ? null : requireString(String(input.prBody), "prBody");
  const allowReviewRequestWithFailingChecks = input.allowReviewRequestWithFailingChecks === true;
  const status = await githubPrHandoffStatus({
    ...input,
    cwd,
    number,
    expectedHeadSha,
    approvedReplies,
    expectedPrBodyContains: prBody == null ? input.expectedPrBodyContains : prBody,
    expectedReviewers: reviewers
  });
  if (expectedHeadSha && status.state.remoteHasExpectedCommit === false) {
    throw new Error(`PR #${number} head ${status.pullRequest.headRefOid} does not match expectedHeadSha ${expectedHeadSha}.`);
  }
  if (reviewers.length > 0 && status.checks.summary.fail > 0 && !allowReviewRequestWithFailingChecks) {
    throw new Error("Checks are failing; set allowReviewRequestWithFailingChecks only after the user explicitly asks for human re-review despite failing CI.");
  }

  const plan = {
    kind: "review_handoff",
    cwd,
    repo: status.repository,
    githubAccount: input.githubAccount || null,
    number,
    expectedHeadSha,
    approvedReplies,
    prBody,
    reviewers,
    allowReviewRequestWithFailingChecks,
    riskNotes: [
      "Posts approved review-thread replies, updates PR metadata, and requests reviewers on GitHub.",
      "Execution re-checks PR head, reply readback, and CI before requesting reviewers."
    ],
    previewStatus: status.abstract
  };
  plan.steps = previewReviewHandoffSteps(plan);
  const token = randomBytes(18).toString("base64url");
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
  approvals.set(token, {
    token,
    operation: "review_handoff",
    payload: input,
    plan,
    hash: hashMutation(plan),
    createdAt: new Date().toISOString(),
    expiresAt
  });
  return {
    operation: "review_handoff",
    repository: plan.repo,
    number,
    previewStatus: status.abstract,
    steps: plan.steps,
    riskNotes: plan.riskNotes,
    approvalToken: token,
    expiresAt,
    executableByTool: PUBLIC_WRITES_ENABLED,
    approvalText: PUBLIC_WRITES_ENABLED
      ? "Approve review_handoff before calling github_mutation_execute with this token."
      : "Execution is disabled in this MCP process. Start the server with --enable-public-writes or set GITHUB_LOCAL_OPS_ENABLE_PUBLIC_WRITES=true outside chat to allow execute after preview."
  };
}

async function executeReviewHandoffPlan(plan) {
  const before = await githubPrHandoffStatus({
    cwd: plan.cwd,
    repo: plan.repo,
    number: plan.number,
    expectedHeadSha: plan.expectedHeadSha,
    approvedReplies: plan.approvedReplies,
    expectedPrBodyContains: plan.prBody == null ? [] : [plan.prBody],
    expectedReviewers: plan.reviewers,
    githubAccount: plan.githubAccount
  });
  if (plan.expectedHeadSha && before.state.remoteHasExpectedCommit === false) {
    throw new Error(`PR #${plan.number} head ${before.pullRequest.headRefOid} does not match expectedHeadSha ${plan.expectedHeadSha}.`);
  }

  const postedReplies = [];
  for (const reply of plan.approvedReplies) {
    const existing = before.threads.approvedReplyReadbacks.find(
      (readback) => readback.commentId === reply.commentId && readback.bodyMatches
    );
    if (existing?.posted) {
      postedReplies.push({ commentId: reply.commentId, skipped: true, reason: "already posted", url: existing.url });
      continue;
    }
    const result = runGh(
      [
        "api",
        "--method",
        "POST",
        `repos/${plan.repo}/pulls/${plan.number}/comments/${reply.commentId}/replies`,
        "-f",
        `body=${reply.body}`
      ],
      { cwd: plan.cwd, json: true, repoName: plan.repo, githubAccount: plan.githubAccount, requireScopedAuth: true }
    );
    postedReplies.push({
      commentId: reply.commentId,
      skipped: false,
      command: result.command,
      body: result.data?.body || null,
      url: result.data?.html_url || result.data?.url || null
    });
  }

  const afterReplies = await githubPrHandoffStatus({
    cwd: plan.cwd,
    repo: plan.repo,
    number: plan.number,
    expectedHeadSha: plan.expectedHeadSha,
    approvedReplies: plan.approvedReplies,
    expectedPrBodyContains: plan.prBody == null ? [] : [plan.prBody],
    expectedReviewers: plan.reviewers,
    githubAccount: plan.githubAccount
  });
  if (afterReplies.threads.approvedButUnposted.length > 0) {
    throw new Error("One or more approved replies were not found in readback; stopping before PR body update or reviewer request.");
  }

  let prBodyUpdate = null;
  if (plan.prBody != null) {
    const result = runGh(
      addRepo(["pr", "edit", String(plan.number), "--body", plan.prBody], plan.repo),
      { cwd: plan.cwd, githubAccount: plan.githubAccount, requireScopedAuth: true }
    );
    prBodyUpdate = {
      command: result.command,
      stdout: trimOrNull(result.stdout),
      stderr: trimOrNull(result.stderr)
    };
  }

  const checks = readPrChecks(plan.cwd, plan.repo, plan.number, plan.githubAccount);
  let reviewerRequest = null;
  if (plan.reviewers.length > 0) {
    if (afterReplies.pullRequest.isDraft) {
      reviewerRequest = { skipped: true, reason: "PR is still draft." };
    } else if (checks.summary.fail > 0 && !plan.allowReviewRequestWithFailingChecks) {
      reviewerRequest = { skipped: true, reason: "Checks are failing and override was not approved." };
    } else {
      const result = runGh(
        addRepo(["pr", "edit", String(plan.number), "--add-reviewer", plan.reviewers.join(",")], plan.repo),
        { cwd: plan.cwd, githubAccount: plan.githubAccount, requireScopedAuth: true }
      );
      reviewerRequest = {
        skipped: false,
        command: result.command,
        reviewers: plan.reviewers,
        stdout: trimOrNull(result.stdout),
        stderr: trimOrNull(result.stderr)
      };
    }
  }

  const finalStatus = await githubPrHandoffStatus({
    cwd: plan.cwd,
    repo: plan.repo,
    number: plan.number,
    expectedHeadSha: plan.expectedHeadSha,
    approvedReplies: plan.approvedReplies,
    expectedPrBodyContains: plan.prBody == null ? [] : [plan.prBody],
    expectedReviewers: plan.reviewers,
    githubAccount: plan.githubAccount
  });
  return {
    operation: "review_handoff",
    repository: plan.repo,
    number: plan.number,
    postedReplies,
    readback: finalStatus.threads.approvedReplyReadbacks,
    prBodyUpdate,
    checks,
    reviewerRequest,
    finalStatus: finalStatus.abstract
  };
}

function hashMutation(plan) {
  return createHash("sha256").update(JSON.stringify({
    kind: plan.kind,
    bin: plan.bin || null,
    args: plan.args || null,
    cwd: plan.cwd,
    repo: plan.repo || null,
    githubAccount: plan.githubAccount || null,
    number: plan.number || null,
    approvedReplies: plan.approvedReplies || null,
    prBody: plan.prBody || null,
    reviewers: plan.reviewers || null
  })).digest("hex");
}

async function githubMutationPreview(input = {}) {
  cleanupApprovals();
  const operation = requireString(input.operation, "operation");
  const payload = input.payload || {};
  const cwd = cwdFrom(input);
  const plan = buildMutation(operation, payload, cwd, input.githubAccount);
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
      : "Execution is disabled in this MCP process. Start the server with --enable-public-writes or set GITHUB_LOCAL_OPS_ENABLE_PUBLIC_WRITES=true outside chat to allow execute after preview."
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
    throw new Error("Public GitHub writes are disabled. Start the server with --enable-public-writes or set GITHUB_LOCAL_OPS_ENABLE_PUBLIC_WRITES=true outside chat to enable github_mutation_execute.");
  }
  approvals.delete(token);
  if (approval.plan.kind === "review_handoff") {
    return executeReviewHandoffPlan(approval.plan);
  }
  const result = approval.plan.kind === "gh"
    ? runGh(approval.plan.args, {
      cwd: approval.plan.cwd,
      maxBuffer: 20 * 1024 * 1024,
      repoName: approval.plan.repo,
      githubAccount: approval.plan.githubAccount,
      requireScopedAuth: true
    })
    : run(approval.plan.bin, approval.plan.args, { cwd: approval.plan.cwd, maxBuffer: 20 * 1024 * 1024 });
  return {
    operation: approval.operation,
    command: {
      executable: approval.plan.bin,
      args: approval.plan.args,
      cwd: approval.plan.cwd,
      shellPreview: commandPreview([approval.plan.bin, ...approval.plan.args])
    },
    authSelection: result.auth || null,
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
  github_my_pull_requests: githubMyPullRequests,
  github_pr_rebase_plan: githubPrRebasePlan,
  github_pr_view: githubPrView,
  github_pr_diff: githubPrDiff,
  github_pr_review_threads: githubPrReviewThreads,
  github_checks: githubChecks,
  github_pr_handoff_status: githubPrHandoffStatus,
  github_review_handoff_preview: githubReviewHandoffPreview,
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
  const handoffInvalidReplyRejected = await expectReject(() => githubReviewHandoffPreview({
    number: 1,
    approvedReplies: [
      {
        commentId: "--body-file=/tmp/secret",
        body: "Self-test preview only."
      }
    ]
  }));
  const rebasePlan = await githubPrRebasePlan({
    checkStaleness: false,
    pullRequests: [
      {
        repo: "owner/repo",
        number: 1,
        title: "Base PR",
        baseRefName: "main",
        headRefName: "feature/base",
        headRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      },
      {
        repo: "owner/repo",
        number: 2,
        title: "Child PR",
        baseRefName: "feature/base",
        headRefName: "feature/child",
        headRefOid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      }
    ]
  });
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
      && handoffInvalidReplyRejected.ok
      && rebasePlan.orderedPullRequests.map((pr) => pr.number).join(",") === "1,2"
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
      handoffInvalidReplyRejected,
      rebasePlanOrdersParentFirst: rebasePlan.orderedPullRequests.map((pr) => pr.number),
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
  const cliArgs = process.argv.slice(2).filter((arg) => arg !== "--enable-public-writes");
  const [mode, toolName, rawArgs] = cliArgs;
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
