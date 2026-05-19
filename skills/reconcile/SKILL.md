---
name: reconcile
description: "Rebase a branch onto the latest main (or a specified base), resolving conflicts along the way. Accepts an optional PR number or branch name - without one, reconciles the current branch. Use when the user says '/reconcile', '/reconcile 123', '/reconcile feature/my-branch', 'rebase onto main', 'sync with main', 'catch up with main', or similar. Also use proactively when starting work on a branch that may have fallen behind main."
---

# Reconcile Branch with Main

Rebase the target feature branch (and any stacked descendants) onto the latest remote main, resolve conflicts, and optionally force-push.

Accepts an optional argument matching the `/worktree` convention:

- `/reconcile` - reconcile the current branch.
- `/reconcile 123` - resolve PR #123's head branch and reconcile it.
- `/reconcile feature/my-branch` - reconcile that branch directly.

## Workflow

### 1. Gather state

Call the shared gather script - it fetches, detects Graphite, and resolves the optional arg in one pass:

```bash
~/.Codex/skills/worktree/scripts/gather.sh "${ARG:-}"
```

Parse the JSON. Fields you care about:

- `orig_root` - absolute path to the repo toplevel.
- `is_graphite` - 0 or 1. Determines the rebase path below.
- `resolved_branch` - the target branch if the user passed an arg; `null` otherwise.
- `fetch_warn` - surface to the user if non-null (e.g., "fetch failed, continuing with stale local data").
- `picker` - **ignore** in reconcile. We don't do interactive picking here; if the user wants a picker they use `/worktree` first.

On non-zero exit (e.g., bad PR number → `{"error":"could not resolve PR #<N>"}`), surface the error verbatim and stop.

### 2. Switch to target branch (only if arg was given)

If `resolved_branch` is `null`, use the current branch and skip the rest of this step.

If `resolved_branch` differs from the current branch:

1. **Require a clean working tree.** If `git status --porcelain` is non-empty, stop and ask the user to stash or commit first. Stashing on one branch and popping on another is error-prone; keep it explicit rather than automating it.
2. Switch to the target:
   - Graphite (`is_graphite == 1`): `gt checkout <resolved_branch>`
   - Plain git: `git checkout <resolved_branch>`

   If the branch exists only on the remote, `git checkout <branch>` will set up tracking automatically. If checkout fails (ambiguous name, missing branch, etc.), surface stderr verbatim and stop.

From here on, "the current branch" refers to the resolved target.

### 3. Assess divergence

```
git log --oneline HEAD..origin/main   # commits on main we don't have
git log --oneline origin/main..HEAD   # our commits ahead of main
git diff --stat HEAD..origin/main     # files changed on main
```

(No need for `git fetch` - step 1 already did it via `gather.sh`.)

If `HEAD..origin/main` is empty AND (`is_graphite == 0` OR `gt log short` shows no out-of-date branches), report "Already up to date" and stop.

### 4. Stash uncommitted work

If `git status` shows unstaged or staged changes, stash them before rebasing:

```
git stash push -m "reconcile: stash before rebase"
```

Note: step 2 already refused to switch branches with a dirty tree, so this step only fires when the arg was omitted (reconciling the current branch) or equal to the current branch.

### 5a. Graphite path: `gt sync`

Before syncing, ensure the current branch is tracked. If `gt log short` doesn't list it:

```
gt branch track <branch> --parent main
```

Then sync the whole stack:

```
gt sync --force --no-interactive --restack
```

This pulls `main`, may delete local branches that Graphite considers merged, and
restacks every descendant onto the new `main`. Before running it, confirm there
are no unpushed local commits on stack branches. If it would delete a branch with
local work, ask the user before proceeding. If conflicts arise, Graphite pauses
mid-rebase exactly like `git rebase` - jump to step 6 to resolve, then
`gt continue` (not `git rebase --continue`).

If `gt sync` fails because the branch diverged from Graphite's tracking (common after a force-push from another machine), run `gt track <branch>` and retry.

### 5b. Non-Graphite path: `git rebase`

```
git rebase origin/main
```

If the user specified a different base (e.g., "reconcile with develop"), use that instead.

### 6. Resolve conflicts

For each conflict:

1. Identify conflicting files from the rebase output.
2. Read the conflicted regions (look for `<<<<<<<`, `=======`, `>>>>>>>`).
3. Understand intent from both sides by checking the commit messages and surrounding code.
4. Resolve by keeping the semantically correct combination of both sides. When both sides add independent content to the same section, keep all of it. When both sides modify the same logic, prefer the version that incorporates the newer design.
5. Stage resolved files and continue: `gt continue` on the Graphite path, `git rebase --continue` on the plain-git path.
6. Repeat until the rebase completes.

**Conflict resolution principles:**
- Documentation conflicts (both sides add bullets/sections): merge all content, deduplicate, keep the more detailed version of overlapping descriptions.
- Code conflicts (same function modified): read both commits to understand intent. If one refactors and the other adds features, apply the feature on top of the refactored code.
- Import/config conflicts: union of both sides, remove duplicates.
- If a conflict is ambiguous, ask the user before resolving.

### 7. Restore stashed work

```
git stash pop   # only if step 4 stashed something
```

### 8. Run pre-commit checks

```
uv run pre-commit run --all-files
```

Fix any issues introduced by conflict resolution (indentation, formatting, line length).

### 9. Push

Ask the user before force-pushing. When confirmed, push every branch that moved.

- **Graphite path:** `gt sync` rebases all descendants, so push each affected branch. List them with `gt log short` and push in order:
  ```
  git push --force-with-lease origin <branch>
  ```
  (Do NOT use `gt submit` unless Graphite access was explicitly confirmed for the current repository.)

- **Non-Graphite path:**
  ```
  git push --force-with-lease origin <branch>
  ```

## Notes

- Never use `git rebase -i` (interactive mode is unsupported).
- `gt sync --force` deletes local branches that have been merged on the remote. This is the intended behaviour - but if the user has uncommitted work on a soon-to-be-deleted branch, step 4's stash protects it.
- After rebasing, the local and remote branches will have diverged. Force-push with `--force-with-lease` is safe here since we just rebased our own commits.
- **Arg resolution is intentionally lighter than `/worktree`'s.** There's no picker, no mode question, and no session switch - reconcile just needs "which branch" and then operates on it in-place. If you want the rich picker UX, use `/worktree` first and then `/reconcile` inside it.
