#!/usr/bin/env bash
# gather.sh  -  resolve target + build candidate list + fan out per-candidate signals.
# Usage: gather.sh [arg]
#   arg is optional:
#     numeric (e.g. "123" or "#123") → PR mode on that explicit PR number
#     "--repo-only"                   → force repo-only mode even if current branch has a PR
#     "--refresh"                     → wipe cache and run fresh (auto-detect after)
#     empty                           → auto-detect PR from current branch; fall back to repo mode
#
# Emits one JSON object on stdout. Human warnings go to stderr.
# Schema: see SKILL.md "gather.sh output schema".
#
# Caching (under $XDG_CACHE_HOME/find-reviewer, default ~/.cache/find-reviewer/):
#   signals/<repo_slug>-<login>.json              TTL 900s   (load+breadth; repo-scoped because some fields are)
#   candidates/<repo_slug>.json                   TTL 3600s  (merged PR set changes slowly)
#   file-authors/<repo_slug>-<head_sha>.json      TTL 0      (immutable  -  keyed to PR's head)
#   emails.json                                   TTL ∞      (commit email → GitHub login map)

set -uo pipefail

ARG="${1:-}"
CANDIDATE_CAP=4

CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/find-reviewer"
mkdir -p "$CACHE_DIR/signals" "$CACHE_DIR/candidates" "$CACHE_DIR/file-authors" 2>/dev/null

if [ "$ARG" = "--refresh" ]; then
  rm -rf "$CACHE_DIR"
  mkdir -p "$CACHE_DIR/signals" "$CACHE_DIR/candidates" "$CACHE_DIR/file-authors"
  ARG=""  # fall through to auto-detect
fi

EMAIL_CACHE="$CACHE_DIR/emails.json"

# ---------- cache helpers ----------
# cache_get <relpath> <ttl_seconds>
#   ttl=0 → no expiry (immutable).
#   On hit, writes cached contents to stdout, returns 0. On miss/expired, returns 1.
cache_get() {
  local rel="$1" ttl="$2"
  local file="$CACHE_DIR/$rel"
  [ -s "$file" ] || return 1
  if [ "$ttl" -ne 0 ]; then
    local mtime now
    mtime="$(stat -f %m "$file" 2>/dev/null || stat -c %Y "$file" 2>/dev/null || echo 0)"
    now="$(date +%s)"
    [ "$((now - mtime))" -lt "$ttl" ] || return 1
  fi
  cat "$file"
}
# cache_put <relpath>  (reads data from stdin)
cache_put() {
  local rel="$1"
  local file="$CACHE_DIR/$rel"
  mkdir -p "$(dirname "$file")" 2>/dev/null
  cat >"$file"
}

# ---------- fetch ----------
FETCH_STDERR="$(git fetch --all 2>&1 >/dev/null)"
FETCH_RC=$?
FETCH_WARN=""
if [ "$FETCH_RC" -ne 0 ] || printf '%s\n' "$FETCH_STDERR" | grep -qE '^(fatal|error):'; then
  FETCH_WARN="fetch failed, continuing with stale local data"
fi

# ---------- resolve repo ----------
REPO_JSON="$(gh repo view --json nameWithOwner,defaultBranchRef 2>/dev/null || true)"
if [ -z "$REPO_JSON" ]; then
  printf '{"error":"not in a github-connected repo"}\n'
  exit 1
fi
NAME_WITH_OWNER="$(jq -r '.nameWithOwner' <<<"$REPO_JSON")"
DEFAULT_BRANCH="$(jq -r '.defaultBranchRef.name // "main"' <<<"$REPO_JSON")"
REPO_SLUG="${NAME_WITH_OWNER//\//-}"  # cache-safe filename fragment

# ---------- resolve target (mode + PR) ----------
MODE="repo"
PR_JSON="null"
PR_AUTHOR=""
PR_HEAD_SHA=""
ARG_CLEAN="${ARG#\#}"

# Request headRefOid so we can key the file-authors cache on PR head SHA.
PR_FIELDS="number,title,headRefName,headRefOid,baseRefName,author,files"

if [ "$ARG" = "--repo-only" ]; then
  :  # force repo mode
elif [[ "$ARG_CLEAN" =~ ^[0-9]+$ ]]; then
  PR_VIEW="$(gh pr view "$ARG_CLEAN" --json "$PR_FIELDS" 2>/dev/null || true)"
  if [ -z "$PR_VIEW" ]; then
    printf '{"error":"could not resolve PR #%s"}\n' "$ARG_CLEAN"
    exit 2
  fi
  MODE="pr"
  PR_JSON="$PR_VIEW"
  PR_AUTHOR="$(jq -r '.author.login // empty' <<<"$PR_VIEW")"
  PR_HEAD_SHA="$(jq -r '.headRefOid // empty' <<<"$PR_VIEW")"
