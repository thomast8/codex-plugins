# Codex Surface Inventory

Snapshot date: 2026-05-19.

This inventory describes what belongs in this public marketplace repo and what remains local/private. It is intentionally public-safe and omits machine paths, tokens, logs, sessions, project memories, and private runtime state.

## Canonical Personal Marketplace

- Marketplace repo: `thomast8/codex-plugins`
- Marketplace entrypoint: `.agents/plugins/marketplace.json`
- Install and refresh path: Codex marketplace installation for `codex-plugins`

## Personal Plugins

These are bundled in this repo under `plugins/` and listed in `.agents/plugins/marketplace.json`.
Each plugin also carries `plugin.descriptor.json`, a public-safe explanatory manifest that describes purpose, use cases, exposed surfaces, safety model, excluded state, and install notes.

- `azure-devops`: Azure Boards and Azure Repos MCP integration with preview-first writes.
- `github-local-ops`: local GitHub workflows backed by `gh` and `git`.
- `thomas-codex-workflows`: personal Codex workflow hooks for repo safety, GitNexus upkeep, and worktree lifecycle setup.
- `thomas-codex-skills`: active personal skills packaged as a single marketplace plugin.

## Personal Skills

These are installed through the `thomas-codex-skills` plugin and executed from Codex's plugin cache after marketplace refresh. The canonical active skill source lives under `plugins/thomas-codex-skills/skills/`.

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
4. Refresh or reinstall the `codex-plugins` marketplace through Codex, then restart or reload Codex if needed.

Use the Codex marketplace UI or plugin tooling to install `Thomas Codex Skills`. Standalone skill linking is no longer supported.
