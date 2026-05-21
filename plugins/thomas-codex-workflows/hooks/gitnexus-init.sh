#!/bin/bash
# Auto-init GitNexus index on first use, and refresh when stale.
# Staleness = .gitnexus/meta.json lastCommit differs from current HEAD.
if ! command -v gitnexus &>/dev/null; then
  exit 0
fi

if ! git rev-parse --is-inside-work-tree &>/dev/null; then
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
HEAD_SHA=$(git rev-parse HEAD 2>/dev/null)
GIT_DIR=$(git rev-parse --path-format=absolute --git-dir 2>/dev/null)
COMMON_DIR=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)

find_worktree_helper() {
  local candidate
  for candidate in \
    "$SCRIPT_DIR/../../thomas-codex-skills/skills/worktree/scripts/gitnexus-worktree-index.mjs" \
    "$SCRIPT_DIR/../../../thomas-codex-skills"/*/skills/worktree/scripts/gitnexus-worktree-index.mjs; do
    if [ -f "$candidate" ]; then
      printf '%s/%s\n' "$(cd "$(dirname "$candidate")" && pwd -P)" "$(basename "$candidate")"
      return 0
    fi
  done
  return 1
}

if [ -n "$GIT_DIR" ] && [ -n "$COMMON_DIR" ] && [ "$GIT_DIR" != "$COMMON_DIR" ]; then
  HELPER=$(find_worktree_helper || true)
  if command -v node >/dev/null 2>&1 && [ -f "$HELPER" ]; then
    MSG=$(node "$HELPER" --repo "$REPO_ROOT" 2>/dev/null || true)
    [ -n "$MSG" ] && echo "GitNexus: $MSG"
    exit 0
  fi

  if [ -r "$REPO_ROOT/.gitnexus/meta.json" ] && [ -n "$HEAD_SHA" ]; then
    INDEXED_SHA=$(grep '"lastCommit"' "$REPO_ROOT/.gitnexus/meta.json" | head -1 | sed -E 's/.*"lastCommit"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
    if [ -n "$INDEXED_SHA" ] && [ "$INDEXED_SHA" = "$HEAD_SHA" ]; then
      echo "GitNexus: already current"
      exit 0
    fi
  fi

  echo "GitNexus: deferred for worktree - run gitnexus analyze --skip-agents-md when graph is needed"
  exit 0
fi

if [ -d "$REPO_ROOT/.gitnexus" ]; then
  META="$REPO_ROOT/.gitnexus/meta.json"
  if [ -r "$META" ] && [ -n "$HEAD_SHA" ]; then
    INDEXED_SHA=$(grep '"lastCommit"' "$META" | head -1 | sed -E 's/.*"lastCommit"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
    if [ -n "$INDEXED_SHA" ] && [ "$INDEXED_SHA" != "$HEAD_SHA" ]; then
      gitnexus analyze --skip-agents-md "$REPO_ROOT" &>/dev/null &
      echo "GitNexus: index stale (${INDEXED_SHA:0:7} vs ${HEAD_SHA:0:7}), refreshing in background..."
    fi
  fi
  exit 0
fi

gitnexus analyze --skip-agents-md "$REPO_ROOT" &>/dev/null &
echo "GitNexus: indexing repo in background..."
exit 0
