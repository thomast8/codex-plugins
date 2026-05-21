---
name: github-pr-triage
description: Inspect GitHub PR metadata, actual base/head refs, diffs, review state, checks, and stacked PR scope using the local GitHub Local Ops plugin.
---

# GitHub PR Triage

Use this skill when the user asks to inspect, summarize, review, or understand a pull request.

## Workflow

1. Run `github_setup_status` if auth, repo, identity, or plugin readiness is unclear. Pass the user checkout `cwd` when working from local refs.
2. Run `github_current_context` if the repo or branch is not explicit; pass `autoFetch: true` only when the review needs fresh local refs. If the checkout is detached, rely on the tool's `detached` and `head` fields instead of assuming a current branch.
3. For a PR number, run `github_pr_view` with base/head fields and review status. For an attached branch, `github_pr_view` without a number resolves that branch. For a detached checkout, `github_pr_view`, `github_pr_diff`, and `github_checks` first try exact local `HEAD` SHA, then fall back to one unambiguous local PR branch containing `HEAD`. If the fallback warns that local `HEAD` is stale against the PR head, use the provider's PR branch diff and report the stale checkout instead of stopping.
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
- Do not infer a PR number from memory or an earlier chat when `github_current_context.git.detached` is true. Use the provider's detached-head or detached-containing-branch resolution evidence, or pass an explicit PR number or URL.
- Prefer GitHub Local Ops freshness evidence before local git diff work when performing a PR review or preparing a branch review. If the tool did not fetch or reports a fetch warning, run or request the appropriate `git fetch --all` fallback before relying on local refs.
- Do not use naked `gh`, `gh api`, `gh pr`, `gh repo`, `gh run`, `gh workflow`, or `gh auth switch` for PR triage when a GitHub Local Ops tool covers the operation.
- Raw `gh` is allowed only as an explicitly reported provider-gap fallback after `github_identity_status` evidence, with provider readback afterward.
