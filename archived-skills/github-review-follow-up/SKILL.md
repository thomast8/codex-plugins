---
name: github-review-follow-up
description: Address GitHub PR review comments with original-comment ledgers, proposed replies, explicit approval, GraphQL posting, readback, and reviewer handoff through GitHub Local Ops.
---

# GitHub Review Follow-Up

Use this skill when the user asks to address PR review comments, reply to reviewers, send a PR back to reviewers, or handle inline review threads.

## Workflow

1. Fetch repo refs before PR review work when operating inside a checkout.
2. Run `github_pr_view` for base/head metadata and review decision.
3. Run `github_pr_review_threads` for GraphQL review-thread IDs and inline comments.
4. Inspect local code and tests needed to decide whether each comment is valid, already handled, rejected, or needs a fix.
5. Build a ledger with original comment, code-context reasoning, status, evidence, and exact proposed public reply.
6. Wait for explicit approval before posting.
7. Use `github_mutation_preview` with `operation: "review_thread_reply"` for each approved reply.
8. After approval, call `github_mutation_execute` and read back the posted reply from the returned URL or by rerunning `github_pr_review_threads`.

## Ledger Shape

| Thread | Original comment | Code-context reasoning | Status | Evidence | Proposed reply |
| --- | --- | --- | --- | --- | --- |

Keep cells compact but include enough original context that the approval decision is clear without opening GitHub.

## Public Reply Style

- One or two casual sentences.
- No bullets, bold text, numbered lists, or commit SHAs.
- Say what changed, what was checked, or why a suggestion is not applicable.
- Do not resolve reviewer-authored threads.
