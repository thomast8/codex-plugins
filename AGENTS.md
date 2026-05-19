# Agent Guidance

This file is a public-safe operating guide for working in this marketplace repo. It intentionally omits private project memory, account mappings, local paths, approval history, logs, sessions, and secrets.

## Scope

- Keep this repository focused on reusable Codex plugins, skills, MCP declarations, hooks, bootstrap scripts, and public-safe documentation.
- Do not vendor official plugin caches, runtime caches, auth files, logs, sessions, shell snapshots, project memories, local databases, or machine-specific state.
- Prefer portable paths and environment overrides. Do not hard-code personal home-directory paths.

## Writing Style

- Do not use em dashes. Use a regular hyphen, comma, semicolon, or rewrite.
- Keep docs concise and implementation-oriented.
- Public documentation should explain reusable behavior, not private workflow history.

## Commands

- Run scripts and monitor output without asking for confirmation when they are safe and scoped.
- Never delete files without explicit approval. If cleanup is needed, move files aside or leave them untracked and explain.
- Prefer simple direct commands over shell wrappers so approvals and logs remain understandable.
- Use `rg` for search and `git diff`, `git status`, and targeted file reads before editing.

## Git

- Fetch before GitHub or PR work so refs are fresh.
- Verify the repo-local commit identity before the first commit in a session.
- Use Conventional Commit prefixes such as `feat:`, `fix:`, `docs:`, `test:`, `chore:`, or `refactor:`.
- Do not open editors for commits or rebases. Use non-interactive commit and rebase commands.
- Do not force-push unless the branch rewrite is intentional and the remote/local divergence has been inspected.

## Development

- Keep changes focused and avoid sweeping unrelated refactors.
- For behavior changes, prefer tests first or add focused tests alongside the implementation.
- Find root cause before fixing. If several attempts fail, stop and reassess the design.
- Before claiming done, exercise the real code path as closely as possible, not only mocked fixtures.
- For public repos, scan for secrets, private org details, local paths, logs, sessions, caches, project memories, and generated runtime state before committing.

## Marketplace Work

- Keep `.agents/plugins/marketplace.json` as the marketplace entrypoint.
- Plugin packages live under `plugins/<plugin-name>/` and must include `.codex-plugin/plugin.json`.
- Top-level personal skills live under `skills/<skill-name>/` so their names remain stable when installed.
- Archived skills may live under `archived-skills/`, but they are not installed by default.
- Installer changes should support temp-root tests and avoid depending on iCloud or any single machine layout.

## Validation

- Run manifest, installer, hook, unit, and public-safety checks before pushing.
- If credentials or external services are unavailable, say exactly what could not be exercised and run the closest real-code smoke test.
