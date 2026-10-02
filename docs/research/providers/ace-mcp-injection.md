# ace MCP injection and discovery contracts

Checked 2026-10-02 against primary provider documentation and published types.
`@ace/mcp-server` implements these shapes as pure functions. Helpers return
sensitive process options; adapters must never log or persist them. They leave
user files untouched and must merge the options with the provider's existing
runtime configuration. `ace` is the injected server name.

## Codex

[Configuration reference](https://developers.openai.com/codex/config-reference/)
defines `mcp_servers.<name>.url` and `bearer_token_env_var`. Add these argv
entries, as separate arguments, to the owned Codex process:

```text
-c mcp_servers.ace.url="http://127.0.0.1:PORT/mcp"
-c mcp_servers.ace.bearer_token_env_var="ACE_MCP_BEARER_TOKEN"
```

Set `ACE_MCP_BEARER_TOKEN` in that process's environment. The bearer is absent
from argv. A provider process shared by multiple independently scoped sessions
must support per-session runtime server configuration, or use separate owned
processes. A process-wide override cannot attribute multiple sessions safely.
The adapter inserts `developerInstructions` into the provider's developer
instruction field rather than sending another user prompt.

Discovery reads `~/.codex/config.toml` and the project's `.codex/config.toml`.
The read-only API port accepts `mcpServerStatus/list`'s `{ data: [{ name, ... }] }`.
Adapters supply additional resolved config paths for `CODEX_HOME`, profiles
and ancestor project layers, and aggregate paginated API results within the cap.

## Claude

The published [Agent SDK TypeScript types](https://unpkg.com/@anthropic-ai/claude-agent-sdk@latest/sdk.d.ts)
define `McpHttpServerConfig`, under Agent SDK options `mcpServers`:

```json
{
  "mcpServers": {
    "ace": {
      "type": "http",
      "url": "http://127.0.0.1:PORT/mcp",
      "headers": { "Authorization": "Bearer SESSION_SECRET" }
    }
  }
}
```

The adapter appends the short instructions to its system/developer instruction
options. Claude's tool prefix is `mcp__ace__`.
Discovery reads `~/.claude.json`'s `mcpServers` and
`projects[absoluteCwd].mcpServers`, plus the project's `.mcp.json`.
Its API port accepts `query.mcpServerStatus()`'s array of named status entries.
No discovery call reconnects, toggles or adds servers.

## OpenCode

[MCP servers](https://opencode.ai/docs/mcp-servers/) documents remote server
configuration. The SDK runtime config channel, documented in
[OpenCode research](opencode.md), is `OPENCODE_CONFIG_CONTENT`. Its JSON value is:

```json
{
  "mcp": {
    "ace": {
      "type": "remote",
      "url": "http://127.0.0.1:PORT/mcp",
      "enabled": true,
      "oauth": false,
      "headers": { "Authorization": "Bearer SESSION_SECRET" }
    }
  }
}
```

Disable OAuth for this pre-issued local bearer. OpenCode names these tools
`ace_ace_*`. Discovery reads global and project `opencode.json`/`opencode.jsonc`
files, including `.opencode/`, and accepts the named status map from `GET /mcp`.
The API adapter must set the session's directory as described in the provider
research. Supply `configPaths` for XDG and other environment overrides.

## Cursor and Antigravity via ACP

[ACP session setup](https://agentclientprotocol.com/protocol/v1/session-setup)
defines an HTTP server in `session/new` and `session/load`:

```json
{
  "mcpServers": [
    {
      "type": "http",
      "name": "ace",
      "url": "http://127.0.0.1:PORT/mcp",
      "headers": [{ "name": "Authorization", "value": "Bearer SESSION_SECRET" }]
    }
  ]
}
```

The adapter must first probe `mcpCapabilities.http`. ACP has no common
per-session developer-instructions field; the adapter adds the short guidance
through its provider's supported instruction mechanism. The helpers do not
invent one. Cursor and Antigravity get the same server definition.

Cursor discovery reads `~/.cursor/mcp.json` and project `.cursor/mcp.json`.
Antigravity discovery reads `~/.gemini/config/mcp_config.json` and project
`.agents/mcp_config.json`, whose HTTP servers use `serverUrl`.
See [Cursor](cursor.md) and [Antigravity](antigravity.md) for provenance.
ACP itself has no standard API for enumerating a CLI's configured MCP servers.
Optional provider-specific read ports accept a named config/status map.

## Limits and display

Discovery returns names, source paths, transport, enabled flag and safe status
fields. It deliberately omits URLs, commands, arguments, headers, environment
values, raw config and errors because these can contain credentials. Unknown
fields remain tolerated during decoding. It reports malformed/unreadable files
and continues. Missing files are normal.

At most 32 config paths, 1 MiB per file and 512 server entries are accepted.
Read-only API adapters must cap network responses and honor the AbortSignal;
this package never invokes a provider CLI or launches a provider session.
