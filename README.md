# Codex Plugins Marketplace

Personal Codex marketplace repo for Thomas's plugins. It currently bundles Azure DevOps, GitHub Local Ops, Thomas Codex Workflows, and Thomas Codex Skills.

The marketplace root is `thomast8/codex-plugins`. The repo-level marketplace file at `.agents/plugins/marketplace.json` points Codex at plugin packages under `plugins/`.
Personal skills are installed through the `thomas-codex-skills` plugin and executed from Codex's plugin cache after the marketplace is refreshed.

Requires Node.js 22.13.0 or newer.

```text
.agents/plugins/marketplace.json
plugins/
  azure-devops/
    .codex-plugin/plugin.json
    plugin.descriptor.json
    .mcp.json
    .mcp.local.json
    assets/
    dist/index.bundle.js
    skills/
    src/
  github-local-ops/
    .codex-plugin/plugin.json
    plugin.descriptor.json
    .mcp.json
    assets/
    scripts/
    skills/
  thomas-codex-workflows/
    .codex-plugin/plugin.json
    plugin.descriptor.json
    hooks/
  thomas-codex-skills/
    .codex-plugin/plugin.json
    plugin.descriptor.json
    skills/
archived-skills/
docs/codex-surface-inventory.md
```

## Add To Codex

Add this repo as a Codex marketplace:

```text
https://github.com/thomast8/codex-plugins
```

Codex discovers the marketplace from `.agents/plugins/marketplace.json`; bundled plugin packages live under `plugins/`.

## Bundled Plugins

- `plugins/azure-devops`: Azure Boards and Azure Repos tools with local stdio support and hosted Microsoft Entra OAuth support.
- `plugins/github-local-ops`: local GitHub workflows for repos, PRs, issues, Actions, releases, and publishing, backed by the GitHub CLI and git.
- `plugins/thomas-codex-workflows`: personal repo-safety hooks for PR creation reminders, Warp CWD updates, and worktree lifecycle setup.
- `plugins/thomas-codex-skills`: active personal skills packaged as one marketplace plugin.

Each plugin includes `plugin.descriptor.json`, a public-safe explanatory manifest with the plugin's purpose, when to use it, exposed skills/MCP servers/hooks, safety model, excluded state, and install notes. `npm run verify:plugin-descriptors` checks that these descriptors match the official Codex `plugin.json` entrypoints.

## Personal Skills

Active personal skills are packaged directly in `plugins/thomas-codex-skills`, which Codex installs from the marketplace UI or local marketplace source. That plugin path is the canonical source for active skills.

Archived skills live under `archived-skills/` for recovery and are not installed by default. `npm run verify:skills` checks the active plugin skills and archived skill metadata.

See `docs/codex-surface-inventory.md` for the public-safe inventory of bundled plugins, active skills, and intentionally excluded local state.

## Azure DevOps Plugin

The Azure DevOps plugin connects Codex to Azure Boards work items and Azure Repos Git data through local stdio or a hosted Streamable HTTP MCP service with Microsoft Entra OAuth.

## Capabilities

- Search, read, create, update, and comment on Azure Boards work items.
- List Azure Repos repositories, refs, commits, items/files, and pull requests.
- Use Microsoft Entra OAuth as the primary hosted and local interactive auth path.
- Configure org, project, and repo allowlist as a secondary admin/debug step.
- Preview ticket writes by default. Write tools only call Azure DevOps when `apply: true` is passed.

## Hosted Deployment

The polished user experience is the hosted HTTP MCP path. Codex discovers the
OAuth metadata and opens the browser for Microsoft Entra sign-in when access is
needed. After Microsoft sign-in, the MCP OAuth flow resumes automatically and
issues a Codex MCP token. Organization, project, repository allowlist, and
connection testing remain available as a secondary admin/debug configuration
surface.

The checked-in plugin `.mcp.json` points at the local stdio server so local
marketplace installs expose tools immediately. Before publishing a hosted build,
generate the public HTTP MCP manifest from the canonical deployment URL:

```bash
PUBLIC_BASE_URL=https://your-host.example npm run generate:mcp
```

By default this writes `plugins/azure-devops/.mcp.hosted.json`, preserving the
local `.mcp.json`. Set `MCP_MANIFEST_PATH=plugins/azure-devops/.mcp.json` only
when preparing the hosted package artifact. Hosted manifests require HTTPS.

Required deployment environment:

- `PUBLIC_BASE_URL`: public origin for the hosted service.
- `MICROSOFT_ENTRA_CLIENT_ID`: app registration client ID.
- `MICROSOFT_ENTRA_CLIENT_SECRET`: app registration client secret.
- `MICROSOFT_ENTRA_TENANT`: optional, defaults to `organizations`.
- `SESSION_SECRET`: reserved for session hardening.
- `TOKEN_ENCRYPTION_KEY`: 32-byte key as base64, hex, or utf8.
- `SQLITE_PATH`: optional SQLite path, defaults to `~/.codex-azure-devops-plugin/remote.sqlite`.
- `PORT`: optional HTTP port, defaults to `8787`.

Recommended deployment workspace defaults:

- `ADO_ORG_URL`: organization URL such as `https://dev.azure.com/example-org`.
- `ADO_PROJECT`: project name.
- `ADO_REPOSITORIES`: optional comma-separated repository allowlist.
- `ADO_REQUEST_TIMEOUT_MS`: optional request timeout.
- `ADO_MAX_PAGES`: optional paging limit.

