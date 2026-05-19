---
name: review-thread-response
description: "Address GitHub PR review comments with a paired original-comment and proposed-reply ledger, explicit approval before posting, provider posting/readback, PR description updates, and reviewer re-requesting. Use when the user asks to address review comments, reply to reviewers, send a PR back to reviewers, or handle PR review threads."
---

# Review Thread Response

Use this skill when handling PR review comments or sending a PR back to reviewers.

## Workflow

1. Use the provider layer for freshness, PR metadata, inline review threads, write previews, posting, and readback. Do not duplicate provider transport details in this skill.
2. Use the PR's actual base/head from the provider; never assume `main`.
3. Gather the original review comments, thread status, PR state, review requests, and current PR body from the provider.
4. Inspect the surrounding code, related commits, and stacked PR context needed to explain why each reviewer comment matters and whether it is fixed, invalid, already handled upstream, or still open.
5. Build a compact review ledger table before posting anything.
6. Echo exact proposed reply bodies and wait for approval. In the Codex app, put the approval ledger in the final response for that turn, not only in an intermediary update that may collapse away.
7. Post only approved replies through the provider layer.
8. Read back posted `body` and `url` from the provider.
9. Update the PR description when behavior, verification, manual testing, docs, schema, or rollout notes changed.
10. Send the PR back to reviewers by re-requesting the relevant reviewers. Never resolve threads authored by the PR author.

## Review Ledger Format

Present the approval preview as a Markdown table by default:

| Thread | Original comment | Code-context reasoning | Status | Evidence | Proposed reply |
| --- | --- | --- | --- | --- | --- |
| 1 - `path/to/file.py` | Reviewer comment, quoted or summarized enough to identify it. | Why the reviewer raised this, how the nearby code behaves, and why the response is correct. | Fixed, already handled upstream, rejected, or needs follow-up. | Concrete artifact: file/function/test/command/PR/result. | Exact public reply body. |

Keep table cells short enough to scan. The code-context reasoning column should explain the reviewer concern in the context of the surrounding implementation, including the invariant or failure mode being discussed. The evidence column must be concrete, not hand-wavy: name the file, function, test, command, PR, or observed result that backs the status. For long comments, quote the important part in the table and add a short "Long comments" section below the table only when the omitted context could change the approval decision. Keep enough original context that the user can understand what the reply answers without opening GitHub.

## Reply Style

- Use one or two casual sentences.
- No bullets, bold text, numbered lists, or commit SHAs in public replies.
- Say what changed, not which commit changed it.
- If pushing back, give the reason plainly.
- If a comment is already handled by an upstream PR or stack rebase, say that and name the PR number.
- Do not add repetitive thanks to every reply.

## Posting Discipline

- Approval must happen after the user sees original comment plus proposed reply together.
- When asking for approval, make the review ledger part of the final response for that turn so it remains visible in the Codex app.
- Post only the approved bodies. If the user revises one body, update only that body.
- After posting, read back every posted `body` and `url`; do not trust command output that only returns URLs.
- If posting fails, stop and report which thread failed. Do not partially invent readback.

## Reviewer Handoff

After replies are posted:

- Check whether the PR is draft before requesting review. If it is draft, report that instead of marking it ready unless the user asked.
- Re-request reviewers who left blocking comments or were already expected reviewers.
- Confirm final `reviewRequests`.
- Leave resolution of reviewer-authored threads to reviewers or maintainers.
