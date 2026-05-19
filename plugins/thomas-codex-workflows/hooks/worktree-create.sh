#!/usr/bin/env bash
# Codex WorktreeCreate hook.
#
# Replaces the default `git worktree add` behavior so that:
#   1. Branch names conform to <type>/<slug> where
#      type in {feat,feature,fix,chore,docs,refactor,test,ci,build,perf,hotfix,release,revert,codex}
#      slug matches [a-z0-9._-]+
#   2. If a matching branch (local or remote) already exists, the existing
#      branch is checked out into the new worktree instead of creating one.
#   3. New branches are cut from origin/<default-branch>.
#
# Stdin JSON (from Codex):
#   { "worktree_path": "...", "isolation_source_path": "...", "cwd": "...", ... }
# Stdout: the final worktree path (single line).
# Exit non-zero aborts worktree creation.

set -euo pipefail

LOG="${HOME}/.Codex/log/worktree-create.log"
mkdir -p "$(dirname "$LOG")"

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }
die() { log "ERROR: $*"; printf 'worktree-create hook: %s\n' "$*" >&2; exit 1; }

input=$(cat)
log "STDIN: $input"

worktree_path=$(printf '%s' "$input" | jq -r '.worktree_path // empty')
source_path=$(printf '%s' "$input" | jq -r '.isolation_source_path // .cwd // empty')
name=$(printf '%s' "$input" | jq -r '.name // empty')

[[ -n "$source_path" && -d "$source_path" ]] || die "missing/invalid source_path: $source_path"

cd "$source_path"
git rev-parse --show-toplevel >/dev/null 2>&1 || die "not a git repo: $source_path"
repo_root=$(git rev-parse --show-toplevel)
codex_dir="${repo_root}/.codex"
worktree_base="${codex_dir}/worktrees"

if [ -L "$codex_dir" ]; then
  die "${codex_dir} must not be a symlink"
fi
if [ -e "$codex_dir" ] && [ ! -d "$codex_dir" ]; then
  die "${codex_dir} must be a directory"
fi
if [ -L "$worktree_base" ]; then
  die "${worktree_base} must not be a symlink"
fi
if [ -e "$worktree_base" ] && [ ! -d "$worktree_base" ]; then
  die "${worktree_base} must be a directory"
fi

# Codex may send only {name, cwd}; derive the path from the repo root so a
# malformed hook payload cannot write outside the repo worktree area.
if [[ -z "$worktree_path" && -n "$name" ]]; then
  worktree_path="${worktree_base}/${name}"
  log "derived worktree_path from name: $worktree_path"
fi

[[ -n "$worktree_path" ]] || die "missing worktree_path (and no name to derive from)"

case "$worktree_path" in
  "${worktree_base}"/*)
    relative="${worktree_path#"${worktree_base}/"}"
    ;;
  *)
    die "worktree_path must stay under ${worktree_base}"
    ;;
esac

case "$relative" in
  ""|"."|".."|../*|*/../*|*/..|/*)
    die "invalid worktree name: $relative"
    ;;
esac

VALID_RE='^(feat|feature|fix|chore|docs|refactor|test|ci|build|perf|hotfix|release|revert|codex)/[a-z0-9._-]+$'

if [[ "$relative" =~ $VALID_RE ]]; then
  branch="$relative"
else
  # Normalize to lowercase kebab-case slug, strip invalid chars, collapse dashes.
  slug=$(printf '%s' "$relative" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's#[^a-z0-9./_-]#-#g; s#/+#-#g; s#-+#-#g; s#^-+##; s#-+$##')
  [[ -n "$slug" ]] || slug="session-$(date +%s)"
  branch="feat/${slug}"
fi

git check-ref-format --branch "$branch" >/dev/null 2>&1 || die "invalid branch name: $branch"
final_path="${worktree_base}/${branch}"
log "resolved: branch=$branch path=$final_path"

mkdir -p "$(dirname "$final_path")"
base_real=$(cd "$worktree_base" && pwd -P)
parent_real=$(cd "$(dirname "$final_path")" && pwd -P)
case "${parent_real}/" in
  "${base_real}"/*)
    ;;
  *)
    die "resolved worktree path must stay under ${worktree_base}"
    ;;
esac

# Reuse short-circuit: if the resolved path is already a registered worktree,
# don't try to re-create it. Echo the existing path and exit 0.
registered_worktree=0
if git worktree list --porcelain | awk '/^worktree / {print $2}' | grep -qxF "$final_path"; then
  registered_worktree=1
fi

if [ -L "$final_path" ]; then
  die "${final_path} must not be a symlink"
fi
if [ -e "$final_path" ]; then
  if [ ! -d "$final_path" ]; then
    die "${final_path} already exists and is not a directory"
  fi
  final_real=$(cd "$final_path" && pwd -P)
  case "${final_real}/" in
    "${base_real}"/*)
      ;;
    *)
      die "resolved worktree path must stay under ${worktree_base}"
      ;;
  esac
  if [ "$registered_worktree" -eq 1 ]; then
    log "REUSE $final_path (already a registered worktree)"
    printf '%s\n' "$final_path"
    exit 0
  fi
  die "${final_path} already exists and is not a registered worktree"
fi

if [ "${CODEX_WORKTREE_FETCH:-0}" = "1" ]; then
  git fetch --quiet origin 2>/dev/null || log "WARN: git fetch origin failed"
else
  log "SKIP git fetch origin; set CODEX_WORKTREE_FETCH=1 to refresh refs"
fi

run_worktree_add() {
  if git worktree add "$@" >> "$LOG" 2>&1; then
    printf '%s\n' "$final_path"
    log "CREATED $final_path (branch=$branch)"
    exit 0
  fi
  die "git worktree add failed: $*"
}

if git show-ref --verify --quiet "refs/heads/${branch}"; then
  log "local branch exists; checking out"
  run_worktree_add "$final_path" "$branch"
fi

if git show-ref --verify --quiet "refs/remotes/origin/${branch}"; then
  log "remote branch exists; tracking"
  run_worktree_add --track -b "$branch" "$final_path" "origin/${branch}"
fi

default_ref=$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null || true)
default_branch="${default_ref##*/}"
default_branch="${default_branch:-main}"
base_ref="origin/${default_branch}"
if ! git show-ref --verify --quiet "refs/remotes/origin/${default_branch}"; then
  base_ref=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || git rev-parse --verify HEAD)
  log "origin/${default_branch} not available; using ${base_ref}"
fi
log "new branch from ${base_ref}"
run_worktree_add -b "$branch" "$final_path" "$base_ref"