The Microsoft Entra app should be granted delegated Azure DevOps permissions for the least-privilege scopes used by this plugin:

- `vso.work_write`
- `vso.code`
- `vso.project`

The hosted service requests the Azure DevOps resource `.default` scope, so the app registration controls the exact delegated permissions.

## Run Hosted Server

From the repo root:

```bash
npm install
npm run build
npm --workspace azure-devops-codex-plugin run serve
```

Open the service root or let Codex initiate the MCP OAuth flow:

```text
https://your-host.example/
```

Unauthenticated users are sent straight to Microsoft sign-in. When deployment
workspace defaults are set, authenticated users can use tools immediately.
The configuration page is only needed to review or override those defaults.

## Local Marketplace Development

The stdio MCP server is the default local development path. `plugins/azure-devops/.mcp.local.json` mirrors the default manifest and can be used when you want an explicit local fallback reference. The build creates `dist/index.bundle.js` so the cached local plugin can run without workspace-level `node_modules`.

To test or refresh this marketplace locally, build the plugin packages, publish the repo state you want Codex to install, then refresh the configured `codex-plugins` marketplace in Codex:

```bash
npm install
npm run build
codex plugin marketplace upgrade codex-plugins
```

The repo does not ship a config-mutating installer. Codex owns marketplace installation, enablement, and plugin cache refresh. Standalone skill linking is no longer supported; install or refresh the `thomas-codex-skills` plugin instead.

For local and private testing, prefer Azure CLI after a normal Microsoft sign-in:

```bash
az login --use-device-code --allow-no-subscriptions
```

The plugin uses Azure CLI tokens before PAT fallback, so this keeps local auth
on short-lived Microsoft Entra tokens when possible. If Azure CLI is unavailable,
use a scoped Azure DevOps personal access token as a last resort. On macOS,
store it in Keychain so Codex can use it without putting the token in chat, repo
files, or shell profiles:

```bash
read -s "ADO_PAT_VALUE?Azure DevOps PAT: "
security add-generic-password -a "$USER" -s codex-azure-devops-pat -w "$ADO_PAT_VALUE" -U
unset ADO_PAT_VALUE
```

You can also inject the token for one command without putting the secret itself
in shell history:

```bash
read -s "ADO_PAT_VALUE?Azure DevOps PAT: "
ADO_PAT="$ADO_PAT_VALUE" npm run smoke
unset ADO_PAT_VALUE
```

Create the token in Azure DevOps with the minimum scopes needed for your test,
such as Work Items read/write and Code read. Keep it out of chat, repo files,
and shell profiles unless you explicitly choose to persist it.

Local development can still use the same GitHub-like browser login flow when an
Entra public client is configured:

```text
ado_login
```

Set one of these before running `ado_login`:

- `AZURE_DEVOPS_OAUTH_CLIENT_ID`
- `MICROSOFT_ENTRA_CLIENT_ID`

The local login uses auth-code + PKCE and stores encrypted delegated tokens
under `~/.Codex/plugins/azure-devops/`. Use `mode=device` only when a browser
callback cannot work.

Local fallback configuration can use Codex setup tools or environment variables:

- `ADO_ORG_URL`
- `ADO_PROJECT`
- `ADO_REPOSITORIES`
- `ADO_PAT` or `AZURE_DEVOPS_EXT_PAT`
- `ADO_REQUEST_TIMEOUT_MS`
- `ADO_MAX_PAGES`

Microsoft OAuth remains the hosted connector target. Azure CLI auth is the
preferred local/private fallback; PAT auth is the last resort until the Entra app
is approved.

Do not create or commit `.env` files.

## Verify

```bash
npm run verify:manifests
npm run verify:plugin-descriptors
npm run verify:skills
npm run public-safety
npm run workflows:syntax
npm run build
npm run lint
npm test
npm run github:test
npm run smoke
```

The HTTP MCP contract test binds a local port. In sandboxed Codex sessions, run `npm test` with local networking allowed.

`npm run github:test` checks the GitHub Local Ops script syntax, self-test, and offline MCP contract. The contract disables ref fetching so root verification stays local and deterministic.

GitHub Local Ops uses preview-owned public-write execution. `github_mutation_preview` shows the exact command and risk notes, then `github_mutation_execute` applies only a live approval token. The bundled plugin manifest starts the MCP process with `--enable-public-writes`; custom launchers can use the same flag or set `GITHUB_LOCAL_OPS_ENABLE_PUBLIC_WRITES=true` after deliberately opting in.

Real smoke tests are gated by environment variables:

```bash
ADO_ORG_URL=https://dev.azure.com/example \
ADO_PROJECT=ExampleProject \
ADO_SMOKE_WORK_ITEM_ID=123 \
ADO_SMOKE_REPOSITORY=example-repo \
ADO_SMOKE_FILE_PATH=/README.md \
npm run smoke
```

Set `ADO_TEST_APPLY=true` and `ADO_TEST_WORK_ITEM_ID=<id>` only when you want the smoke script to add a real work item comment.

## Sharing Publicly

- Generate and confirm the canonical hosted URL in `plugins/azure-devops/.mcp.hosted.json`.
- Verify the Entra app publisher, consent behavior, and least-privilege permissions.
- Review `PRIVACY.md`, `SECURITY.md`, and `LICENSE` for your audience.
- Create a release tag only after build, lint, tests, and a real smoke test pass.
- Keep the package private unless you deliberately decide to publish to npm.
