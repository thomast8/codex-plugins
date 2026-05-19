#!/usr/bin/env bash
# Auto-switch gh CLI account based on the GitHub repo targeted by gh or git push.
set -u

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

tokenize_command() {
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

tokenize_command

owner_from_repo_arg() {
    local value="$1"
    local repo_path="$value"
    case "$repo_path" in
        https://github.com/*/*)
            repo_path="${repo_path#https://github.com/}"
            ;;
        http://github.com/*/*)
            repo_path="${repo_path#http://github.com/}"
            ;;
        git@github.com:*/*)
            repo_path="${repo_path#git@github.com:}"
            ;;
        ssh://git@github.com/*/*)
            repo_path="${repo_path#ssh://git@github.com/}"
            ;;
    esac
    repo_path="${repo_path%.git}"
    printf '%s' "${repo_path%%/*}"
}

valid_owner() {
    printf '%s' "$1" | grep -qE '^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$'
}

resolve_dir() {
    local base="$1"
    local target="$2"
    if [[ "$target" = /* ]]; then
        (cd "$target" 2>/dev/null && pwd -P) || printf '%s\n' "$target"
        return 0
    fi
    (cd "$base" 2>/dev/null && cd "$target" 2>/dev/null && pwd -P) || printf '%s\n' "$base/$target"
}

owner_from_remote() {
    local repo_dir="$1"
    local remote_name="${2:-origin}"
    local remote_url=""
    remote_url=$(git -C "$repo_dir" remote get-url "$remote_name" 2>/dev/null || true)
    case "$remote_url" in
        https://github.com/*/*|http://github.com/*/*|git@github.com:*/*|ssh://git@github.com/*/*)
            owner_from_repo_arg "$remote_url"
            ;;
    esac
}

is_separator() {
    case "$1" in
        "&&"|"||"|";"|\|) return 0 ;;
    esac
    return 1
}

find_explicit_gh_owner() {
    local i=0
    local j=0
    local candidate=""
    for ((i = 0; i < ${#TOKENS[@]}; i++)); do
        [ "${TOKENS[$i]}" = "gh" ] || continue
        for ((j = i + 1; j < ${#TOKENS[@]}; j++)); do
            is_separator "${TOKENS[$j]}" && break
            case "${TOKENS[$j]}" in
                -R|--repo)
                    if [ $((j + 1)) -lt "${#TOKENS[@]}" ]; then
                        candidate=$(owner_from_repo_arg "${TOKENS[$((j + 1))]}")
                        valid_owner "$candidate" && printf '%s\n' "$candidate" && return 0
                    fi
                    ;;
                --repo=*)
                    candidate=$(owner_from_repo_arg "${TOKENS[$j]#--repo=}")
                    valid_owner "$candidate" && printf '%s\n' "$candidate" && return 0
                    ;;
            esac
        done
    done

    for ((i = 0; i < ${#TOKENS[@]}; i++)); do
        [ "${TOKENS[$i]}" = "gh" ] || continue
        if [ $((i + 1)) -lt "${#TOKENS[@]}" ] && [ "${TOKENS[$((i + 1))]}" = "repo" ]; then
            for ((j = i + 2; j < ${#TOKENS[@]}; j++)); do
                is_separator "${TOKENS[$j]}" && break
                case "${TOKENS[$j]}" in
                    -*)
                        continue
                        ;;
                    */*)
                        candidate=$(owner_from_repo_arg "${TOKENS[$j]}")
                        valid_owner "$candidate" && printf '%s\n' "$candidate" && return 0
                        ;;
                esac
            done
        fi
    done
    return 1
}

find_git_push_owner() {
    local i=0
    local j=0
    local repo_dir="$PWD"
    local remote_name="origin"
    for ((i = 0; i < ${#TOKENS[@]}; i++)); do
        [ "${TOKENS[$i]}" = "git" ] || continue
        repo_dir="$PWD"
        remote_name="origin"
        j=$((i + 1))
        while [ "$j" -lt "${#TOKENS[@]}" ]; do
            case "${TOKENS[$j]}" in
                -C)
                    if [ $((j + 1)) -lt "${#TOKENS[@]}" ]; then
                        repo_dir=$(resolve_dir "$repo_dir" "${TOKENS[$((j + 1))]}")
                    fi
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
                push)
                    j=$((j + 1))
                    while [ "$j" -lt "${#TOKENS[@]}" ]; do
                        is_separator "${TOKENS[$j]}" && break
                        case "${TOKENS[$j]}" in
                            --*|-*)
                                j=$((j + 1))
                                continue
                                ;;
                        esac
                        remote_name="${TOKENS[$j]}"
                        break
                    done
                    case "$remote_name" in
                        https://github.com/*/*|http://github.com/*/*|git@github.com:*/*|ssh://git@github.com/*/*)
                            owner_from_repo_arg "$remote_name"
                            return 0
                            ;;
                    esac
                    owner_from_remote "$repo_dir" "$remote_name"
                    return 0
                    ;;
                *)
                    break
                    ;;
            esac
        done
    done
    return 1
}

has_gh=0
has_git_push=0
for ((i = 0; i < ${#TOKENS[@]}; i++)); do
    [ "${TOKENS[$i]}" = "gh" ] && has_gh=1
    if [ "${TOKENS[$i]}" = "git" ]; then
        for ((j = i + 1; j < ${#TOKENS[@]}; j++)); do
            is_separator "${TOKENS[$j]}" && break
            if [ "${TOKENS[$j]}" = "push" ]; then
                has_git_push=1
                break
            fi
        done
    fi
done

if [ "$has_gh" -eq 0 ] && [ "$has_git_push" -eq 0 ]; then
    exit 0
fi

owner=$(find_explicit_gh_owner || true)

if [ -z "$owner" ] && [ "$has_git_push" -eq 1 ]; then
    owner=$(find_git_push_owner || true)
fi

if [ -z "$owner" ]; then
    for ((i = 0; i < ${#TOKENS[@]}; i++)); do
        case "${TOKENS[$i]}" in
            GH_REPO=*)
                owner=$(owner_from_repo_arg "${TOKENS[$i]#GH_REPO=}")
                ;;
        esac
        [ -n "$owner" ] && break
    done
fi

if [ -z "$owner" ] && [ -n "${GH_REPO:-}" ]; then
    owner=$(owner_from_repo_arg "$GH_REPO")
fi

if [ -z "$owner" ]; then
    owner=$(owner_from_remote "$PWD" "origin")
fi

if ! valid_owner "$owner"; then
    if [ "$has_gh" -eq 1 ]; then
        echo "gh: could not resolve GitHub owner for account switch" >&2
        exit 2
    fi
    exit 0
fi

if [ "$owner" = "kyndryl-agentic-ai" ]; then
    target="thomas-tiotto_kyndryl"
else
    target="thomast8"
fi

current=$(gh auth status 2>&1 | grep "Active account: true" -B3 | grep "account " | sed -E 's/.*account ([^ ]+).*/\1/')
if [ "$current" = "$target" ]; then
    exit 0
fi

if gh auth switch --user "$target" >/dev/null 2>&1; then
    echo "gh: switched to $target (repo owner: $owner)"
    exit 0
fi

echo "gh: failed to switch to $target for repo owner $owner" >&2
exit 2
