---
name: gitnexus-impact-analysis
description: Analyze blast radius before making code changes
---

# Impact Analysis with GitNexus

## Prerequisites (do these first, every session)

1. **Check the indexed repos.** Call `mcp__gitnexus__list_repos` first and pick
   the target repo. In multi-repo sessions, pass `repo` on every GitNexus call.
2. **Check freshness.** Compare the selected repo's indexed commit or
   `indexedAt` with `git log -1 --format=%H`. If the index is stale, run
   `gitnexus analyze --skip-agents-md`, re-check freshness, and
   only continue once the graph is current. If GitNexus is unavailable, report
   that as a blocker instead of silently substituting grep.
3. **Call the exposed MCP tools by their actual names**, such as
   `mcp__gitnexus__impact`, `mcp__gitnexus__context`, and
   `mcp__gitnexus__detect_changes`. The shorter names below are conceptual
   shorthand.

## When to Use
- "Is it safe to change this function?"
- "What will break if I modify X?"
- "Show me the blast radius"
- "Who uses this code?"
- Before making non-trivial code changes
- Before committing - to understand what your changes affect

## Workflow

```
1. mcp__gitnexus__impact({target: "X", direction: "upstream"})  → What depends on this
2. mcp__gitnexus__detect_changes()                              → Map current git changes to affected flows
3. Assess risk and report to user
```

> If the index is stale, run `gitnexus analyze --skip-agents-md`.

## Checklist

```
- [ ] mcp__gitnexus__impact({target, direction: "upstream"}) to find dependents
- [ ] Review d=1 items first (these WILL BREAK)
- [ ] Check high-confidence (>0.8) dependencies
- [ ] mcp__gitnexus__detect_changes() for pre-commit check
- [ ] Assess risk level and report to user
```

## Understanding Output

| Depth | Risk Level | Meaning |
|-------|-----------|---------|
| d=1 | **WILL BREAK** | Direct callers/importers |
| d=2 | LIKELY AFFECTED | Indirect dependencies |
| d=3 | MAY NEED TESTING | Transitive effects |

## Risk Assessment

| Affected | Risk |
|----------|------|
| <5 symbols, few processes | LOW |
| 5-15 symbols, 2-5 processes | MEDIUM |
| >15 symbols or many processes | HIGH |
| Critical path (auth, payments) | CRITICAL |

## Tools

**mcp__gitnexus__impact** - the primary tool for symbol blast radius:
```
mcp__gitnexus__impact({
  target: "validateUser",
  direction: "upstream",
  minConfidence: 0.8,
  maxDepth: 3
})

→ d=1 (WILL BREAK):
  - loginHandler (src/auth/login.ts:42) [CALLS, 100%]
  - apiMiddleware (src/api/middleware.ts:15) [CALLS, 100%]

→ d=2 (LIKELY AFFECTED):
  - authRouter (src/routes/auth.ts:22) [CALLS, 95%]
```

**mcp__gitnexus__detect_changes** - git-diff based impact analysis:
```
mcp__gitnexus__detect_changes({scope: "staged"})

→ Changed: 5 symbols in 3 files
→ Affected: LoginFlow, TokenRefresh, APIMiddlewarePipeline
→ Risk: MEDIUM
```

## Example: "What breaks if I change validateUser?"

```
1. mcp__gitnexus__impact({target: "validateUser", direction: "upstream"})
   → d=1: loginHandler, apiMiddleware (WILL BREAK)
   → d=2: authRouter, sessionManager (LIKELY AFFECTED)

2. Risk: 2 direct callers, 2 processes = MEDIUM
```
