# 0002: Providers are reached only through the user's local CLIs

Date: 2026-10-02. Status: accepted.

## Context

Anthropic does not allow third parties to offer claude.ai login without approval. OpenAI says Codex app-server authentication is not permitted for commercial or hosted services. Antigravity's terms call third-party use of its Google sign-in a breach. Details: [research overview](../research/providers/README.md#auth-and-terms-of-service).

## Decision

- The ace daemon runs on the user's machine and drives the CLIs the user installed and logged into: `claude`, `codex`, `opencode`, Cursor's `agent`, and Antigravity's ACP server.
- ace never offers provider login, never stores or proxies provider credentials, and has no hosted mode. Remote and mobile access means the user's own devices connecting to their own daemon.
- The daemon resolves each CLI from the user's PATH (or a user-set path), reads its version and auth status, and sends the user to the CLI's own login command when needed.

## Consequences

- We don't control CLI versions. Adapters must probe capabilities, generate schemas from the installed binary where possible, and decode unknown data leniently.
- Antigravity remains uncertain: its ACP server is a separate download, and Google-account sign-in from third-party software may still breach its terms. API-key auth is the default until that is clarified.
