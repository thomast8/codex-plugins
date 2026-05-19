#!/bin/bash
# Block direct commits and dangerous operations on main branch.
# Allow: tag pushes, pushing other branches, pulling/fast-forwarding main.
set -uo pipefail

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')

HAS_SEPARATOR=0
if printf '%s' "$CMD" | grep -qE '(&&|\|\||[;|])'; then
  HAS_SEPARATOR=1
fi

ALLOW_MAIN=0
if [ "$HAS_SEPARATOR" -eq 0 ]; then
  if printf '%s' "$CMD" | grep -qE '^[[:space:]]*(env[[:space:]]+)?CODEX_ALLOW_MAIN=1[[:space:]]+git[[:space:]]'; then
    ALLOW_MAIN=1
  fi
fi

normalize_tokens() {
  local input="$CMD"
  local token=""
  local quote=""
  local ch=""
  local next=""
  local i=0
  local len=${#input}
  TOKENS=()

  for ((i = 0; i < len; i++)); do
    ch="${input:$i:1}"
    next=""
    if [ $((i + 1)) -lt "$len" ]; then
      next="${input:$((i + 1)):1}"
    fi

    if [ -n "$quote" ]; then
      if [ "$ch" = "$quote" ]; then
        quote=""
      elif [ "$ch" = "\\" ] && [ -n "$next" ]; then
        token="${token}${next}"
        i=$((i + 1))
      else
        token="${token}${ch}"
      fi
      continue
    fi

    if [[ "$ch" =~ [[:space:]] ]]; then
      if [ -n "$token" ]; then
        TOKENS+=("$token")
        token=""
      fi
      continue
    fi

    case "$ch" in
      "'"|'"')
        quote="$ch"
        ;;
      "\\")
        if [ -n "$next" ]; then
          token="${token}${next}"
          i=$((i + 1))
        else
          token="${token}${ch}"
        fi
        ;;
      ";")
        [ -n "$token" ] && TOKENS+=("$token")
        token=""
        TOKENS+=(";")
        ;;
      "|")
        [ -n "$token" ] && TOKENS+=("$token")
        token=""
        if [ "$next" = "|" ]; then
          TOKENS+=("||")
          i=$((i + 1))
        else
          TOKENS+=("|")
        fi
        ;;
      "&")
        if [ "$next" = "&" ]; then
          [ -n "$token" ] && TOKENS+=("$token")
          token=""
          TOKENS+=("&&")
          i=$((i + 1))
        else
          token="${token}${ch}"
        fi
        ;;
      *)
        token="${token}${ch}"
        ;;
    esac
  done

  [ -n "$token" ] && TOKENS+=("$token")
}

