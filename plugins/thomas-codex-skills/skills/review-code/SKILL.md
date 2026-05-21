---
name: review-code
description: "Run scalable Codex code review with correctness, design, security, and tests lenses before PR or risky completion."
---

# Review Code

Distinct review lenses catch bugs any single pass misses. Scale the amount of
review to the risk and size of the change.

When this skill is invoked, either because the user explicitly requested
`review-code` or because standing guidance requires a review gate before PR,
push, PR review, branch review, or non-trivial change completion, treat the
skill invocation itself as standing explicit authorization to use Codex review
agents. Whether agents are actually spawned, and which lanes run, is determined
by the risk matrix below. This is intended to satisfy runtimes whose
`spawn_agent` tool requires an explicit request for sub-agents, while avoiding
slow fan-out for small low-risk changes.

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

For PR reviews, deep reviews, and changes that touch public APIs, schemas,
user-visible workflow artifacts, docs, or integration contracts, include the
product/API contract lane. Product findings are formal review findings, not
private follow-up notes. They must be grounded in a concrete changed surface and
use the same severity and evidence contract as the other lanes.

Do not keep re-running sub-agent reviews after every tiny follow-up fix. Once
the change is small, well covered, and the prior review findings are addressed,
prefer a local final sanity check plus targeted verification.

## Finding Reproduction Gate

Treat every suspected issue as a candidate until it is reproduced. Only present
confirmed findings to the user as review issues.

Reproduce each candidate finding with at least one concrete evidence source:

- A failing test, focused script, API call, CLI command, or manual app flow that
  exercises the real changed code path.
- A small ad-hoc probe that imports the real modules and drives realistic inputs
  when a full service is unavailable.
- A deterministic trace through the changed code with concrete input/state,
  only when execution is blocked by missing credentials, unavailable services,
  or runtime tooling.

Shape reproduction evidence as reviewer-runnable verification, not private
debugging notes. Prefer real commands that a reviewer could copy from the PR
branch and understand before running. Exercise the real app, CLI, service,
endpoint, database, filesystem, provider, or existing focused test whenever
possible, and include the expected output or state.

Use the smallest understandable command or flow that proves the behavior:

- Real CLI invocation.
- API call against the local app or service.
- App flow that reaches the changed behavior.
- Database query or service readback that shows state before or after the
  action.
- Filesystem inspection when the claim is about written, missing, or leftover
  files.
- Existing focused integration or end-to-end test when it directly exercises
  the changed behavior.

Use Python snippets, synthetic helpers, or scratch scripts only when no suitable
CLI, API, fixture, committed script, endpoint, or test helper exists. Keep them
short, import the real modules, drive realistic inputs, and explain why this is
the closest real-code check. Do not leave the final review as a pointer to an
opaque private harness; translate the evidence into reviewer-shaped steps and
observable state.

Every reproduction should make the state transition obvious. Optimize for
reviewer understanding and confidence over command efficiency. Do not publish
command-only checklists: the reviewer must be able to see what claim is being
validated, why the setup is safe, what output or state is expected, what was
observed, and what would count as failure. For install, deploy, migration,
auth, external-service, or data-destructive paths, use isolated temp state,
dry-run or fake-target paths, or a clearly marked safe test target so reviewers
can see why production data or deployments will not be touched.

For each confirmed finding, capture:

- Claim: what behavior is wrong and why it matters.
- Safety boundary or setup: why the repro does not touch production data or
  external systems, or what dependency blocks a safer run.
- Exact command, API call, app flow, or deterministic trace.
- Expected behavior.
- Observed behavior.
- Failure signal: the output, state transition, assertion, or readback that
  proves the issue.

Make this rubric visible in the final review for every confirmed finding. Do
not bury reproduction in internal notes or summarize it as "reproduced" without
showing the claim, setup, command or trace, expected behavior, observed behavior,
and failure signal.

