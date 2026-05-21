---
name: worktree
description: "Create a git worktree or switch checkout for a PR number, branch name, or an interactively picked 'live' branch (your open PRs + PRs needing your review, Graphite-aware). Worktree mode pulls latest from remote, copies gitignored dev files, and reuses an exact-commit GitNexus index when one already exists. Use when the user says '/worktree', '/worktree 123', '/worktree feature/my-branch', or wants to hop onto an existing PR without losing their current checkout."
---

# Create Git Worktree / Switch Checkout

This skill is a thin coordinator around a few shell scripts plus the native
`EnterWorktree` tool when the Codex runtime exposes it. **Do not re-implement
their logic in inline bash** - call the scripts and react to their output/exit
codes. Scripts live in this skill's `scripts/` directory; resolve that path
relative to this `SKILL.md` in the installed plugin copy.

- `gather.sh [arg]` - one call. Fetches, detects Graphite, either resolves `arg` to a branch or gathers picker data. Returns JSON.
- `EnterWorktree(name=<branch>)` - optional native tool. Use it only when it is
  present in the current tool list. It creates the worktree via the local
  `WorktreeCreate` hook and switches the session's project directory into it.
  This is how the desktop app's bottom bar follows the worktree. The hook handles
  existing-branch checkout, new-branch creation, and reuse of existing worktrees.
- `post-enter.sh <main_root>` - runs INSIDE the new worktree after `EnterWorktree`. Pulls latest from the remote, copies gitignored dev files from main, and asks the shared GitNexus helper to reuse an exact-commit index when available. It defers expensive indexing when no reusable index exists.
- `rebind-current-thread.mjs --branch <branch> --source <repo-root> [--thread-id <id>] [--dry-run] [--open-app-fallback]` - probe-first fallback for runtimes without `EnterWorktree`. It prepares or reuses a worktree under Codex's managed worktree area, then tries the supported app-server protocol. It only reports `rebound` when app-server returns the worktree cwd.
- `execute.sh switch <branch> <main_root> <is_graphite>` - used ONLY for "switch checkout" mode, not for worktree creation.

## Workflow

### 1. Gather

```bash
<worktree_skill_dir>/scripts/gather.sh "${ARG:-}"
```

Parse the JSON. Fields you care about:

- `orig_root` - absolute path to the repo toplevel (needed for `execute.sh`)
- `is_graphite` - 0 or 1
- `resolved_branch` - set if the user passed an arg; null otherwise
- `existing_worktree_path` - set if `resolved_branch` is already checked out in a registered worktree; null otherwise
- `fetch_warn` - surface to the user if non-null ("fetch failed, continuing with stale local data")
- `auth_hint` - surface to the user if non-null (possible provider account mismatch)
- `picker.needs_review` - array of PR rows (only when `resolved_branch` is null)
- `picker.mine` - array of PR rows (only when `resolved_branch` is null)

If `gather.sh` exits non-zero or the JSON contains `error`, stop and report the error to the user.

**Early exit: existing worktree.** If `existing_worktree_path` is non-null, the branch is already checked out somewhere. Do not ask the mode question, do not call `EnterWorktree`, do not run `execute.sh`. Just tell the user:

> `<branch>` is already checked out at `<existing_worktree_path>`. Run `cd <existing_worktree_path>` in your terminal to work on it.

Also surface `fetch_warn` / `auth_hint` if non-null. Then stop. The user does the `cd` themselves; the skill is finished.

This is the fast path for `/worktree <branch>` where the worktree already exists - skipping all mutation avoids the `EnterWorktree`-refuses-to-nest and `execute.sh`-can't-add-already-checked-out-branch mess we otherwise hit.

### 2. Resolve target branch

**Case A - `resolved_branch` is non-null**: use it directly. Jump to step 3.

**Case B - `resolved_branch` is null**: build an `ask the user in chat` payload from the picker rows:

