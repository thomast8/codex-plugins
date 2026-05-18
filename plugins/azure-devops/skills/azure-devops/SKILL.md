---
name: azure-devops
description: Use Azure DevOps Boards and Azure Repos from Codex through the hosted MCP server. Use when the user asks to find, summarize, create, update, or comment on Azure DevOps work items, inspect Azure Repos repositories, refs, files, commits, or pull requests, or connect ticket evidence with repository evidence.
---

# Azure DevOps

Use this skill when working with Azure DevOps Services through the `azure-devops` MCP server.

## Setup

Preferred setup is hosted Microsoft OAuth:

- `ado_setup_status`: check whether the plugin is ready.
- If OAuth is missing, use the returned login action or URL before asking for PAT or Azure CLI auth.
- The hosted MCP OAuth metadata should bring up Microsoft sign-in in the browser first.
- Hosted deployments can provide service-level organization, project, and repository defaults, so authenticated users can use tools immediately.
- The configuration page is a secondary admin/debug surface for reviewing or overriding organization URL, project, repository allowlist, and connection testing.
- For the polished user path, prefer the hosted HTTP MCP manifest. Local stdio mode is a development fallback.
- Until the Entra app is approved, Azure CLI Entra auth is the preferred local/private fallback for real Azure DevOps testing. A scoped PAT in macOS Keychain service `codex-azure-devops-pat` or `ADO_PAT` is last resort. Never ask the user to paste the PAT into chat or commit it to repo files.

Local development fallback may expose extra setup tools:

- `ado_login`: open Microsoft OAuth in the browser and store delegated Azure DevOps tokens for local stdio use.
- `ado_configure_connection`: save organization URL, project name, and optional repository allowlist in the local Codex plugin config file.
- `ado_test_connection`: verify live access by listing repositories.

Local fallback environment:

- `ADO_ORG_URL`: organization URL such as `https://dev.azure.com/example-org`
- `ADO_PROJECT`: project name

Local optional environment:

- `ADO_REPOSITORIES`: comma-separated repository allowlist
- `AZURE_DEVOPS_OAUTH_CLIENT_ID` or `MICROSOFT_ENTRA_CLIENT_ID`: public client ID for `ado_login`
- Azure CLI Entra auth: preferred local development fallback when `ado_login` is unavailable
- macOS Keychain service `codex-azure-devops-pat`: last-resort PAT fallback for local/private testing
- `ADO_PAT` or `AZURE_DEVOPS_EXT_PAT`: per-process PAT override for local/private testing

Do not ask public hosted users to edit shell profiles, create `.env` files, or run Azure CLI auth. Use browser OAuth first.

## Safe Workflow

Start from either side:

- Ticket-led: search or read work items, gather repository evidence, then preview updates or comments.
- Repo-led: inspect repositories, refs, commits, files, or pull requests, then search or draft related work item changes.

For all ticket writes:

- Call create, update, and comment tools first with `apply: false` or omit `apply`.
- Review the returned method, URL, headers, and body.
- Only call again with `apply: true` after the user explicitly approves the change.

## Tool Notes

- `ado_search_work_items`: use WIQL for precise queries, or the simpler query/type/state filters for exploratory search.
- `ado_get_work_item`: read full work item details with relations.
- `ado_create_work_item`, `ado_update_work_item`, `ado_add_work_item_comment`: preview by default and write only when `apply: true`.
- `ado_list_repositories`, `ado_list_refs`, `ado_list_commits`, `ado_list_items`, `ado_get_file`, `ado_list_pull_requests`, `ado_get_pull_request`: use for Azure Repos lookup.

Keep responses evidence-based. Include Azure DevOps URLs for work items, commits, files, repositories, and pull requests whenever available.

When the user asks to use Azure DevOps and setup is missing, call `ado_setup_status` first, then guide them through browser OAuth. Only use `ado_configure_connection` when org/project configuration is still missing or the user is deliberately using local development fallback.