The coordinator must attempt reproduction before the final review response for
every candidate that would otherwise be listed as an issue. Include the
reproduction command, observed output, state transition, or concrete trace in a
reviewer-shaped format in the final review. If the candidate cannot be
reproduced, do not list it as a confirmed finding. Put it under "Unverified
Risks" only when it is still useful, and state exactly what blocked
reproduction. Drop or downgrade candidates that turn out to be only missing
coverage, stale docs, or theoretical concerns unless they reproduce as
user-visible behavior, security exposure, data loss, or a broken contract.

Sub-agents should also try to reproduce their own candidate findings using
sandbox-safe commands. If reproduction would need approval or unavailable
external state, they must record the exact command or setup that would prove it,
why it matters, and the closest evidence they used instead. Their final lane
reports should use the same reviewer-shaped evidence fields for any confirmed
finding.

## Delegated Evidence Contract

The coordinator owns setup, freshness, provider reads, broad test runs, and
expensive smoke checks before spawning review lanes. Treat explicit
parent-supplied verification, such as commands listed under "Verified commands
already run by parent" or "Known Verification Evidence", as authoritative
review evidence. Sub-agents should cite that evidence in their Verification
section instead of rerunning it.

Reproduction means proving a concrete candidate finding. It does not mean
re-running the whole review scope, repeating parent-verified checks, or proving
the absence of findings with extra broad tests. A sub-agent may rerun a
parent-verified command only when it has a specific candidate finding that
cannot be checked by file reads, deterministic trace, or existing evidence.

Sub-agents must not request sandbox escalation or approval prompts. If a command
would need approval, hits sandbox or tooling failure, or requires external
state, record the exact blocked command, why it matters, and the closest
sandbox-safe evidence instead. Do not start workaround loops such as cache
relocation, fake shims, alternate runners, or reconfigured tool caches unless
that workaround is the smallest safe way to reproduce a specific candidate
finding.

## Tooling and Command Handoff

Before spawning review lanes, the coordinator should discover the repository's
canonical local commands for tests, lint, type checks, smoke tests, and service
startup. Prefer repo-owned wrappers and task runners such as `just`, `make`,
`npm run`, `scripts/*`, `uv run --extra ...`, or checked-in helper scripts over
generic commands when the repository provides them. If a generic command fails
because an executable is missing, dependency extras are not selected, caches are
blocked, or the worktree is detached/fresh, identify the canonical wrapper and
use that in review prompts.

When a reviewed manual path depends on setup, the coordinator should try to
make that setup available before marking the path blocked. Use the smallest
safe, repo-owned setup that matches the claim being reviewed: start local
services, run checked-in provisioning or migration commands, install or sync
dependencies, seed local fixtures, create temporary state, or select a documented
dry-run or fake-target mode. If the needed setup requires approval, request it
from the coordinator/parent loop with a narrow command prefix when appropriate.
Only mark a verification path blocked after safe setup has been attempted or the
remaining setup is unsafe, destructive, credential-gated, externally
unavailable, or approval-gated.

## PR Body Manual Verification

For every PR review, read the PR description/body through the provider before
the final review. If it contains manual verification, test plan, smoke test, or
reviewer-runnable steps, extract those steps and run through them when the
setup is available or can be made available safely. This includes checkbox
items, numbered steps, code-fenced commands, endpoint calls, UI flows, database
checks, and described manual app behavior.

Treat PR-body manual steps as claims made by the PR author:

- Identify what each step is trying to prove.
- Run the exact command or flow as written when practical.
- If a step needs setup, perform the smallest safe setup that the repository
  provides or request approval for that setup from the parent loop. Do not mark
  the step blocked just because a local service, dependency, fixture, database,
  or generated artifact is missing.
- If a step is ambiguous, rewrite the smallest reviewer-runnable interpretation
  and say what assumption was made.
- If a step is unsafe, destructive, credential-gated, service-gated, or
  impossible in the current environment after safe setup attempts, do not fake
  it. Mark it blocked and explain the missing dependency, unsafe setup, denied
  approval, or safety boundary.
- If a step fails because the PR instructions are wrong, treat that as review
  evidence. Calibrate severity by whether it blocks reviewers from validating
  the PR's advertised behavior or reveals a product bug.