- Up to **2 rows** from `needs_review` (already sorted oldest-first - aging review requests are most urgent).
- Up to **2 rows** from `mine` (already sorted stack-first, then newest-first within tiers).
- If one bucket is short, pad with the other bucket up to 4 options total.
- Each option label: `"#<number> <truncated title>"`.
- Each option description: bucket + review/CI glyphs + `updated_rel` + author (needs-review only) + `· stack` if `in_stack`.
- `ask the user in chat` auto-appends "Other…" - treat a user "Other" answer as free-text. Strip leading `#`. If it parses as an integer, re-run `gather.sh <num>` to resolve. Otherwise use it as a branch name.

Render a short pre-prompt summary line above the question so the user sees context, e.g.:
`"Pulled N live PRs (X needs-review, Y mine). Pick one:"`

**Zero rows across both buckets**: fall back to a Minimal Picker with options `[current branch, main, Other…]`.

### 3. Mode question

Ask once, **before** any mutation:

- question: `"How do you want to work on <branch>?"`
- header: `"Mode"`
- options:
  - `"Open as worktree"` - isolated path under `.codex/worktrees/`, parallel with current checkout. **Default for reviewing teammate PRs.**
  - `"Switch checkout"` - `gt checkout` / `git checkout` in the current tree. Fast but replaces current branch.
  - `"Cancel"` - back out.

Treat user "Other" here as Cancel (no useful semantics).

### 4. Execute - worktree mode

**This is the happy path when `EnterWorktree` is available.** The `WorktreeCreate`
hook and `EnterWorktree` together handle path derivation, existing-branch
checkout, and session switching. You only have to do three steps:

1. **Call `EnterWorktree` only if it is available, with the branch name as the
   `name` parameter.** The hook interprets `name` as `<type>/<slug>` (must match
   `feat|feature|fix|chore|docs|refactor|test|ci|build|perf|hotfix|release|revert|codex`
   and a kebab-case slug) and:
   - If the worktree already exists at the derived path → reuses it
   - Else if a local branch of that name exists → checks it out into the new worktree
   - Else if a remote branch of that name exists → creates a tracking worktree
   - Else → creates a new branch off `origin/<default>` (almost never what you want for `/worktree`, so if this happens with a user-named branch something is wrong)

   ```
   EnterWorktree(name="fix/db-recreate")
   ```

   After this call returns success, **the session is now anchored in the worktree**. `pwd` in the next bash call will report the worktree path. The desktop app's bottom bar will follow. No manual `cd`, no file-tool path rewriting - the session moved.

2. **Call `post-enter.sh` with the main repo path as its arg.** The main repo path is `gather.sh`'s `orig_root` field. This runs inside the new worktree and does:
   - `git pull --ff-only` if the branch tracks a remote
   - Copy gitignored dev files (`.env*`, `.envrc`) from main so the worktree is immediately runnable
   - Reuse an exact-commit GitNexus index from another worktree when available, otherwise defer expensive indexing until graph tools are needed
   - Print a hint block

   ```bash
   <worktree_skill_dir>/scripts/post-enter.sh <orig_root>
   ```

3. **Relay the hint block to the user**, along with any warnings from gather (`fetch_warn`, `auth_hint`).

#### What if EnterWorktree is unavailable or fails?

If `EnterWorktree` is not present in the current tool list, or it errors,
surface that native session switching is unavailable and run the app-server
probe helper before using legacy manual discipline:

```bash
<worktree_skill_dir>/scripts/rebind-current-thread.mjs --branch <branch> --source <orig_root> --thread-id "${CODEX_THREAD_ID:-}"
```

Parse the JSON result and handle it honestly:

- `rebound`: app-server confirmed the thread cwd is the worktree. The helper has already prepared the worktree, copied approved dev files, and reused or deferred the GitNexus index. Relay the result and continue from the worktree.
- `prepared_only`: the worktree is ready, but app-server did not accept the cwd change. Use the returned `worktreePath` and the "Legacy rebind discipline" section.
- `unsupported`: no reachable app-server endpoint had this thread loaded, or `CODEX_THREAD_ID` was missing. If `preparation.prepared` is true, use the returned `worktreePath` with legacy discipline.
- `fallback_opened`: the helper opened Codex Desktop at the prepared worktree because `--open-app-fallback` was explicitly used. This is not a same-thread rebind.
- `failed`: report the error. If the failure happened before worktree preparation, use `execute.sh worktree` only after telling the user why the probe path failed.