elif [ -z "$ARG" ]; then
  PR_VIEW="$(gh pr view --json "$PR_FIELDS" 2>/dev/null || true)"
  if [ -n "$PR_VIEW" ]; then
    MODE="pr"
    PR_JSON="$PR_VIEW"
    PR_AUTHOR="$(jq -r '.author.login // empty' <<<"$PR_VIEW")"
    PR_HEAD_SHA="$(jq -r '.headRefOid // empty' <<<"$PR_VIEW")"
  fi
else
  printf '{"error":"unknown argument: %s (expected PR number, --repo-only, --refresh, or no arg)"}\n' "$ARG"
  exit 3
fi

CHANGED_FILES=()
if [ "$MODE" = "pr" ]; then
  while IFS= read -r f; do
    [ -n "$f" ] && CHANGED_FILES+=("$f")
  done < <(jq -r '.files[].path' <<<"$PR_JSON")
fi

# ---------- build candidate list ----------
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

candidate_pool=""
if candidate_pool="$(cache_get "candidates/$REPO_SLUG.json" 3600)"; then
  :  # cache hit
else
  # Source 1: authors + reviewers of the last 30 merged PRs.
  # Keep duplicates  -  the count per login is our activity-frequency proxy,
  # which determines ordering so the most-engaged reviewers beat an
  # alphabetical sort when we cap the pool.
  gh pr list --state merged --limit 30 \
    --json author,reviews \
    --jq '[.[] | .author.login, (.reviews[]?.author.login)] | map(select(. != null)) | .[]' \
    >"$TMPDIR/logins_prs_multi.txt" 2>/dev/null || : >"$TMPDIR/logins_prs_multi.txt"

  # Source 2: commit authors in the last 90 days, mapped to GitHub logins.
  # Each git-mapped login counts as a single tiebreaker entry (appended after
  # the PR-ranked set); no need to weight by commit count.
  git log --since="90 days ago" --format='%ae' | sort -u >"$TMPDIR/emails_git.txt"
  [ -s "$EMAIL_CACHE" ] || echo '{}' >"$EMAIL_CACHE"

  : >"$TMPDIR/logins_git.txt"
  while IFS= read -r email; do
    [ -z "$email" ] && continue
    if [[ "$email" =~ ^([0-9]+\+)?([a-zA-Z0-9][a-zA-Z0-9-]*)@users\.noreply\.github\.com$ ]]; then
      echo "${BASH_REMATCH[2]}" >>"$TMPDIR/logins_git.txt"
      continue
    fi
    cached="$(jq -r --arg e "$email" '.[$e] // empty' "$EMAIL_CACHE" 2>/dev/null || true)"
    if [ -n "$cached" ]; then
      [ "$cached" != "__unknown__" ] && echo "$cached" >>"$TMPDIR/logins_git.txt"
      continue
    fi
    login=""
    if search_json="$(gh api -X GET search/users -f q="$email in:email" 2>/dev/null)"; then
      login="$(jq -r '.items[0].login // empty' <<<"$search_json")"
    fi
    tmp="$(mktemp)"
    jq --arg e "$email" --arg l "${login:-__unknown__}" '. + {($e): $l}' "$EMAIL_CACHE" >"$tmp" \
      && mv "$tmp" "$EMAIL_CACHE"
    [ -n "$login" ] && echo "$login" >>"$TMPDIR/logins_git.txt"
  done <"$TMPDIR/emails_git.txt"

  # Cache the unfiltered, uncapped, frequency-ordered pool. PR-author exclusion
  # and cap happen at read time so the cache is reusable across PRs in this repo.
  # Order: PR-authors-and-reviewers sorted by count desc, then git-only logins
  # as tiebreakers, then drop bots. `awk '!seen[$0]++'` preserves insertion order.
  candidate_pool="$({
    sort "$TMPDIR/logins_prs_multi.txt" 2>/dev/null | uniq -c | sort -rn | awk '{print $2}'
    cat "$TMPDIR/logins_git.txt" 2>/dev/null
  } | awk 'NF && !seen[$0]++' | grep -v '\[bot\]$')"

  printf '%s\n' "$candidate_pool" | cache_put "candidates/$REPO_SLUG.json"
fi

# Apply PR-author exclusion and cap at read time.
printf '%s\n' "$candidate_pool" \
  | { if [ -n "$PR_AUTHOR" ]; then grep -v "^${PR_AUTHOR}\$"; else cat; fi } \
  | head -n "$CANDIDATE_CAP" \
  >"$TMPDIR/candidates.txt"

