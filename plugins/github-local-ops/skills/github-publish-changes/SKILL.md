---
name: github-publish-changes
description: Prepare and publish local code changes to GitHub with commit auth checks, signed commits, branch naming, draft PR creation, and reviewer-focused PR bodies.
---

# GitHub Publish Changes

Use this skill when the user wants to commit, push, open a PR, update a PR, or prepare code changes for review.

## Workflow

1. Run `github_setup_status` if auth, repo, identity, or plugin readiness is unclear. Pass the user checkout `cwd` when working from local refs.
2. Inspect `git status`, current branch, remotes, and whether an open PR already exists for the branch.
3. Before the first commit in a session, run `github_identity_status`. If it reports `needs_fix`, preview fixes with `github_identity_fix_preview` and execute them only after explicit approval.
4. Keep commits atomic and signed. Use Conventional Commit titles.
5. Before pushing or opening a PR, run the repo's fast lint/type checks and the appropriate review gate for non-trivial changes.
6. Open new PRs as draft through the provider.
7. Use the PR body structure: Why, What, How, Verification, Notes-Deferred.
8. Include copy-pasteable manual testing steps in PR descriptions.

## Local GitHub Ops Tools

- Use `github_pr_view` and `github_pr_list` before creating a new PR to avoid duplicates.
- Use `github_mutation_preview` for PR edits, reviewer requests, comments, labels, workflow dispatch, and releases.
- Direct `git status`, `git diff`, branch inspection, and `git commit` remain shell operations. Do not use naked `git push` for GitHub publishing; use `github_git_push_preview` and `github_git_push_execute`.
- Do not use naked `gh pr create`. Use `github_mutation_preview` with operation `pr_create_draft`, then `github_mutation_execute` after explicit approval.
- Do not use naked `gh`, `gh api`, `gh pr`, `gh repo`, `gh run`, `gh workflow`, or `gh auth switch` in normal publish workflows. Raw `gh` is only an explicitly reported provider-gap fallback after `github_identity_status` evidence and provider readback.
- Identity mappings are local-only. Never write them to GitHub, the Codex config repo, or plugin repositories.

## Guardrails

- Do not commit proactively during ad-hoc work unless the user asked for a commit or an execution plan provisioned commit checkpoints.
- Do not delete remote branches for open PRs until a replacement PR is ready.
- After review comments are handled, update the PR description when behavior, verification, or manual testing changed.
