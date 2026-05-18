# Privacy

This plugin runs locally as a Codex MCP server and connects directly to the Azure DevOps organization configured by the user.

The plugin does not intentionally collect telemetry, phone home, or send Azure DevOps data to a third-party service. Data returned by Azure DevOps is provided to the local Codex session that invoked the tool.

Credentials are read from Azure CLI or environment variables at runtime. Do not commit credentials, `.env` files, PATs, Azure CLI tokens, organization-private URLs, or project-private data.

Users are responsible for configuring Azure DevOps credentials and repository allowlists appropriate for their organization.