resolve_dir() {
  local base="$1"
  local target="$2"
  if [ -z "$target" ]; then
    printf '%s\n' "$base"
    return 0
  fi
  if [[ "$target" = /* ]]; then
    (cd "$target" 2>/dev/null && pwd -P) || printf '%s\n' "$target"
    return 0
  fi
  (cd "$base" 2>/dev/null && cd "$target" 2>/dev/null && pwd -P) || printf '%s\n' "$base/$target"
}

repo_top_level() {
  local repo_dir="$1"
  git -C "$repo_dir" rev-parse --show-toplevel 2>/dev/null || true
}

repo_branch() {
  local repo_dir="$1"
  git -C "$repo_dir" branch --show-current 2>/dev/null || true
}

repo_allowed() {
  local repo_dir="$1"
  local allowlist="$HOME/.Codex/main-guard-allowlist"
  local top_level=""
  [ -f "$allowlist" ] || return 1
  top_level=$(repo_top_level "$repo_dir")
  [ -n "$top_level" ] || return 1
  grep -v '^[[:space:]]*#' "$allowlist" \
    | grep -v '^[[:space:]]*$' \
    | grep -Fxq "$top_level"
}

deny() {
  local message="$1"
  local repo_dir="${2:-$PWD}"
  local top_level_hint=""
  if [ "$ALLOW_MAIN" -eq 1 ]; then
    exit 0
  fi
  top_level_hint=$(repo_top_level "$repo_dir")
  [ -n "$top_level_hint" ] || top_level_hint="<repo toplevel>"
  printf 'Blocked: %s\n' "$message" >&2
  printf '\n' >&2
  printf 'Two override options:\n' >&2
  printf '  1. One-off:    prefix the command with CODEX_ALLOW_MAIN=1\n' >&2
  printf '  2. Allowlist:  append "%s" to ~/.Codex/main-guard-allowlist\n' >&2 "$top_level_hint"
  printf '                 (use this for solo/plugin repos where main IS the trunk).\n' >&2
  printf '\n' >&2
  printf 'Reminder to the assistant: do not silently retry with the env-var override.\n' >&2
  printf 'Surface both options to the user via ask the user in chat and act on their choice.\n' >&2
  exit 2
}

is_tag_ref() {
  local repo_dir="$1"
  local ref="${2#+}"
  local source="$ref"
  local dest=""
  if [[ "$ref" == *:* ]]; then
    source="${ref%%:*}"
    dest="${ref#*:}"
  fi
  case "$source" in
    refs/tags/*) return 0 ;;
  esac
  case "$dest" in
    refs/tags/*) return 0 ;;
  esac
  if [[ "$ref" != *:* ]] && git -C "$repo_dir" show-ref --verify --quiet "refs/tags/${source}"; then
    return 0
  fi
  return 1
}

ref_targets_main() {
  local ref="${1#+}"
  local is_main="$2"
  local source="$ref"
  local dest="$ref"
  if [[ "$ref" == *:* ]]; then
    source="${ref%%:*}"
    dest="${ref#*:}"
  fi
  case "$dest" in
    main|refs/heads/main) return 0 ;;
  esac
  if [[ "$ref" != *:* ]]; then
    case "$source" in
      main|refs/heads/main) return 0 ;;
      HEAD)
        [ "$is_main" -eq 1 ] && return 0
        ;;
    esac
  fi
  return 1
}

handle_push_tokens() {
  local repo_dir="$1"
  local is_main="$2"
  local start_index="$3"
  local k=0
  local raw_token=""
  local token=""
  local remote_seen=0
  local tag_option=0
  local tag_keyword=0
  local all_tag_refs=1
  local refspec=""
  REFSPECS=()

  for ((k = start_index; k < ${#TOKENS[@]}; k++)); do
    raw_token="${TOKENS[$k]}"
    token="${raw_token%;}"
    case "$token" in
      ""|"&&"|"||"|";"|\|)
        break
        ;;
      --all|--mirror)
        deny "do not push directly to main (--all/--mirror can publish main)" "$repo_dir"
        ;;
      --tags)
        tag_option=1
        continue
        ;;
      --*)
        continue
        ;;
      -*)
        continue
        ;;
      tag)
        tag_keyword=1
        continue
        ;;
    esac

    if [ "$tag_keyword" -eq 1 ]; then
      REFSPECS+=("refs/tags/${token}")
      tag_keyword=0
      continue
    fi

    if [ "$remote_seen" -eq 0 ]; then
      remote_seen=1
      continue
    fi
    REFSPECS+=("$token")
  done

  if [ "${#REFSPECS[@]}" -eq 0 ]; then
    if [ "$tag_option" -eq 1 ]; then
      return 0
    fi
    if [ "$is_main" -eq 1 ]; then
      deny "do not push directly to main (current branch is main; bare push would publish it)" "$repo_dir"
    fi
    return 0
  fi

  for refspec in "${REFSPECS[@]}"; do
    if ref_targets_main "$refspec" "$is_main"; then
      deny "do not push directly to main (refspec targets main)" "$repo_dir"
    fi
    if ! is_tag_ref "$repo_dir" "$refspec"; then
      all_tag_refs=0
    fi
  done

  [ "$all_tag_refs" -eq 1 ] && return 0
  return 0
}

handle_git_command() {
  local git_index="$1"
  local repo_dir="$PWD"
  local j=$((git_index + 1))
  local verb=""
  local branch=""
  local is_main=0
  local option=""

  while [ "$j" -lt "${#TOKENS[@]}" ]; do
    option="${TOKENS[$j]}"
    case "$option" in
      -C)
        if [ $((j + 1)) -ge "${#TOKENS[@]}" ]; then
          return 0
        fi
        repo_dir=$(resolve_dir "$repo_dir" "${TOKENS[$((j + 1))]}")
        j=$((j + 2))
        ;;
      -c|--git-dir|--work-tree|--namespace)
        j=$((j + 2))
        ;;
      --git-dir=*|--work-tree=*|--namespace=*|-c*)
        j=$((j + 1))
        ;;
      -*)
        j=$((j + 1))
        ;;
      *)
        verb="$option"
        break
        ;;
    esac
  done

  [ -n "$verb" ] || return 0

  branch=$(repo_branch "$repo_dir")
  [ "$branch" = "main" ] && is_main=1

  if repo_allowed "$repo_dir"; then
    return 0
  fi

  case "$verb" in
    commit)
      [ "$is_main" -eq 1 ] && deny "do not commit directly to main" "$repo_dir"
      ;;
    merge)
      if [ "$is_main" -eq 1 ]; then
        if [ $((j + 1)) -lt "${#TOKENS[@]}" ] && [ "${TOKENS[$((j + 1))]}" = "origin/main" ]; then
          return 0
        fi
        deny "do not merge into main locally" "$repo_dir"
      fi
      ;;
    pull)
      if [ "$is_main" -eq 1 ]; then
        if [ $((j + 2)) -lt "${#TOKENS[@]}" ] \
          && [ "${TOKENS[$((j + 1))]}" = "origin" ] \
          && [ "${TOKENS[$((j + 2))]}" = "main" ]; then
          return 0
        fi
        deny "do not pull into main except from origin main" "$repo_dir"
      fi
      ;;
    push)
      handle_push_tokens "$repo_dir" "$is_main" $((j + 1))
      ;;
  esac
}

normalize_tokens
for ((i = 0; i < ${#TOKENS[@]}; i++)); do
  [ "${TOKENS[$i]}" = "git" ] || continue
  handle_git_command "$i"
done

exit 0