# ---------- per-candidate signal fanout ----------
DATE_45D="$(date -u -v-45d +%Y-%m-%d 2>/dev/null || date -u -d '45 days ago' +%Y-%m-%d)"
DATE_180D="$(date -u -v-180d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '180 days ago' +%Y-%m-%dT%H:%M:%SZ)"
HERE_DIR="$(cd "$(dirname "$0")" && pwd)"
FAMILIARITY_SH="$HERE_DIR/familiarity.sh"

# PR mode: per-file author cache is immutable at the PR's head SHA. One lookup
# per (repo, head_sha), reused across every candidate in this run and every
# future run on the same PR-commit.
FILE_AUTHORS_JSON="$TMPDIR/file_authors.json"
echo '{}' >"$FILE_AUTHORS_JSON"
if [ "$MODE" = "pr" ] && [ "${#CHANGED_FILES[@]}" -gt 0 ] && [ -n "$PR_HEAD_SHA" ]; then
  fa_key="file-authors/${REPO_SLUG}-${PR_HEAD_SHA}.json"
  if cache_get "$fa_key" 0 >"$FILE_AUTHORS_JSON" 2>/dev/null && [ -s "$FILE_AUTHORS_JSON" ]; then
    :  # cache hit
  else
    echo '{}' >"$FILE_AUTHORS_JSON"
    for f in "${CHANGED_FILES[@]}"; do
      authors="$(gh api -X GET "repos/$NAME_WITH_OWNER/commits" \
                   -f path="$f" -f since="$DATE_180D" -F per_page=100 2>/dev/null \
                 | jq '[.[] | .author.login // empty]' 2>/dev/null || echo '[]')"
      [ -z "$authors" ] && authors='[]'
      tmp="$(mktemp)"
      jq --arg f "$f" --argjson a "$authors" '. + {($f): $a}' "$FILE_AUTHORS_JSON" >"$tmp" \
        && mv "$tmp" "$FILE_AUTHORS_JSON"
    done
    cat "$FILE_AUTHORS_JSON" | cache_put "$fa_key"
  fi
fi

collect_signals() {
  local login="$1"
  local out="$2"

  # Compute familiarity every time  -  it's a local jq pass, essentially free,
  # and it depends on the PR's specific files, not on cached load signals.
  local familiarity="null"
  if [ "$MODE" = "pr" ] && [ -x "$FAMILIARITY_SH" ] && [ -s "$FILE_AUTHORS_JSON" ]; then
    familiarity="$("$FAMILIARITY_SH" "$login" "$FILE_AUTHORS_JSON" 2>/dev/null || echo 'null')"
    jq -e . >/dev/null 2>&1 <<<"$familiarity" || familiarity="null"
  fi

  # Load-signals cache: scoped to this repo because recent_reviews_in_repo_45d
  # and breadth_top_level_dirs_180d are repo-specific (others would also differ
  # across orgs). TTL 15min  -  load signals shift through the day.
  local cached=""
  if cached="$(cache_get "signals/${REPO_SLUG}-${login}.json" 900)"; then
    jq --arg login "$login" --argjson f "$familiarity" \
       '.login = $login | .signals.familiarity = $f' <<<"$cached" >"$out"
    return 0
  fi

  local qdir; qdir="$(mktemp -d)"

  (gh search prs --review-requested="$login" --state=open --json number --limit 100 2>/dev/null \
     | jq 'length' >"$qdir/open_reviews") &
  (gh search prs --author="$login" --state=open --json number,isDraft --limit 100 2>/dev/null \
     >"$qdir/authored.json") &
  (gh search issues --assignee="$login" --state=open --json number --limit 100 2>/dev/null \
     | jq 'length' >"$qdir/assigned") &
  (gh api "users/$login/events/public?per_page=30" 2>/dev/null \
     | jq -r 'if type == "array" then (.[0].created_at // empty) else empty end' 2>/dev/null \
     >"$qdir/last_event") &
  (gh search prs --reviewed-by="$login" --repo="$NAME_WITH_OWNER" --merged-at=">=$DATE_45D" --json number --limit 100 2>/dev/null \
     | jq 'length' >"$qdir/recent_reviews_in_repo") &
  # Breadth: distinct top-level directories this login committed to in the
  # repo in the last 180d. Server-side author resolution via gh api (works
  # for corporate emails), file paths read from the local clone.
  (gh api "repos/$NAME_WITH_OWNER/commits?author=$login&since=$DATE_180D&per_page=100" \
       --jq '.[].sha' 2>/dev/null \
     | while read -r sha; do
         [ -n "$sha" ] && git show --name-only --format= "$sha" 2>/dev/null
       done \
     | awk -F/ 'length($0)>0 {print $1}' \
     | sort -u \
     | sed '/^$/d' \
     | wc -l \
     | tr -d ' ' >"$qdir/breadth") &
  wait

  local open_reviews authored_total authored_drafts assigned_issues recent_reviews
  open_reviews="$(cat "$qdir/open_reviews" 2>/dev/null || echo 0)"
  open_reviews="${open_reviews:-0}"

  if [ -s "$qdir/authored.json" ]; then
    authored_total="$(jq 'length' "$qdir/authored.json" 2>/dev/null || echo 0)"
    authored_drafts="$(jq '[.[] | select(.isDraft)] | length' "$qdir/authored.json" 2>/dev/null || echo 0)"
  else
    authored_total=0; authored_drafts=0
  fi

  assigned_issues="$(cat "$qdir/assigned" 2>/dev/null || echo 0)"
  assigned_issues="${assigned_issues:-0}"
  recent_reviews="$(cat "$qdir/recent_reviews_in_repo" 2>/dev/null || echo 0)"
  recent_reviews="${recent_reviews:-0}"
  local breadth
  breadth="$(cat "$qdir/breadth" 2>/dev/null || echo 0)"
  breadth="${breadth:-0}"

  local days_since=null
  local last_event_iso
  last_event_iso="$(cat "$qdir/last_event" 2>/dev/null || true)"
  if [ -n "$last_event_iso" ]; then
    local last_epoch now_epoch
    last_epoch="$(date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$last_event_iso" +%s 2>/dev/null \
                  || date -u -d "$last_event_iso" +%s 2>/dev/null \
                  || echo '')"
    if [ -n "$last_epoch" ]; then
      now_epoch="$(date -u +%s)"
      days_since=$(( (now_epoch - last_epoch) / 86400 ))
    fi
  fi

  rm -rf "$qdir"

  # Cache the PR-agnostic part (no familiarity); familiarity is merged in fresh.
  local base
  base="$(jq -n \
    --argjson open_reviews "${open_reviews:-0}" \
    --argjson authored_total "${authored_total:-0}" \
    --argjson authored_drafts "${authored_drafts:-0}" \
    --argjson assigned_issues "${assigned_issues:-0}" \
    --argjson days_since "$days_since" \
    --argjson recent_reviews "${recent_reviews:-0}" \
    --argjson breadth "${breadth:-0}" \
    '{
       signals: {
         open_review_requests_total: $open_reviews,
         authored_open_prs_total: $authored_total,
         authored_open_drafts_total: $authored_drafts,
         assigned_issues_total: $assigned_issues,
         days_since_last_public_event: $days_since,
         recent_reviews_in_repo_45d: $recent_reviews,
         breadth_top_level_dirs_180d: $breadth,
         familiarity: null
       }
     }')"
  printf '%s' "$base" | cache_put "signals/${REPO_SLUG}-${login}.json"

  jq --arg login "$login" --argjson f "$familiarity" \
     '.login = $login | .signals.familiarity = $f' <<<"$base" >"$out"
}

