#!/usr/bin/env bash
# familiarity.sh  -  compute a candidate's commit familiarity with a PR's changed files.
# Usage: familiarity.sh <login> <file_authors_json>
#   <file_authors_json> is built by gather.sh in PR mode. Schema:
#     { "<file_path>": ["login1", "login2", "login1", ...], ... }
#   Each login appearance = one commit on that file. A login appearing in more
#   than one file's list = touched multiple files.
# Output: {"files_touched": N, "commits": N, "score": 0..100}
#
# The `score` is an F1-style aggregate over coverage + depth, normalized by the
# PR's total changed-file count (the number of keys in the input JSON). It
# collapses the two counts into one 0-100 number for table display.
#
# Pure jq  -  no gh calls.

set -uo pipefail

LOGIN="${1:-}"
AUTHORS_JSON="${2:-}"

if [ -z "$LOGIN" ] || [ ! -s "$AUTHORS_JSON" ]; then
  printf '{"files_touched":0,"commits":0,"score":0}\n'
  exit 0
fi

jq --arg l "$LOGIN" '
  (length) as $changed_files_count
  | (to_entries) as $entries
  | ([$entries[] | select(.value | any(. == $l))] | length) as $files_touched
  | ([$entries[] | .value[] | select(. == $l)] | length) as $commits
  | (if $changed_files_count > 0 then ($files_touched / $changed_files_count) else 0 end) as $coverage
  | (if $changed_files_count > 0 then ([1.0, ($commits / ($changed_files_count * 3))] | min) else 0 end) as $depth
  | (if ($coverage + $depth) > 0 then (2 * $coverage * $depth / ($coverage + $depth)) else 0 end) as $f1
  | {
      files_touched: $files_touched,
      commits: $commits,
      score: (($f1 * 100) | floor)
    }
' "$AUTHORS_JSON" 2>/dev/null || printf '{"files_touched":0,"commits":0,"score":0}\n'
