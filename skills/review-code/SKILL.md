---
name: review-code
description: "Run scalable Codex code review with correctness, design, security, and tests lenses before PR or risky completion."
---

# Review Code

Distinct review lenses catch bugs any single pass misses. Scale the amount of
review to the risk and size of the change.

When this skill is invoked, either because the user explicitly requested
`review-code` or because standing guidance requires a review gate before PR,
push, or non-trivial change completion, treat that as explicit authorization to
use Codex review agents when warranted by the risk matrix below. This is
intended to satisfy runtimes whose `spawn_agent` tool requires an explicit
request for sub-agents, while avoiding slow fan-out for small low-risk changes.

## When to run

- Before opening or updating a PR
- After finishing a feature, plan, or major refactor
- Before pushing when standing guidance requires a review gate

## Review Depth

Choose the lightest review mode that still matches the risk:

| Change type | Default review mode |
|---|---|
| Tiny docs, skill text, metadata, manifest, or config-only changes | Local self-review plus targeted checks; do not spawn sub-agents by default |
| Small low-risk code changes with focused tests | Local review through the relevant lenses; spawn no agents unless something looks risky |
| Small safety-sensitive changes, such as auth, permissions, shell commands, path handling, writes, or provider state | Spawn one focused review agent for the primary risk lens, usually security or correctness |
| Medium or non-trivial code changes | Spawn the warranted subset of lanes, usually correctness plus tests, adding design or security when relevant |
| Risky code, broad refactors, release/publish gates, PR reviews, data-loss risk, auth/security work, or explicit deep-review requests | Spawn the full parallel lane set |

Do not keep re-running sub-agent reviews after every tiny follow-up fix. Once
the change is small, well covered, and the prior review findings are addressed,
prefer a local final sanity check plus targeted verification.

## Diff scope

The coordinator owns repo freshness and diff selection before any review lane starts.
Use provider evidence for freshness and PR base/head metadata. If the provider is
unavailable, fetch with plain git and report any stale-ref risk. If
reviewing an existing PR, use the PR's actual base, not `main` by assumption.

Resolve `base_ref` before reviewing:

- Existing PR: use `base_ref=origin/<baseRefName>` and
  `head_ref=origin/<headRefName>` from provider metadata.
- Graphite-tracked stack branch: inspect `gt log short`; if the current branch has
  an immediate parent branch, use `base_ref=origin/<parent-branch>`.
- Standalone branch or unknown stack state: use the remote default branch from
  `git symbolic-ref refs/remotes/origin/HEAD --short`, usually `origin/main`.
  If this fallback might include unrelated stacked commits, report that risk.

Run `git status --porcelain=v1`, `git diff --stat HEAD`, and
`git log --oneline <base_ref>..HEAD`, then compose the review scope:

| Condition | Include in review scope |
|---|---|
| Branch has committed changes | `git diff <base_ref>...HEAD` |
| Uncommitted tracked changes exist | Add `git diff HEAD` |
| Untracked files exist | Add `git ls-files --others --exclude-standard` and read the relevant file contents directly |
| User explicitly asks for latest commit only | `git diff HEAD~1...HEAD` |
| Reviewing an existing PR | `git diff origin/<baseRefName>...origin/<headRefName>` |

For pre-PR or branch review, do not let dirty or untracked changes replace the
committed branch diff. Review the committed branch diff first, then overlay tracked
dirty changes and untracked file contents. Use latest-commit-only or PR-only scope
only when that is the user's requested scope.

Pass the same intent and scope string to every lane so they review identical code.
Agents should not run `git fetch`, `git pull`, `gt sync`, or any network git operation.

## Fan out