When review fan-out is already warranted and the manual steps can run in
parallel, spawn one focused manual-verification sub-agent in addition to the
normal lenses. Use a default agent if no dedicated semantic role exists. Give
it the PR body excerpt, absolute repo path, base/head scope, provider metadata,
known setup commands, and the same no-escalation/no-network-git constraints as
the other lanes. Its job is only to execute or trace the PR-body manual steps
and return a step-by-step ledger. For small local reviews, the coordinator may
run this ledger directly instead of spawning a sub-agent.

The final review must include a `Manual Verification` section whenever the PR
body had manual steps. Walk the user through each step in plain language:

- Step label or quoted summary.
- What it was trying to prove.
- Exact command, API call, app flow, or deterministic trace used.
- Observed output, state transition, screenshot/readback, or failure.
- Status: passed, failed, adjusted, or blocked.

Do not collapse this into "manual tests passed." The user should be able to see
what was tested and why it mattered.

The coordinator should run or validate at least one representative command in
the parent loop before delegation when practical, especially in fresh worktrees
or after dependency setup. Pass each review lane a `Known Verification
Evidence` block with exact command lines, working directory, commit/base/head,
results, and any commands that are known not to work. Sub-agents should use
those supplied commands for candidate reproduction instead of falling back to
static-only review. If they still cannot run a needed command without approval,
they must report the blocked command and closest evidence.

## Severity Calibration

Choose severity from concrete impact, not from habit. Do not default everything
to `P2`.

- `P0`: Breaks production or release safety immediately, causes broad data loss,
  bypasses critical security controls, or blocks a live system with no
  reasonable workaround.
- `P1`: Blocks the PR's main advertised behavior, creates a high-confidence
  security or data-loss risk, breaks a critical user path, corrupts persisted
  state, or will almost certainly fail in normal use.
- `P2`: Important bug or contract break that affects real users or maintainers
  but has a workaround, limited scope, or does not block the whole feature.
- `P3`: Minor correctness, maintainability, coverage, docs, diagnostics, or edge
  case issue that should be fixed but does not materially change the feature's
  safety or core behavior.
- `P4`: Nits and optional polish. Omit these from formal findings unless the
  user explicitly wants exhaustive review.

When deciding between adjacent levels, ask: does this block the PR's stated
purpose, can a normal user hit it, can it lose or expose data, is there a
reasonable workaround, and did reproduction prove a real failure rather than a
theoretical concern? If a finding only says "add a test" without a reproduced
behavioral failure, it is usually `P3` or an unverified risk, not `P2`.

## Final Review Output

When the user asks for a PR or code review, present confirmed findings first as
a Markdown table. Use this table shape unless the user explicitly requests a
different format:

| Severity | Finding | File | Claim | Repro Setup | Expected | Observed | Failure Signal | Fix |
|---|---|---|---|---|---|---|---|---|
| P0/P1/P2/P3/P4 | Short issue title | `path:line` link | What behavior is wrong and why it matters | Safe setup and exact command, API call, app flow, or trace | Correct behavior | Actual behavior | Output, state transition, assertion, or readback proving the issue | Concrete recommended change |

Keep each cell concise but complete enough for a reviewer to understand the
issue without reading hidden notes. If a command or trace is too long for the
table, summarize it in the cell and put the exact command immediately below the
table under `Reproduction Details`.

After the findings table, include a short `Verification` line or paragraph with
the exact checks run or parent-supplied checks relied on, plus their results.
If the PR body had manual verification steps, also include the `Manual
Verification` section described above. If there are no confirmed findings, say
"No confirmed findings" first, then include residual risks and verification.
Put unreproduced concerns in a separate `Unverified Risks` section only when
they are useful and clearly blocked.

## Public Review Comments

