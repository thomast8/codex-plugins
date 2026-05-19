# Cross-Model Evidence Collection Protocol

Reference document for merging review findings from multiple review lanes into a unified report.

## Finding Schema

Each finding must be normalized to:

- **file**: Path relative to repo root
- **line**: Line number or range, such as `42` or `42-48`
- **severity**: `critical`, `important`, or `suggestion`
- **category**: `bugs-and-conventions`, `error-handling`, `simplification`, `comments`, `test-coverage`, or `type-design`
- **source**: The review lane or agent family that reported the finding
- **agent**: The specific agent name when available
- **description**: What the issue is and why it matters
- **fix**: Concrete recommendation

## Deduplication Rules

Match findings across lanes using fuzzy semantic judgment, not exact equality:

1. Same file.
2. Overlapping lines, usually within about five lines.
3. Same concern category.

If all three match, merge into a single finding tagged `confirmed by multiple lanes`.

## Action Matrix

| Scenario | Action |
|---|---|
| Multiple lanes agree, critical or important | Fix immediately |
| Multiple lanes agree, suggestion | Fix when low risk |
| One lane flags critical, others silent | Present to the user with the evidence |
| One lane flags important, others silent | Present to the user unless the fix is obvious and low risk |
| One lane flags suggestion, others silent | Fix when low risk |
| Direct conflict | Present both recommendations and the tradeoff |

## Unified Output Format

Present findings grouped by resolution status:

```text
Review Summary

Confirmed by multiple lanes
- file:line - [category] description

Single-source
- file:line - [category] [source] description

Conflicts
- file:line - [category]
  Lane A: recommendation A
  Lane B: recommendation B

Strengths
- Positive observations noted by reviewers

Agent failures
- agent-name: timed out or failed
```

Positive observations and strengths reported by any lane should be preserved in the report. They do not go through the deduplication or action matrix.

## Suppression Scan

After processing all findings, scan the full diff once for lint/type suppressions:

- `# noqa`
- `# type: ignore`
- `# nosec`
- `# pragma: no cover`
- `// @ts-ignore`
- `// eslint-disable`

Each suppression should be removed by fixing the underlying issue. Only keep a suppression if the tool is genuinely wrong and there is no reasonable fix.
