#!/usr/bin/env bash
# Optional GitNexus pre-search enrichment hook.
# Exits quietly when the global GitNexus hook is not installed on this machine.
set -u

INPUT=$(cat)

run_hook() {
  local node_bin="$1"
  local hook_path="$2"
  if [ -x "$node_bin" ] && [ -f "$hook_path" ]; then
    printf '%s' "$INPUT" | "$node_bin" "$hook_path"
    exit $?
  fi
}

run_hook "/opt/homebrew/bin/node" "/opt/homebrew/lib/node_modules/gitnexus/hooks/claude/gitnexus-hook.cjs"
run_hook "/usr/local/bin/node" "/usr/local/lib/node_modules/gitnexus/hooks/claude/gitnexus-hook.cjs"
if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  GLOBAL_ROOT=$(npm root -g 2>/dev/null || true)
  if [ -n "${GLOBAL_ROOT:-}" ] && [ -f "$GLOBAL_ROOT/gitnexus/hooks/claude/gitnexus-hook.cjs" ]; then
    printf '%s' "$INPUT" | node "$GLOBAL_ROOT/gitnexus/hooks/claude/gitnexus-hook.cjs"
    exit $?
  fi
fi

exit 0