The reproduction rubric is for Codex chat/final review output only. Do not paste
rubric tables, reproduction matrices, or internal review ledgers into GitHub,
Azure DevOps, Slack, email, or any other public/provider comment. When posting a
confirmed finding to GitHub, rewrite it as a short human reviewer comment tied
to the line: state the problem, give one concrete impact or example when useful,
and ask for the fix in natural prose. Public comments should not contain table
headers such as `Severity`, `Claim`, `Expected`, `Observed`, or `Failure Signal`.

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
`review-correctness`, `review-design`, `review-security`, `review-tests`, and
`review-product` when that custom agent is exposed by the current runtime.
Do not set `fork_context` with these semantic roles. Full-history forked agents
inherit the parent agent type, model, and reasoning effort, so current Codex
runtimes reject the combination of `fork_context: true` plus `agent_type`. The
review lanes should receive an explicit, self-contained scope instead: absolute
repo path, base/head or dirty-tree scope, key files, task intent, important
prior findings, explicit user constraints, and a `Known Verification Evidence`
section listing parent-run commands, their results, and any commands the lane
should not rerun. These roles use stable display nicknames so the activity log
shows what each agent is actually doing. Omit `model` and
`reasoning_effort` so agents inherit the current model settings. If
`multi_tool_use.parallel` is available, use it to issue the selected
`functions.spawn_agent` calls together. Otherwise, call `spawn_agent` for each
selected lane back-to-back, then use `wait_agent`. If a semantic role is
unavailable in the current runtime, retry that lane once without `agent_type`
and report the fallback. For the product/API contract lane specifically, use a
default sub-agent with the same lane prompt until `review-product` appears in
the runtime's available `agent_type` list.

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

## Review Lane Prompt Contract

Use one shared prompt shape for all review lanes. Keep the lane-specific text
short and put the common evidence, permission, and output rules in one place.

Each lane prompt must include:

- `Role`: the lane name and what it is responsible for.
- `Scope`: absolute repo path, base/head or dirty-tree scope, key files, PR
  metadata when available, and task intent.
- `Requirements and claims`: relevant plan text, PR body excerpts, API/schema
  excerpts, or reviewer-facing claims the lane should verify.
- `Known Verification Evidence`: parent-run commands, results, smoke-test
  output, blocked commands, and commands the lane should not rerun.
- `Rules`: inspect the actual diff and surrounding code; do not trust summaries
  or implementer reports; do not run `git fetch`, `git pull`, `gt sync`, or any
  network git operation; do not request sandbox escalation or approval prompts.
- `Evidence gate`: report only concrete issues grounded in changed behavior,
  changed contracts, deterministic traces, schema or docs comparisons, API
  response gaps, or reviewer-runnable commands. If proof is blocked, report the
  exact blocker and closest evidence instead of looping on workarounds.
- `Output`: confirmed findings first, using severity, file/line, claim,
  evidence, expected behavior or contract, observed behavior or gap, failure
  signal, and fix. If there are no confirmed issues, say so and note residual
  risk.

**Shared prompt body:**
```
Review <self-contained scope and intent>.

Known Verification Evidence:
<exact parent-run commands, results, smoke tests, blocked commands, and commands
not to rerun>

Rules:
- Inspect the actual diff and relevant surrounding code.
- Do not trust summaries, implementer reports, or PR claims without checking.
- Do not run git fetch, git pull, gt sync, or any network git operation.
- Do not request sandbox escalation or approval prompts.
- Treat parent-supplied verified commands and smoke-test results as review
  evidence; cite them instead of rerunning broad checks.
- Reproduce only concrete candidate findings before listing them as issues.
- If a command would need approval, hits sandbox/tooling failure, or requires
  external state, record the blocked command and closest evidence.

Output:
- Confirmed findings first.
- For each finding: severity, file/line, claim, evidence, expected behavior or
  contract, observed behavior or gap, failure signal, and fix.
- If no confirmed issues, say so and note residual risk.
```

**Lane A - Correctness & bugs:**
```
spawn_agent(
  agent_type: "review-correctness",
  message: "<shared prompt body>. Role: correctness lane. Focus only on logic errors, off-by-ones, edge cases, null and empty handling, race conditions, error-path bugs, incorrect async/await, state-machine holes, and behavior regressions."
)
```

