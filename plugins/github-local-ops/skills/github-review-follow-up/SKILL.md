---
name: github-review-follow-up
description: Address GitHub PR review comments with original-comment ledgers, proposed replies, explicit approval, GraphQL posting, readback, reviewer handoff, and sending reviewed PRs back to authors through GitHub Local Ops.
---

# GitHub Review Follow-Up

Use this skill when the user asks to address PR review comments, reply to reviewers, send a PR back to reviewers, send a reviewed PR back to the author, or handle inline review threads.

## Workflow

1. Run `github_setup_status` if auth, repo, identity, or plugin readiness is unclear. Pass the user checkout `cwd` when working from local refs.
2. Fetch repo refs before PR review work when operating inside a checkout.
3. Run `github_pr_view` for base/head metadata and review decision.
4. Run `github_pr_review_threads` for GraphQL review-thread IDs and inline comments.
5. Inspect local code and tests needed to decide whether each comment is valid, already handled, rejected, or needs a fix.
6. Build a ledger with original comment, code-context reasoning, status, evidence, and exact proposed public reply.
7. Wait for explicit approval before posting.
8. When the user says to send a reviewed PR back to the author, submit a formal `REQUEST_CHANGES` review. Do not confuse this with requesting reviewers, which sends the PR back to reviewers after the author has fixed it. A PR conversation comment is not enough, even if it contains the same text. Preview and approval-gate the exact review body through `github_mutation_preview` with operation `pull_request_review`, payload `repo`, `number`, the reviewed PR head `commitId`, no `comments`, and `event: "REQUEST_CHANGES"`; raw `gh pr review` is a provider-gap fallback only if the provider preview/execute path is unavailable after `github_identity_status`, explicit reporting, command-scoped identity where possible, and readback with `github_pr_view`.
9. Before any reviewer re-request, run `github_pr_handoff_status` with the expected head SHA, approved replies, expected PR body marker when relevant, and expected reviewers.
10. Use `github_review_handoff_preview` for approved replies, PR body update, and reviewer re-request. Echo the preview and wait for explicit approval.
11. After approval, call `github_mutation_execute` only if the preview reports `executableByTool: true`. The MCP posts replies, reads them back, updates the PR body, re-checks CI, then requests reviewers.
12. Run `github_pr_handoff_status` again before saying handoff is done.
13. If the user explicitly approves resolving a review thread that should be resolved by the current actor, use `github_mutation_preview` with operation `review_thread_resolve` and payload `repo`, `number`, and GraphQL `threadId`, then execute after approval and report `readbackVerified`, `readback.repositoryMatches`, `readback.numberMatches`, and `readback.isResolved`.

## Ledger Shape

| Thread | Original comment | Code-context reasoning | Status | Evidence | Proposed reply |
| --- | --- | --- | --- | --- | --- |

Keep cells compact but include enough original context that the approval decision is clear without opening GitHub.

## Handoff Status

Report these as separate facts, not one blended "done":

- Code pushed: PR head SHA matches the expected commit and the local PR branch is not ahead of its upstream.
- PR body updated: expected PR body text is present, when provided.
- Approved thread replies posted: every approved `{commentId, body}` has a matching reply.
- Readback confirmed: posted reply bodies and URLs were read back from GitHub.
- Reviewers re-requested: expected reviewers are currently requested.
- Sent back to author: latest review state is `CHANGES_REQUESTED`, when the user asked to send it back for fixes.
- Checks: passing, failing, or pending.

If the PR head has the expected commit but approved replies are still unposted or unread, call out the `pushedIsNotReplied` guard and do not claim handoff is complete.

Before requesting re-review, check for approved but unposted replies. If any exist, post and read back those replies first. If checks are failing, request re-review only when the user explicitly asks for human review despite failing CI.

## Shell Boundary

- Do not use naked `gh`, `gh api`, `gh pr`, `gh repo`, `gh run`, `gh workflow`, or `gh auth switch` for review follow-up when a GitHub Local Ops tool covers the operation.
- Raw `gh` is allowed only as an explicitly reported provider-gap fallback after `github_identity_status` evidence, with provider readback afterward.

## Public Reply Style

- One or two casual sentences.
- No rubric tables, reproduction matrices, approval ledgers, bullets, bold text, numbered lists, or commit SHAs.
- Say what changed, what was checked, or why a suggestion is not applicable.
- Do not resolve reviewer-authored threads.
