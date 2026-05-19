---
name: gitnexus-debugging
description: Trace bugs through call chains using knowledge graph
---

# Debugging with GitNexus

## Prerequisites (do these first, every session)

1. **Check the indexed repos.** Call `mcp__gitnexus__list_repos` first and pick
   the target repo. In multi-repo sessions, pass `repo` on every GitNexus call.
2. **Check freshness.** Compare the selected repo's indexed commit or
   `indexedAt` with `git log -1 --format=%H`. If the index is stale, run
   `gitnexus analyze --skip-agents-md`, re-check freshness, and
   only continue once the graph is current. If GitNexus is unavailable, report
   that as a blocker instead of silently substituting grep.
3. **Call the exposed MCP tools by their actual names**, such as
   `mcp__gitnexus__query`, `mcp__gitnexus__context`, and
   `mcp__gitnexus__cypher`. The shorter names below are conceptual shorthand.

## When to Use
- "Why is this function failing?"
- "Trace where this error comes from"
- "Who calls this method?"
- "This endpoint returns 500"
- Investigating bugs, errors, or unexpected behavior

## Workflow

```
1. mcp__gitnexus__query({query: "<error or symptom>"})       → Find related execution flows
2. mcp__gitnexus__context({name: "<suspect>"})               → See callers/callees/processes
3. mcp__gitnexus__cypher({query: "MATCH path..."})           → Custom traces if needed
```

> If the index is stale, run `gitnexus analyze --skip-agents-md`.

## Checklist

```
- [ ] Understand the symptom (error message, unexpected behavior)
- [ ] mcp__gitnexus__query for error text or related code
- [ ] Identify the suspect function from returned processes
- [ ] mcp__gitnexus__context to see callers and callees
- [ ] mcp__gitnexus__cypher for custom call chain traces if needed
- [ ] Read source files to confirm root cause
```

## Debugging Patterns

| Symptom | GitNexus Approach |
|---------|-------------------|
| Error message | `mcp__gitnexus__query` for error text, then `mcp__gitnexus__context` on throw sites |
| Wrong return value | `mcp__gitnexus__context` on the function, then trace callees for data flow |
| Intermittent failure | `mcp__gitnexus__context` to look for external calls and async dependencies |
| Performance issue | `mcp__gitnexus__context` to find symbols with many callers (hot paths) |
| Recent regression | `mcp__gitnexus__detect_changes` to see what your changes affect |

## Tools

**mcp__gitnexus__query** - find code related to error:
```
mcp__gitnexus__query({query: "payment validation error"})
→ Processes: CheckoutFlow, ErrorHandling
→ Symbols: validatePayment, handlePaymentError, PaymentException
```

**mcp__gitnexus__context** - full context for a suspect:
```
mcp__gitnexus__context({name: "validatePayment"})
→ Incoming calls: processCheckout, webhookHandler
→ Outgoing calls: verifyCard, fetchRates (external API!)
→ Processes: CheckoutFlow (step 3/7)
```

**mcp__gitnexus__cypher** - custom call chain traces:
```cypher
MATCH path = (a)-[:CodeRelation {type: 'CALLS'}*1..2]->(b:Function {name: "validatePayment"})
RETURN [n IN nodes(path) | n.name] AS chain
```

## Example: "Payment endpoint returns 500 intermittently"

```
1. mcp__gitnexus__query({query: "payment error handling"})
   → Processes: CheckoutFlow, ErrorHandling
   → Symbols: validatePayment, handlePaymentError

2. mcp__gitnexus__context({name: "validatePayment"})
   → Outgoing calls: verifyCard, fetchRates (external API!)

3. Root cause: fetchRates calls external API without proper timeout
```
