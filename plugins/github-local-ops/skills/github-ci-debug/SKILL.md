---
name: github-ci-debug
description: Debug failing GitHub Actions checks and workflow runs through GitHub Local Ops, including PR checks, run lists, failed logs, and previewed reruns.
---

# GitHub CI Debug

Use this skill when the user asks why GitHub Actions, PR checks, or CI is failing.

## Workflow

1. Run `github_setup_status` if auth, repo, or plugin readiness is unclear. Pass the user checkout `cwd` when working from local refs.
2. Run `github_current_context` unless the repo is explicit, using `autoFetch: true` only when fresh local refs are needed.
3. For PR-specific CI, run `github_checks` first. It maps check state into pass, fail, pending, skipping, or cancel buckets.
4. Run `github_actions_runs` to find the relevant workflow run when check metadata is not enough.
5. Use `gh run view <run-id> --log-failed` from the shell when logs are needed; summarize the failing step and first actionable error.
6. If a rerun is appropriate, use `github_mutation_preview` with `operation: "rerun_failed_workflow"` and wait for explicit approval before executing. Execute only when the preview reports `executableByTool: true`.

## Output

- Identify the failing workflow, job, and step.
- Separate real failures from cancelled, skipped, pending, or flaky infrastructure failures.
- Give the shortest command a reviewer can run to reproduce or inspect the same failure.
- If credentials or logs are unavailable, say what was missing and show the closest checked evidence.