When the chosen review depth calls for more than one sub-agent, dispatch all
selected agents before waiting for any one of them. In Codex, use `spawn_agent`
with the semantic `agent_type` for each lane:
`review-correctness`, `review-design`, `review-security`, and `review-tests`.
Do not set `fork_context` with these semantic roles. Full-history forked agents
inherit the parent agent type, model, and reasoning effort, so current Codex
runtimes reject the combination of `fork_context: true` plus `agent_type`. The
review lanes should receive an explicit, self-contained scope instead: absolute
repo path, base/head or dirty-tree scope, key files, task intent, and any
important prior findings. These roles use stable display nicknames so the
activity log shows what each agent is actually doing. Omit `model` and
`reasoning_effort` so agents inherit the current model settings. If
`multi_tool_use.parallel` is available, use it to issue the selected
`functions.spawn_agent` calls together. Otherwise, call `spawn_agent` for each
selected lane back-to-back, then use `wait_agent`. If a semantic role is
unavailable in the current runtime, retry that lane once without `agent_type`
and report the fallback.

If the review depth calls for local review only, do not spawn sub-agents. Run
the relevant lenses yourself, keep the output concise, and make clear that the
review used the local low-risk path.

Only use `fork_context: true` for review lanes when the sub-agent truly needs the
whole conversation history and role-specific display names are less important.
In that case, omit `agent_type`, `model`, and `reasoning_effort`, and put the
lane name in the task message.

If `spawn_agent` or `wait_agent` is unavailable in the current Codex runtime, do
not pretend a parallel review ran. Run the selected lenses sequentially in the
current assistant and report that the review used the sequential fallback.

**Lane A - Correctness & bugs:**
```
spawn_agent(
  agent_type: "review-correctness",
  message: "Review <self-contained intent + repo path + diff scope>. Lens: correctness only - logic errors, off-by-ones, edge cases, null/empty handling, race conditions, error-path bugs, incorrect async/await, state-machine holes. Do not run git fetch, git pull, gt sync, or any network git operation. Return findings first with file/line references, severity, reasoning, and concrete fixes. If no issues, say so and note residual risk."
)
```

**Lane B - Design & architecture:**
```
spawn_agent(
  agent_type: "review-design",
  message: "Review <self-contained intent + repo path + diff scope>. Lens: design only - API shape, naming, abstraction boundaries, coupling, dead or speculative code, premature abstractions, duplication, maintainability. Do not run git fetch, git pull, gt sync, or any network git operation. Return findings first with file/line references, severity, reasoning, and concrete fixes. If no issues, say so and note residual risk."
)
```

**Lane C - Security:**
```
spawn_agent(
  agent_type: "review-security",
  message: "Review <self-contained intent + repo path + diff scope>. Lens: security only - authn/authz, input validation, injection (SQL, command, path, template), SSRF, secrets in code/logs, unsafe deserialization, crypto misuse, dependency risk. Do not run git fetch, git pull, gt sync, or any network git operation. Return findings first with file/line references, severity, reasoning, and concrete fixes. If no issues, say so and note residual risk."
)
```

**Lane D - Tests & coverage:**
```
spawn_agent(
  agent_type: "review-tests",
  message: "Review <self-contained intent + repo path + diff scope>. Lens: tests only - do tests actually exercise the changed behavior? mocks hiding real integration? missing edge cases? flaky timing? assertions that would pass on a broken implementation? Do not run git fetch, git pull, gt sync, or any network git operation. Return findings first with file/line references, severity, reasoning, and concrete fixes. If no issues, say so and note residual risk."
)
```

## Merge

Use the Cross-Model Evidence Collection Protocol in `references/codex-evidence-collection.md` when that reference is available: normalize each lane's report, dedupe findings across lanes (same issue raised by multiple agents = high confidence), and preserve strengths.

If the current task is implementation, PR preparation, or finishing a change, fix
confirmed issues and valid low-risk suggestions before claiming done. If the user
asked for review only, present findings without editing. Present conflicts,
high-risk changes, or judgment calls to the user.

## Failures

If one lane errors out, proceed with the other three and report the failed lane.
If two or more lanes fail during a full review, rerun those lenses sequentially
in the current assistant or stop and surface the errors. For a full four-lane
review, do not claim the review gate passed unless at least three lenses
completed. For a smaller risk-scaled review, report exactly which lenses ran and
which, if any, failed.