Validated behavior to remember: current local app-server Unix sockets speak
WebSocket over the Unix socket, not raw JSONL, and `thread/resume.cwd` overrides
are ignored for already running or loaded threads. So this probe is an honest
best-effort fallback, not a replacement for native `EnterWorktree`.

If the helper cannot run at all and the user still wants a worktree, use the
legacy script fallback:

```bash
<worktree_skill_dir>/scripts/execute.sh worktree <branch> <orig_root> <is_graphite>
```

The legacy fallback uses plain `git worktree add` without the session switch. The
desktop bottom bar will not follow, and you must manually set shell cwd plus use
absolute paths for file edits.

### 5. Execute - switch mode

```bash
<worktree_skill_dir>/scripts/execute.sh switch <branch> <orig_root> <is_graphite>
```

Read the exit code:

| Exit | Meaning                              | What to do                                                                                                                                           |
| ---- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Success                              | Print stdout verbatim. No rebind needed - switch mode doesn't move between directories, just changes HEAD in place.                                  |
| 10   | Dirty working tree                   | `ask the user in chat` → `["Stash and continue", "Commit first", "Cancel"]`. On "Stash and continue", re-run with mode `switch-stashed`.                 |
| 12   | Branch not found                     | Report and stop.                                                                                                                                     |
| 20   | Other failure                        | Surface stderr verbatim and stop.                                                                                                                    |

### 6. Legacy rebind discipline (fallback path only)

**Skip this section entirely if you used `EnterWorktree` successfully** - the session switch handled everything.

If `rebind-current-thread.mjs` returned anything other than `rebound`, or if you
had to fall back to `execute.sh worktree`, the session was NOT switched. You need
to manually keep Codex's attention on the worktree:

1. **Shell**: run subsequent commands with `workdir=<wt_path>`, or issue a single
   `cd <wt_path>` when using a persistent shell session.
2. **File operations**: use absolute paths under `<wt_path>/...` for every
   read, edit, search, or patch operation. Do not rely on shell cwd for tools
   that take file paths.
3. **Absolute paths from memory or prior tool results**: any path that starts with the main repo root must be rewritten to start with `<wt_path>`.
4. **The main repo path is off-limits** unless the user explicitly asks about a different branch.

This is exactly the discipline the legacy manual-worktree flow required, and it's error-prone - that's why `EnterWorktree` + the hook is now the happy path. Use the fallback only when forced.

## Configuring copied dev files

`execute.sh` and `post-enter.sh` copy gitignored files matching a whitelist of globs into the new worktree so it's immediately runnable. Default globs: `.env .env.local .env.*.local .envrc`. They also call the shared GitNexus helper. If another worktree already has an index for the same commit, the helper copies that index and registers the new worktree. If no exact-match index exists, indexing is deferred so worktree creation does not burn CPU.

**Per-repo override**: create `<repo>/.codex/worktree.conf` with a single line:
```sh
WORKTREE_COPY_GLOBS=".env .env.local .env.test .envrc direnv/envrc"
```

The conf file is sourced at the top of `execute.sh`. Don't add `node_modules`, `.venv`, or similar - those can break because they contain absolute paths baked in at install time. The user should run their normal setup commands inside the new worktree.

## Notes

- **One bash call per phase.** Do not re-run git, provider, or worktree discovery from the skill directly - those details live in the scripts. Your job is: gather, ask, execute, relay.
- **Never bypass the mode question.** Always get explicit user confirmation before mutating, even when the arg was explicit.
- **Never delete files.** `execute.sh` never removes anything; its output suggests `git worktree remove` as user-initiated cleanup.
- **Account hygiene**: the skill doesn't touch git user config. If `auth_hint` fires, surface it but don't auto-fix.
- **`gt sync` is not this skill's job**: `/reconcile` handles fetching + rebasing. This skill just gets the user onto a branch; it does not cascade rebases.
- **Concurrency**: two parallel `/worktree` invocations on the same branch will race at `git worktree add`. The second will be caught by the reuse check in `execute.sh` and reuse the first. No locking needed.
