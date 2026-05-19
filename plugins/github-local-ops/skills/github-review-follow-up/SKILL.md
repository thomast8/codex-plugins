---
name: github-review-follow-up
description: Address GitHub PR review comments with original-comment ledgers, proposed replies, explicit approval, GraphQL posting, readback, and reviewer handoff through GitHub Local Ops.
---

# GitHub Review Follow-Up

Use this skill when the user asks to address PR review comments, reply to reviewers, send a PR back to reviewers, or handle inline review threads.

## Workflow

1. Run `github_setup_status` if auth, repo, or plugin readiness is unclear. Pass the user checkout `cwd` when working from local refs.
2. Fetch repo refs before PR review work when operating inside a checkout.
3. Run `github_pr_view` for base/head metadata and review decision.
4. Run `github_pr_review_threads` for GraphQL review-thread IDs and inline comments.
5. Inspect local code and tests needed to decide whether each comment is valid, already handled, rejected, or needs a fix.
6. Build a ledger with original comment, code-context reasoning, status, evidence, and exact proposed public reply.
7. Wait for explicit approval before posting.
8. Before any reviewer re-request, run `github_pr_handoff_status` with the expected head SHA, approved replies, expected PR body marker when relevant, and expected reviewers.
9. Use `github_review_handoff_preview` for approved replies, PR body update, and reviewer re-request. Echo the preview and wait for explicit approval.
10. After approval, call `github_mutation_execute` only if public writes are enabled in the MCP process. The MCP posts replies, reads them back, updates the PR body, re-checks CI, then requests reviewers.
11. Run `github_pr_handoff_status` again before saying handoff is done.

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
- Checks: passing, failing, or pending.

If the PR head has the expected commit but approved replies are still unposted or unread, call out the `pushedIsNotReplied` guard and do not claim handoff is complete.

Before requesting re-review, check for approved but unposted replies. If any exist, post and read back those replies first. If checks are failing, request re-review only when the user explicitly asks for human review despite failing CI.

## Public Reply Style

- One or two casual sentences.
- No bullets, bold text, numbered lists, or commit SHAs.
- Say what changed, what was checked, or why a suggestion is not applicable.
- Do not resolve reviewer-authored threads.
