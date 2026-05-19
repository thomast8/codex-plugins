---
name: gitnexus-exploring
description: Navigate unfamiliar code using GitNexus knowledge graph
---

# Exploring Codebases with GitNexus

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
   `mcp__gitnexus__impact`. The shorter names below are conceptual shorthand.

## When to Use
- "How does authentication work?"
- "What's the project structure?"
- "Show me the main components"
- "Where is the database logic?"
- Understanding code you haven't seen before

## Workflow

```
1. Check GitNexus freshness with `mcp__gitnexus__list_repos`
2. mcp__gitnexus__query({query: "<what you want to understand>"})
3. mcp__gitnexus__context({name: "<symbol>"})
4. mcp__gitnexus__impact({target: "<symbol>", direction: "upstream"}) if needed
```

> If the index is stale, run `gitnexus analyze --skip-agents-md`.

## Checklist

```
- [ ] Check freshness with `mcp__gitnexus__list_repos`
- [ ] mcp__gitnexus__query for the concept you want to understand
- [ ] Review returned processes (execution flows)
- [ ] mcp__gitnexus__context on key symbols for callers/callees
- [ ] Read source files for implementation details
```

## Resources

| Resource | What you get |
|----------|-------------|
| `gitnexus://repo/{name}/context` | Stats, staleness warning (~150 tokens) |
| `gitnexus://repo/{name}/clusters` | All functional areas with cohesion scores (~300 tokens) |
| `gitnexus://repo/{name}/cluster/{name}` | Area members with file paths (~500 tokens) |
| `gitnexus://repo/{name}/process/{name}` | Step-by-step execution trace (~200 tokens) |

## Tools

**mcp__gitnexus__query** - find execution flows related to a concept:
```
mcp__gitnexus__query({query: "payment processing"})
→ Processes: CheckoutFlow, RefundFlow, WebhookHandler
→ Symbols grouped by flow with file locations
```

**mcp__gitnexus__context** - 360-degree view of a symbol:
```
mcp__gitnexus__context({name: "validateUser"})
→ Incoming calls: loginHandler, apiMiddleware
→ Outgoing calls: checkToken, getUserById
→ Processes: LoginFlow (step 2/5), TokenRefresh (step 1/3)
```

## Example: "How does payment processing work?"

```
1. Check freshness with `mcp__gitnexus__list_repos`
2. mcp__gitnexus__query({query: "payment processing"})
   → CheckoutFlow: processPayment → validateCard → chargeStripe
   → RefundFlow: initiateRefund → calculateRefund → processRefund
3. mcp__gitnexus__context({name: "processPayment"})
   → Incoming: checkoutHandler, webhookHandler
   → Outgoing: validateCard, chargeStripe, saveTransaction
4. Read src/payments/processor.ts for implementation details
```
