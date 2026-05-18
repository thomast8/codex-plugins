---
name: github-issues-releases
description: Work with GitHub issues, labels, releases, and workflow dispatch through GitHub Local Ops with previewed public writes.
---

# GitHub Issues And Releases

Use this skill when the user asks to inspect or update issues, labels, releases, or manually dispatch a workflow.

## Reading

- Use `github_setup_status` first when auth, repo, or plugin readiness is unclear. Pass the user checkout `cwd` when working from local refs.
- Use `github_issue_list` for issue triage and filtering.
- Use `github_issue_view` when body, comments, labels, or assignees matter.
- Use `github_release_list` before creating a release or checking published versions.
- Use `github_search` for cross-repo issues, PRs, code, and repositories.

## Writes

Use `github_mutation_preview` and wait for explicit approval before:

- adding issue comments
- adding or removing labels
- dispatching workflows
- rerunning failed workflow runs
- creating releases

Public write execution is disabled unless the MCP process was started with `GITHUB_LOCAL_OPS_ENABLE_PUBLIC_WRITES=true`. For releases, prefer draft releases unless the user clearly asks to publish immediately. Tag commits before creating a release, and verify the tag points to the intended commit.

## Output

For issue triage, group by urgency, owner, blocker, and next action. For releases, surface tag, target commit or branch, draft/prerelease state, notes source, and reviewer-runnable verification.
