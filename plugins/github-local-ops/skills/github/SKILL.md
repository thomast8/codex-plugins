---
name: github
description: Inspect GitHub repositories, pull requests, issues, Actions, releases, and publishing workflows through the local GitHub CLI backed GitHub Local Ops plugin. Use when the user asks for GitHub work and the hosted GitHub connector is unavailable or not needed.
---

# GitHub Local Ops

Use this umbrella skill for GitHub work backed by local `gh` and `git` access.

This plugin does not bypass an admin-disabled hosted connector. It uses the user's existing local GitHub CLI authentication, repo permissions, and the GitHub API surfaces available through `gh`.

## Setup

- `github_setup_status`: check whether local `git`, `gh`, authentication, repository resolution, and repo-aware account selection are ready.
- Call `github_setup_status` first when setup, account, repository, or plugin readiness is unclear. Pass the user checkout `cwd` for repo-local work, or pass `repo` when operating only on a named GitHub repository.
- Prefer the existing GitHub CLI login and macOS keychain state. For repo-scoped operations, let the provider select an authenticated account with command-scoped `GH_TOKEN` from `gh auth token --user`; do not switch the global gh active account. If auth is missing, guide the user through `gh auth status` and `gh auth login`; never ask the user to paste tokens into chat or commit credentials to repo files.
- Do not create or edit `.env` files for GitHub auth. Use the existing `gh` account state, repo permissions, and command-scoped environment only when a user deliberately provides it outside chat.

## Routing

| Workflow | Skill |
| --- | --- |
| Pull request metadata, base/head scope, diffs, review state | [../github-pr-triage/SKILL.md](../github-pr-triage/SKILL.md) |
| Review comments, reviewer replies, readback, reviewer handoff | [../github-review-follow-up/SKILL.md](../github-review-follow-up/SKILL.md) |
| Actions checks, failed runs, reruns, logs | [../github-ci-debug/SKILL.md](../github-ci-debug/SKILL.md) |
| Commit, push, draft PR creation, PR body preparation | [../github-publish-changes/SKILL.md](../github-publish-changes/SKILL.md) |
| Issues, labels, releases, workflow dispatch | [../github-issues-releases/SKILL.md](../github-issues-releases/SKILL.md) |

## Default Workflow

1. Start with `github_setup_status` when readiness is uncertain; otherwise start with `github_current_context` unless the user gives an explicit `OWNER/REPO`.
2. Pass `cwd` explicitly for checkout-aware tools. Use `autoFetch: true` only when the workflow requires fresh local refs; otherwise keep the default no-fetch behavior.
3. Prefer read tools before shelling out manually. Read tools return an `abstract` summary and, for local checkout operations, `freshness` evidence showing whether auto-fetch ran, what remotes were fetched, and any warnings.
   - `github_setup_status`
   - `github_repo_view`
   - `github_pr_list`
   - `github_my_pull_requests`
   - `github_pr_rebase_plan`
   - `github_pr_view`
   - `github_pr_diff`
   - `github_pr_review_threads`
   - `github_checks`
   - `github_pr_handoff_status`
   - `github_review_handoff_preview`
   - `github_actions_runs`
   - `github_issue_list`
   - `github_issue_view`
   - `github_release_list`
   - `github_search`
3. For public writes, call `github_mutation_preview` and show the exact public action. `github_mutation_execute` applies the approved preview when the MCP process was started by the bundled plugin manifest, with `--enable-public-writes`, or by a custom launcher with `GITHUB_LOCAL_OPS_ENABLE_PUBLIC_WRITES=true`; only execute after explicit user approval.
4. If a GitHub API command fails because authentication is on the wrong account, inspect `github_setup_status` and pass `githubAccount` for that operation only when automatic repo-aware selection is ambiguous.

## Safe Workflow

- PR-led: inspect the PR, actual base/head refs, diff, checks, and review threads before proposing comments or edits.
- Issue-led: inspect issue body, comments, labels, and related PRs before proposing comments or label changes.
- CI-led: inspect PR checks and workflow runs before proposing reruns or workflow dispatch.
- Release-led: inspect existing releases and tag state before proposing release creation.

For all public writes:

- Call `github_mutation_preview` first and show the operation, target repo/object, public body or fields, command/API call, risk notes, and token expiry context.
- Only call `github_mutation_execute` after the user explicitly approves the exact preview, and only when the local MCP process reports `executableByTool: true`.
- If the preview expires or changes, generate a new preview instead of reusing a stale token.

## Write Safety

- Preview before public writes: PR comments, new inline pull request review comments, review-thread replies, PR edits, reviewer requests, issue comments, label changes, workflow dispatch, workflow reruns, and release creation.
- For a new inline pull request review comment, use `github_mutation_preview` with operation `pull_request_review_comment` and payload `repo`, `number`, `body`, `commitId`, `path`, `line`, and `side` (`RIGHT` for the head side, `LEFT` for the base side). Use `startLine` and `startSide` only for multi-line comments. After execution, read back with `github_pr_review_threads` and report the discussion URL.
- Keep public GitHub comments and replies short, casual, and specific.
- Do not post rubric tables, reproduction matrices, approval ledgers, or internal review-output formats to GitHub. Translate review evidence into human reviewer prose before posting: the problem, the concrete impact or example, and the requested fix.
- Never resolve reviewer-authored review threads; leave resolution to reviewers or maintainers.
- Do not cite commit SHAs in public replies.
- For PR review comments, show each original comment with the proposed reply before posting.
- For reviewer handoff, use `github_pr_handoff_status` and `github_review_handoff_preview` instead of one-off reply loops. Treat code pushed, PR body updated, replies posted, readback confirmed, reviewers requested, and checks passing as separate states.

## Tool Notes

- `github_setup_status`: readiness, auth, repo-resolution, and selected command-scoped account check.
- `github_current_context`: current checkout, branch, remote, auth text, and resolved repo.
- `github_repo_view`, `github_pr_list`, `github_pr_view`, `github_issue_list`, `github_issue_view`, `github_release_list`, `github_search`: read metadata through `gh`; use `abstract` for the quick state and full payloads for evidence.
- `github_my_pull_requests`: discover open authored PRs across accessible private and public repositories with GraphQL `viewer.pullRequests` by default. Pass `author` for explicit author discovery through GraphQL `user.pullRequests`; use this instead of `github_search` for private-org authored PR completeness.
- `github_pr_rebase_plan`: build a parent-first order for stacked PRs by matching `baseRefName` to another PR's `headRefName`, and optionally mark each PR current, stale, or unknown through GitHub compare evidence.
- `github_search`: useful for ad hoc search, but PR and repo searches are search-index backed and can be incomplete for private org automation. Do not use code search or PR search as the primary authored-PR discovery path.
- `github_pr_diff`: read PR diff or changed-file list with truncation controls.
- `github_pr_review_threads`: fetch inline review-thread IDs and comments through GraphQL.
- `github_checks`, `github_actions_runs`: inspect PR checks and workflow runs.
- `github_pr_handoff_status`: consolidated review-handoff status with PR head SHA, local ahead/behind state, draft state, review requests, human missing-reply threads, bot/CodeQL threads, approved reply readback, checks, and rate-limit evidence.
- `github_review_handoff_preview`: preview the ordered handoff flow: post approved replies, read back replies, update PR body, re-check CI, then request reviewers. Execution still goes through `github_mutation_execute`.
- `github_mutation_preview`, `github_mutation_execute`: preview-first write flow with short-lived approval tokens. Supported operations include PR conversation comments (`pr_comment`), new inline PR review comments (`pull_request_review_comment`), editing existing PR conversation comments (`issue_comment_edit`), editing inline PR review comments (`pull_request_review_comment_edit`), review-thread replies (`review_thread_reply`), PR edits, reviewer requests, issue comments, label changes, workflow dispatch, workflow reruns, and release creation. The bundled plugin manifest enables execution; custom launchers must pass `--enable-public-writes` or set `GITHUB_LOCAL_OPS_ENABLE_PUBLIC_WRITES=true`.
- Local checkout reads do not fetch by default. Pass `autoFetch: true` only after the workflow needs fresh refs; surface `freshness` warnings and fall back to explicit `git fetch --all` when repo policy requires it.

## Output

Lead with the current state and the next action. Include concrete command output or URLs when they are the evidence for a recommendation.
