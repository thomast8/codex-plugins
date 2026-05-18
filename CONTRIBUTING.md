# Contributing

Thanks for helping improve the Azure DevOps Codex plugin.

## Development Setup

Use Node.js 22.13.0 or newer.

```bash
npm install
npm run build
npm test
npm run lint
```

Do not commit credentials, `.env` files, PATs, Azure CLI cache files, or organization-specific configuration.

## Pull Request Checklist

- Keep changes focused on one behavior or tool family.
- Add or update tests for request builders, preview/apply behavior, auth, pagination, and MCP contract behavior.
- Run `npm run build`, `npm test`, and `npm run lint`.
- For real Azure DevOps behavior, run `npm run smoke` with your own test organization and project.
- Document any new environment variables or tool inputs in the README and skill.

## Write Safety

Ticket writes must stay preview-first. New write tools should default to not applying changes and should return the exact method, URL, headers, and body before making a remote mutation.