# Serialize the outer loop  -  see earlier commit for why (nested & + wait races
# on file-close visibility without bash -x's I/O serialization).
i=0
while IFS= read -r login; do
  [ -z "$login" ] && continue
  i=$((i+1))
  collect_signals "$login" "$TMPDIR/cand_$i.json"
done <"$TMPDIR/candidates.txt"

CANDIDATES_JSON="$(find "$TMPDIR" -maxdepth 1 -name 'cand_*.json' -print0 2>/dev/null \
  | xargs -0 -I {} cat {} 2>/dev/null \
  | jq -s '.' 2>/dev/null || echo '[]')"
[ -n "$CANDIDATES_JSON" ] || CANDIDATES_JSON='[]'

GH_AUTH_HINT=""
if [ "$(jq 'length' <<<"$CANDIDATES_JSON")" = "0" ]; then
  GH_AUTH_HINT="no candidates resolved  -  check 'gh auth status' and that this repo has merge history"
fi

jq -n \
  --arg mode "$MODE" \
  --arg name_with_owner "$NAME_WITH_OWNER" \
  --arg default_branch "$DEFAULT_BRANCH" \
  --argjson pr "$PR_JSON" \
  --argjson candidates "$CANDIDATES_JSON" \
  --arg fetch_warn "$FETCH_WARN" \
  --arg auth_hint "$GH_AUTH_HINT" \
  '{
     mode: $mode,
     repo: { nameWithOwner: $name_with_owner, defaultBranch: $default_branch },
     pr: (
       if $pr == null then null
       else {
         number: $pr.number,
         title: $pr.title,
         headRefName: $pr.headRefName,
         baseRefName: $pr.baseRefName,
         author: ($pr.author.login // null),
         changed_files: [$pr.files[].path]
       }
       end
     ),
     candidates: $candidates,
     fetch_warn: (if $fetch_warn == "" then null else $fetch_warn end),
     auth_hint: (if $auth_hint == "" then null else $auth_hint end)
   }'
