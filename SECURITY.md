# Security Policy

## Supported Versions

Security fixes target the latest version on the default branch until formal releases are introduced.

## Reporting A Vulnerability

Please report security issues privately before opening a public issue. If this repository has GitHub private vulnerability reporting enabled, use that flow. Otherwise, contact the maintainer listed in the repository profile.

Include:

- Affected tool or workflow
- Impact and likely exploit path
- Reproduction steps without secrets
- Suggested fix, if known

## Credential Handling

This plugin must not store Azure DevOps credentials in the repository. Use Azure CLI authentication or provide PATs through environment variables managed outside the repo.

Never include:

- PAT values
- Azure CLI tokens
- Organization-private URLs in test fixtures unless they are already public
- `.env` files

