---
name: find-reviewer
description: "Rank a repo's active contributors by their current capacity to review a new PR. Defaults to the current branch's PR (falls back to a repo overview if there isn't one); accepts an optional PR number or --repo-only. Use when the user says '/find-reviewer', 'who should review this?', 'who has bandwidth to review?', 'best reviewer for PR #N', or similar."
---

# Find a Reviewer With Capacity

Picks the best reviewer for a PR by combining **current load** (open review requests, authored PRs in flight, assigned issues, org-wide), **recent activity** (are they actually around?), and - when a target PR is known - **domain familiarity** (have they touched the changed files?).

This skill is a thin coordinator around two shell scripts in `~/.Codex/skills/find-reviewer/scripts/`. **Do not re-implement their logic in inline bash.** Call them and turn their JSON into a ranked table.

- `gather.sh [arg]` - one call. Resolves the target, builds the candidate list, fans out per-candidate provider queries in parallel, and in PR mode pre-fetches the per-file author cache server-side. Emits one JSON blob.
- `familiarity.sh <login> <authors_cache>` - called internally by `gather.sh` once per candidate in PR mode. Pure jq computation over the pre-built cache; no provider calls. You normally don't call it yourself.

## When to Use

- "Who should I request review from on this PR?"
- "Who has bandwidth right now?"
- "Best reviewer for PR #123?"
- Plain `/find-reviewer` on a branch that has (or doesn't have) an open PR.

## Prerequisites

- Provider setup should be healthy for any public reviewer request writes.
- The ranking scripts own their provider lookups and still require local git and jq for cached contributor/load calculations.

## Workflow

### 1. Gather

```bash
~/.Codex/skills/find-reviewer/scripts/gather.sh "${ARG:-}"
```

`ARG` forms:

| Input | Mode |
|-------|------|
| *(none)* | Auto-detects the current branch's PR. If found, PR mode. If not, repo mode. |
| `123` or `#123` | PR mode, explicit PR number. |
| `--repo-only` | Forces repo mode even when a PR is detected on the current branch. |

Handle exit codes:

| Exit | Meaning | Action |
|------|---------|--------|
| 0 | Success | Parse JSON and proceed. |
| 1 | Not in a github-connected repo | Surface the embedded error message verbatim. |
| 2 | Explicit PR number not found | Surface `"could not resolve PR #N"` verbatim. |
| 3 | Unknown argument | Surface the embedded error; prompt the user for a valid form. |

### 2. Announce

One-liner before the table:

- PR mode: `Finding reviewers for PR #<n> - <title>`
- Repo mode: `Repo capacity overview for <nameWithOwner>`
- If the arg was empty and gather.sh returned repo mode, include: `(no open PR found on current branch)` so the user understands why it fell back.

Then surface any non-null `fetch_warn` or `auth_hint` on their own line.

### 3. Score

For each candidate in `candidates[]`, apply this formula exactly. It lives here, not in the script - readable at a glance, easy to tweak without editing bash.

Score is `min(load, fitness)` - a reviewer is only as good as their weaker dimension. That way someone with a totally empty review queue but zero reason to trust them as a reviewer doesn't get recommended just for being idle.

```
load = 100
  - min(40, 8 * open_review_requests_total)
  - min(20, 4 * authored_open_prs_total + 2 * authored_open_drafts_total)
  - min(10, 2 * assigned_issues_total)

if days_since_last_public_event != null:
  if days_since > 30: load -= 30;  notes += "likely away"
  elif days_since > 14: load -= 15;  notes += "possibly away"
if days_since_last_public_event == null:
  notes += "activity unknown (private-repo only)"

load = clamp(load, 0, 100)

# Fitness weighting depends on mode.
# PR mode: familiarity dominates (they've touched these files), breadth/engagement support.
# Repo mode: familiarity unavailable; rescale breadth + engagement to fill the 100 ceiling.

if mode == "pr":
  fitness =
      round(0.40 * familiarity.score)                        # familiarity is already 0-100 (F1 of coverage × depth)
    + min(30, 5 * breadth_top_level_dirs_180d)
    + min(20, 4 * recent_reviews_in_repo_45d)
    + (10 if days_since_last_public_event != null and days_since <= 7 else 0)
else:  # repo mode
  fitness =
      min(50, 5 * breadth_top_level_dirs_180d)
    + min(40, 5 * recent_reviews_in_repo_45d)
    + (10 if days_since_last_public_event != null and days_since <= 7 else 0)

fitness = clamp(fitness, 0, 100)

score = min(load, fitness)
```

Intuition: a reviewer with wide breadth (committed across many parts of the repo) is a viable reviewer even on code they haven't directly touched - they understand the codebase. In-repo reviews show they actually engage in review work here. Familiarity (PR mode) is the sharpest signal but also the rarest, so it's weighted highest when available.

`familiarity.score` is an F1-style aggregate over **coverage** (fraction of the PR's changed files this reviewer has touched in the last 180d) and **depth** (average commits per changed file, capped at 3-commits-per-file = "fully familiar"). 0 when either is 0, 100 only when a reviewer has touched every changed file with deep engagement. Raw `files_touched` and `commits` stay in the JSON for transparency.

Skip the PR author (already filtered by `gather.sh`, but double-check by name if `pr.author` is set).

### 4. Render

One markdown table sorted by score descending.

**PR mode columns:**

```
| Reviewer | Score | Load | Fit | Open reviews | In-flight PRs | Last active | Familiarity | Breadth | Notes |
```

**Repo mode columns** (drop Familiarity):

```
| Reviewer | Score | Load | Fit | Open reviews | In-flight PRs | Last active | Breadth | Notes |
```

Formatting per cell:

- **Reviewer**: `@<login>`
- **Score**: integer (the min of load and fit - the bottleneck dimension)
- **Load / Fit**: integer each, shown alongside so the reader sees *why* a score is what it is (high load + low fit looks very different from low load + high fit)
- **Open reviews**: `open_review_requests_total`
- **In-flight PRs**: `authored_open_prs_total` (with `(N draft)` suffix when `authored_open_drafts_total > 0`)
- **Last active**: `<N>d ago` or ` - ` when `days_since_last_public_event == null`
- **Familiarity** (PR mode): `<familiarity.score>` (0-100) or ` - ` when zero. Shows the F1 score directly; raw counts are in the JSON for anyone who wants to dig in.
- **Breadth**: `<breadth_top_level_dirs_180d> dirs` or ` - ` when zero
- **Notes**: comma-joined tags - `in-repo reviewer` (when `recent_reviews_in_repo_45d > 0`), `generalist` (when `breadth >= 6`), `possibly away`, `likely away`, `activity unknown`

### 5. Top pick + caveats

After the table, one line each:

```
**Top pick:** @<login> (<score>) - <one-sentence reason citing their strongest signal>.
**Avoid:** @<login> (<score>) - <reason>  [only if any candidate has score < 30 or "likely away"]
**Caveats:** activity counts are public-only; provider search rate limits keep the candidate list capped at 4.
```

### 6. Pick reviewers (PR mode only)

**Only in PR mode**, after the table + top pick, use `ask the user in chat` with `multiSelect: true` to let the user pick which reviewers to actually request. This is the confirmation step - the user seeing the ranking and selecting is the consent to act.

Skip this step in repo mode (there's no PR to assign reviewers to).

Construct the question:

- `question`: `"Request review from which of these on PR #<n>?"`
- `header`: `"Reviewers"`
- `multiSelect`: `true`
- `options`: one per candidate in the table (in the same order the table rendered, which is score descending). Cap at 4 (ask the user in chat's hard limit; matches `CANDIDATE_CAP`).
  - `label`: `"@<login> (<score>)"`
  - `description`: a short bottleneck-aware summary. In PR mode:
    - Top candidate: append `(Recommended)` to the label.
    - Description format: `"load <L>, fit <F> - <N> open reviews, <f>f/<c>c, <b> dirs"` - pull the same numbers the table shows.

After the user responds:

- **Empty selection** (or user picks "Other" with no input) → just say "No reviewers requested." and stop.
- **One or more logins selected** → use the provider layer to preview and execute the reviewer request. Surface the preview target and selected logins before executing. If it errors, surface that too.

Never request reviewers without a prior explicit selection - the ask the user in chat response IS the consent. If the user's "Other" text looks like a login (starts with `@` or is a plain username), treat it as an explicit extra reviewer to add alongside the selected ones.

## gather.sh output schema

```jsonc
{
  "mode": "pr" | "repo",
  "repo": { "nameWithOwner": "org/repo", "defaultBranch": "main" },
  "pr": {
    "number": 123,
    "title": "...",
    "headRefName": "feature/foo",
    "baseRefName": "main",
    "author": "octocat",
    "changed_files": ["src/a.py", "tests/b.py"]
  } | null,
  "candidates": [
    {
      "login": "alice",
      "signals": {
        "open_review_requests_total": 3,
        "authored_open_prs_total": 2,
        "authored_open_drafts_total": 1,
        "assigned_issues_total": 4,
        "days_since_last_public_event": 2,
        "recent_reviews_in_repo_45d": 1,
        "breadth_top_level_dirs_180d": 4,
        "familiarity": { "files_touched": 2, "commits": 7, "score": 44 } | null
      }
    }
  ],
  "fetch_warn": null | "...",
  "auth_hint": null | "..."
}
```

## Caching (why reruns are fast)

Results live under `$XDG_CACHE_HOME/find-reviewer/` (default `~/.cache/find-reviewer/`):

- `signals/<repo_slug>-<login>.json` - per-candidate load + breadth + in-repo-review count. **TTL 15min**. Most of the wall-time cost; reused across PRs in the same repo.
- `file-authors/<repo_slug>-<head_sha>.json` - per-PR author-per-file map. **Immutable** (keyed to the PR head SHA - if the PR is force-pushed, the key changes). Reused across every candidate in a run and across reruns on the same PR-commit.
- `candidates/<repo_slug>.json` - the candidate pool for this repo (pre-filter, pre-cap). **TTL 1hr**. Shared across PRs.
- `emails.json` - commit email → GitHub login, appended-to as new emails are seen. No TTL.

Pass `/find-reviewer --refresh` (or `gather.sh --refresh`) to wipe the cache and re-fetch from scratch.

## Caveats (surface these to the user, don't hide them)

- **Public-only activity**: `users/<login>/events/public` skips private-repo work, so internal-only contributors may look inactive (`last active:  - `, "activity unknown" tag). In org-private repos this is common - de-emphasize this column and trust the load + breadth + familiarity signals instead.
- **Rate limit**: provider search can be rate-limited. `gather.sh` keeps the candidate list at 4 to stay well under common caps. If a signal errors out, its field shows `0` rather than marking the reviewer unavailable.
- **Bot filter**: logins ending in `[bot]` (Dependabot, github-actions, etc.) are dropped. Bot-ish accounts without the `[bot]` suffix (e.g. `graphite-app`, `github-advanced-security`) may still appear - they'll show zero signals and rank at the bottom.
- **Familiarity + breadth resolution is server-side**: the provider resolves each commit's author to a GitHub login internally. Works even when the commit's Git author email is a corporate address not published on any GitHub profile. The commit's Git author must still be linked to a GitHub account - unlinked commits show up with `author: null` and are skipped.
- **Breadth is repo-local**: "breadth" = distinct top-level directories the login committed to in this repo in the last 180d. It doesn't count work in other repos. A reviewer who's a generalist across the org but hasn't worked in *this* repo recently will show low breadth here.

## Worked example

Invocation: `/find-reviewer` on a branch that resolves PR #201 (6 changed files, author `octocat`).

`gather.sh` returns:

```jsonc
{
  "mode": "pr",
  "repo": { "nameWithOwner": "acme/api", "defaultBranch": "main" },
  "pr": { "number": 201, "title": "Add webhook retry", "author": "octocat", "changed_files": ["src/webhooks.py", "tests/test_webhooks.py"], ... },
  "candidates": [
    { "login": "alice", "signals": { "open_review_requests_total": 1, "authored_open_prs_total": 1, "authored_open_drafts_total": 0, "assigned_issues_total": 2, "days_since_last_public_event": 1, "recent_reviews_in_repo_45d": 3, "familiarity": { "files_touched": 2, "commits": 4 } } },
    { "login": "bob",   "signals": { "open_review_requests_total": 6, "authored_open_prs_total": 3, "authored_open_drafts_total": 1, "assigned_issues_total": 0, "days_since_last_public_event": 0, "recent_reviews_in_repo_45d": 5, "familiarity": { "files_touched": 1, "commits": 2 } } },
    { "login": "carol", "signals": { "open_review_requests_total": 0, "authored_open_prs_total": 0, "authored_open_drafts_total": 0, "assigned_issues_total": 1, "days_since_last_public_event": 22, "recent_reviews_in_repo_45d": 0, "familiarity": { "files_touched": 0, "commits": 0 } } }
  ],
  "fetch_warn": null, "auth_hint": null
}
```

Applying the formula (showing alice):

```
alice: 100 - 8*1 - (4*1 + 2*0) - 2*2 + 5 + min(25, 3*2 + 0.5*4) = 100 - 8 - 4 - 4 + 5 + 8 = 97
bob:   100 - min(40, 8*6) - min(20, 4*3 + 2*1) - 0 + 5 + min(25, 3*1 + 0.5*2) = 100 - 40 - 14 + 5 + 4 = 55
carol: 100 - 0 - 0 - 2 + 0 + 0 - 15 = 83   (possibly away: 22d)
```

Rendered output:

```
Finding reviewers for PR #201 - Add webhook retry

| Reviewer | Score | Open reviews | In-flight PRs | Last active | Familiarity | Notes |
|----------|-------|--------------|---------------|-------------|-------------|-------|
| @alice   | 97    | 1            | 1             | 1d ago      | 2f / 4c     | in-repo reviewer |
| @carol   | 83    | 0            | 0             | 22d ago     | -           | possibly away |
| @bob     | 55    | 6            | 3 (1 draft)   | today       | 1f / 2c     | in-repo reviewer |

**Top pick:** @alice (97) - high familiarity (2 of 6 changed files, 4 recent commits) and a near-empty review queue.
**Caveats:** activity counts are public-only; provider search rate limits keep the candidate list capped at 8.
```

## Notes

- **One bash call per phase.** `gather.sh` owns all the data collection. Don't make ad-hoc provider calls from the skill - you'll bust the rate limit and fragment the logic.
- **Tweaking the formula**: edit step 3 in this file only. The script emits raw signals; the formula is applied by Codex at render time.
- **First-run slowness**: cold-cache provider lookups can take 10-15s for a repo with many committers. Subsequent runs hit the cache.
