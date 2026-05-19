# Codex Surface Inventory

Snapshot date: 2026-05-19.

This inventory describes what belongs in this public marketplace repo and what remains local/private. It is intentionally public-safe and omits machine paths, tokens, logs, sessions, project memories, and private runtime state.

## Canonical Personal Marketplace

- Marketplace repo: `thomast8/codex-plugins`
- Marketplace entrypoint: `.agents/plugins/marketplace.json`
- Install script: `scripts/install-local.mjs`

## Personal Plugins

These are bundled in this repo under `plugins/` and listed in `.agents/plugins/marketplace.json`.

- `azure-devops`: Azure Boards and Azure Repos MCP integration with preview-first writes.
- `github-local-ops`: local GitHub workflows backed by `gh` and `git`.
- `thomas-codex-workflows`: personal Codex workflow hooks for repo safety, GitNexus upkeep, auth switching, and worktree lifecycle setup.

## Standalone Personal Skills

These are installed as top-level skills so their names remain stable across machines.

- `find-reviewer`
- `frontend-design`
- `gitnexus-debugging`
- `gitnexus-exploring`
- `gitnexus-impact-analysis`
- `gitnexus-refactoring`
- `reconcile`
- `review-code`
- `review-thread-response`
- `systematic-debugging`
- `unworktree`
- `worktree`

Archived skills are kept under `archived-skills/` for recovery only and are not installed by default.

## Safe MCP Declarations

The bootstrap installer can upsert these global MCP server declarations:

- `gitnexus`: `gitnexus mcp`
- `mcp-debugger`: `npx -y @debugmcp/mcp-debugger`

## Official Or External Marketplaces

These are documented here but not vendored:

- OpenAI curated plugins, such as Build Web Apps, Codex Security, Outlook, SharePoint, and Teams.
- OpenAI primary runtime plugins, such as Documents, Presentations, and Spreadsheets.
- OpenAI bundled plugins, such as Browser.
- Third-party or official external marketplaces.

## Excluded Local State

Do not publish or vendor:

- `auth.json`, OAuth stores, PATs, API keys, `.env`, or keychain exports.
- Logs, sessions, archived sessions, shell snapshots, local databases, caches, and runtime state.
- Project memories and private project-specific guidance.
- Downloaded official plugin caches.
- `node_modules`, coverage output, non-bundled build output, and generated local manifests.
- Raw full-machine config snapshots.

## Restore Flow

1. Clone `https://github.com/thomast8/codex-plugins`.
2. Run `npm install`.
3. Run `npm run build`.
4. Run `node scripts/install-local.mjs`.
5. Restart or reload Codex.

Use `CODEX_CONFIG_FILE`, `CODEX_CONFIG_ROOT`, `CODEX_SKILLS_ROOT`, `CODEX_PLUGINS`, `CODEX_SKILLS`, and `CODEX_MCPS` for dry runs or partial installs.