**Lane B - Design & architecture:**
```
spawn_agent(
  agent_type: "review-design",
  message: "<shared prompt body>. Role: design lane. Focus only on API shape, naming, abstraction boundaries, coupling, dead or speculative code, premature abstractions, duplication, and maintainability risks grounded in the changed surface."
)
```

**Lane C - Security:**
```
spawn_agent(
  agent_type: "review-security",
  message: "<shared prompt body>. Role: security lane. Focus only on authn/authz, input validation, SQL, command, path, and template injection, SSRF, secrets in code or logs, unsafe deserialization, crypto misuse, dependency risk, unsafe public writes, and concrete attack paths."
)
```

**Lane D - Tests & coverage:**
```
spawn_agent(
  agent_type: "review-tests",
  message: "<shared prompt body>. Role: tests lane. Focus only on whether tests exercise changed behavior, mocks hide integration risk, edge cases are missing, timing is flaky, assertions are weak, fixtures are unrealistic, or a broken implementation would still pass."
)
```

**Lane E - Product/API contract, optional when applicable:**
```
spawn_agent(
  agent_type: "review-product",
  message: "<shared prompt body>. Role: product/API contract lane. Focus only on changed public APIs, response schemas, workflow artifacts, user-visible docs, validation claims, warning surfaces, ambiguous selection rules, inspectability, unsupported semantics, and integration contract clarity. Prefer P2 or P3; use P1 only when the gap blocks the PR's stated purpose or creates likely user, data, or contract harm. Do not report vague nice-to-have ideas."
)
```

If `review-product` is not exposed by the current runtime, spawn this lane with
the default agent type and keep the same prompt text.

**Lane F - PR body manual verification, optional when applicable:**
```
spawn_agent(
  message: "Review <self-contained intent + repo path + diff scope + PR body manual verification excerpt + Known Verification Evidence>. Lens: PR body manual verification only - extract each manual/test-plan step from the PR description, run the exact step when safe and available or after the smallest safe repo-owned setup, and explain what each step proves. Do not run git fetch, git pull, gt sync, or any network git operation. Do not request sandbox escalation or approval prompts. Treat parent-supplied setup and verification as authoritative. If a local service, dependency, fixture, database, generated artifact, or temp state is missing, first try the smallest sandbox-safe setup. If setup needs unavailable credentials, unsafe/destructive actions, external services, or approval, mark it blocked with the exact missing dependency or blocked setup command and closest safe evidence. Return a step-by-step ledger with: step label, claim proved, exact command/API/app flow/trace, observed output or state, status, and any failure signal. Do not report code-review findings except when a manual step failure proves a concrete bug or broken PR instruction."
)
```

## Merge

Use the Cross-Model Evidence Collection Protocol in `references/codex-evidence-collection.md` when that reference is available: normalize each lane's report, dedupe findings across lanes (same issue raised by multiple agents = high confidence), and preserve strengths.

Before presenting findings, apply the Finding Reproduction Gate. Sub-agent
agreement raises confidence, but it does not replace reproduction. The final
review should list only reproduced findings, with unreproduced concerns either
dropped or placed in "Unverified Risks" with the blocker.
For product/API contract findings, reproduction evidence may be a deterministic
contract trace, schema or docs comparison, API response gap, or concrete
PR/body claim mismatch when a failing command is not the right proof shape.

If the current task is implementation, PR preparation, or finishing a change, fix
confirmed issues and valid low-risk suggestions before claiming done. If the user
asked for review only, present findings without editing. Present conflicts,
high-risk changes, or judgment calls to the user.

## Failures

If one lane errors out, proceed with the remaining selected lanes and report the
failed lane.
If two or more lanes fail during a full review, rerun those lenses sequentially
in the current assistant or stop and surface the errors. For a full review, do
not claim the review gate passed unless all required lanes completed or every
failed required lane was rerun sequentially. For a smaller risk-scaled review,
report exactly which lenses ran and which, if any, failed.
