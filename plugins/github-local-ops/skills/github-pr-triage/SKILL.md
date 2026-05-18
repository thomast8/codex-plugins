---
name: github-pr-triage
description: Inspect GitHub PR metadata, actual base/head refs, diffs, review state, checks, and stacked PR scope using the local GitHub Local Ops plugin.
---

# GitHub PR Triage

Use this skill when the user asks to inspect, summarize, review, or understand a pull request.

## Workflow

1. Run `github_setup_status` if auth, repo, or plugin readiness is unclear. Pass the user checkout `cwd` when working from local refs.
2. Run `github_current_context` if the repo or branch is not explicit; pass `autoFetch: true` only when the review needs fresh local refs.
3. For a PR number, run `github_pr_view` with base/head fields and review status. For a branch, use `github_pr_list` or `github_pr_view` without a number from that branch.
4. Always use the PR's actual base branch from `baseRefName`; stacked PRs often target their parent branch.
5. Run `github_pr_diff` for the PR diff. Use `nameOnly` first when the file list is enough.
6. Run `github_checks` for CI status and `github_pr_review_threads` when comments or inline review context matters.

## Evidence To Surface

- PR title, state, draft status, author, base/head refs, review decision, and URL.
- Changed files and notable risk areas.
- Required checks and failing checks.
- Open review threads with file, line, reviewer, concern, and status.

## Scope Rules

- Do not assume `main` is the base.
- Prefer GitHub Local Ops freshness evidence before local git diff work when performing a PR review or preparing a branch review. If the tool did not fetch or reports a fetch warning, run or request the appropriate `git fetch --all` fallback before relying on local refs.
- If the GitHub connector is unavailable, use the local MCP tools or direct `gh` commands with the same base/head discipline.
