#!/usr/bin/env bash
# Codex PreToolUse Bash hook router for lightweight repo safety checks.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INPUT="$(cat)"

run_hook() {
  local hook="$1"
  local status=0
  printf '%s' "$INPUT" | /bin/bash "$SCRIPT_DIR/$hook" || status=$?
  if [ "$status" -ne 0 ]; then
    exit "$status"
  fi
}

run_hook main-branch-guard.sh
run_hook pr-create-nag.sh

exit 0
