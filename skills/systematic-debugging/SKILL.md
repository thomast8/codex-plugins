---
name: systematic-debugging
description: "Find root cause before fixing. Prevents thrash when debugging."
---

# Systematic Debugging

**Core rule:** No fixes without root cause. Symptom fixes are failure.

## Process

1. **Investigate**: Read the full error. Reproduce consistently. Check recent changes (`git log`, `git diff`). For multi-component systems, log data at each boundary to find where it breaks.
2. **Compare**: Find working similar code in the codebase. List every difference.
3. **Hypothesize**: "X is the root cause because Y." Test the smallest possible change.
4. **Fix one thing**: One change at a time. No "while I'm here" improvements.

## Three-failure rule

If three fix attempts fail, **stop and question the architecture**. Don't pile on a fourth fix. Each fix revealing a new problem in a different place = architectural smell.

## Red flags (stop and restart from step 1)

- "Quick fix for now"
- "Just try X and see"
- "I don't fully understand but this might work"
- "One more attempt" (after 2+ failures)
- Multiple changes at once to narrow the cause

When time-pressured, systematic debugging is **faster** than guess-and-check.
