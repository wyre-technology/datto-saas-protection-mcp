# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed (BREAKING)
- Credentials: `DATTO_SAAS_API_KEY` (single value) → `DATTO_SAAS_PUBLIC_KEY` + `DATTO_SAAS_SECRET_KEY` (pair). Gateway headers renamed correspondingly: `X-Datto-SaaS-API-Key` → `X-Datto-SaaS-Public-Key` + `X-Datto-SaaS-Secret-Key`. The original scaffold modeled the API as Bearer-auth single-key, but Datto SaaS Protection's REST API actually uses HTTP Basic auth with a public/secret pair issued from the partner portal.

### Added
- Initial scaffold of the Datto SaaS Protection (Backupify) MCP server.
- Stdio + HTTP (StreamableHTTP) transports.
- Gateway-mode credential handling via `X-Datto-SaaS-Public-Key` / `X-Datto-SaaS-Secret-Key` / `X-Datto-SaaS-Region` headers.
- 9 tools covering clients, domains, seats, backups, restores, activity, and license usage.
- Destructive-action confirmation elicitation for `datto_saas_queue_restore`.
- Multi-stage `Dockerfile` with GitHub Packages auth via build secret.
- Semantic-release based CI release pipeline (`.github/workflows/release.yml`).
- MCPB packaging script and Smithery registry config.
