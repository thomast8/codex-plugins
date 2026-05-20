---
name: github-publish-changes
description: Prepare and publish local code changes to GitHub with commit auth checks, signed commits, branch naming, draft PR creation, and reviewer-focused PR bodies.
---

# GitHub Publish Changes

Use this skill when the user wants to commit, push, open a PR, update a PR, or prepare code changes for review.

## Workflow

1. Run `github_setup_status` if auth, repo, or plugin readiness is unclear. Pass the user checkout `cwd` when working from local refs.
2. Inspect `git status`, current branch, remotes, and whether an open PR already exists for the branch.
3. Before the first commit in a session, verify `git config user.email` matches the repo owner rules in global guidance.
4. Keep commits atomic and signed. Use Conventional Commit titles.
5. Before pushing or opening a PR, run the repo's fast lint/type checks and the appropriate review gate for non-trivial changes.
6. Open new PRs as draft.
7. Use the PR body structure: Why, What, How, Verification, Notes-Deferred.
8. Include copy-pasteable manual testing steps in PR descriptions.

## Local GitHub Ops Tools

- Use `github_pr_view` and `github_pr_list` before creating a new PR to avoid duplicates.
- Use `github_mutation_preview` for PR edits, reviewer requests, comments, labels, workflow dispatch, and releases.
- Direct `git commit`, `git push`, and `gh pr create --draft` remain shell operations because they operate on the current checkout and require repo-specific verification. Treat pushes and PR creation as public writes: show the exact command and proceed only when the user requested the publish/create action or explicitly approved that command.
- For HTTPS pushes across multiple GitHub accounts, do not use global `gh auth switch`. Use provider account evidence and a command-scoped credential path, such as askpass with `gh auth token --user <account>`, so only the intended push uses the selected account token.

## Guardrails

- Do not commit proactively during ad-hoc work unless the user asked for a commit or an execution plan provisioned commit checkpoints.
- Do not delete remote branches for open PRs until a replacement PR is ready.
- After review comments are handled, update the PR description when behavior, verification, or manual testing changed.
