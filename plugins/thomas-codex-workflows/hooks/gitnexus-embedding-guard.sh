#!/bin/bash
# Dormant Bash helper.
# Detects `gitnexus analyze` invocations missing --skip-agents-md and schedules
# a background repair of the affected repo.
# Repairs only --skip-agents-md; embeddings remain explicit opt-in.
# Complements the patched AGENTS.md rules and any manual GitNexus maintenance.
# they cover Codex-initiated calls; this catches anything else (Codex, manual
# typing, future plugins, `npx gitnexus`, etc).

set -u

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

# Bail unless this command invokes `gitnexus analyze` (covers `gitnexus ...`
# and `npx [flags] gitnexus ...`).
if ! echo "$CMD" | grep -qE '(^|[^[:alnum:]_/-])gitnexus[[:space:]]+analyze'; then
    exit 0
fi

# Bail if the safe flag was explicitly passed - trust the caller.
if echo "$CMD" | grep -qE '(^|[[:space:]])--skip-agents-md([[:space:]=]|$)'; then
    exit 0
fi

# Resolve the target repo. First try an explicit path arg after `analyze`
# (skipping any flags); fall back to the git toplevel of the session cwd.
REPO_PATH=$(echo "$CMD" | awk '
    BEGIN { seen = 0 }
    {
        for (i = 1; i <= NF; i++) {
            if (seen && $i !~ /^-/) { print $i; exit }
            if ($i == "analyze") seen = 1
        }
    }
')

if [ -z "${REPO_PATH:-}" ]; then
    REPO_PATH=$(git rev-parse --show-toplevel 2>/dev/null)
fi

[ -z "${REPO_PATH:-}" ] && exit 0
[ ! -d "$REPO_PATH/.gitnexus" ] && exit 0

# Short delay lets the original analyze finish before we re-run with --skip-agents-md.
# Per-repo lock prevents two repair jobs colliding on the same LadybugDB file.
# Log repair events so wipes are traceable.
LOG="${CODEX_LOG_DIR:-${HOME}/.Codex/log}/gitnexus-analyze-guard.log"
mkdir -p "$(dirname "$LOG")"
LOCK=/tmp/gitnexus-repair-$(printf '%s' "$REPO_PATH" | shasum | cut -c1-12).lock
(
    sleep 3
    if ! mkdir "$LOCK" 2>/dev/null; then
        printf '[%s] skip (repair in flight): %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$REPO_PATH" >> "$LOG"
        exit 0
    fi
    trap 'rmdir "$LOCK" 2>/dev/null' EXIT
    printf '[%s] repair skip-agents-md: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$REPO_PATH" >> "$LOG"
    gitnexus analyze --skip-agents-md --force "$REPO_PATH" >> "$LOG" 2>&1
    printf '[%s] done:   %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$REPO_PATH" >> "$LOG"
) &
disown 2>/dev/null || true
exit 0
