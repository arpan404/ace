# 0128: Accounts share the person's provider tool setup, never their login

Status: accepted. Date: 2026-11-12. Decided by: the owner (approved 2026-11-12, including that people
can point the tool source at another folder). Builds on
[ADR 0002](0002-local-cli-providers.md),
[ADR 0018](0018-accounts-and-session-portability.md) (managed account homes) and
[ADR 0069](0069-shared-native-browser.md).

## Context

An account added in ace gets its own provider home (`<dataDir>/account-homes/<id>`, with
`CODEX_HOME` or `CLAUDE_CONFIG_DIR` pointed at it). That keeps logins apart, but it also leaves out
everything else the person set up in their normal home. Codex's computer use, browser and Chrome
tools are plugins from marketplaces, plus the `node_repl` MCP server that hosts them, all declared
in `~/.codex/config.toml` under `[marketplaces]`, `[plugins]` and `[mcp_servers]`. In a managed
home none of that exists, so those tools are missing. Claude Code started through the Agent SDK
never gets `--chrome`, so Claude in Chrome is off even for people who turned it on in Claude.

Some native tools also need a host app that ace is not: Codex's in-app browser talks to the
ChatGPT desktop app over a pipe it hands to its own children (`BROWSER_USE_ACCESS_*`).

## Decision

1. **A tool source, not a copy.** `providers.codex.toolSource` names a folder holding a Codex
   `config.toml`; null means the default Codex home (`CODEX_HOME`, else `~/.codex`). When ace
   starts a Codex app-server for an account whose home is not that folder, it reads the source's
   `[marketplaces]`, `[plugins]` and `[mcp_servers]` tables and passes each entry as a `-c`
   override on that launch. Nothing is written into the account home or ace's storage. Local
   marketplace sources with relative paths resolve against the source folder; everything else is
   passed as the person wrote it.
2. **Never the login.** Only those three tables are read. Auth files, `[model_providers]` and the
   rest of the config are never read or passed. The values can still hold secrets (an MCP
   server's `env` or `http_headers`), so logs and status name tables and keys only, never values.
   They travel as process arguments, as ace's own Codex MCP config already does.
3. **A source that doesn't hold up falls back.** A missing folder, a missing `config.toml` or one
   that doesn't parse means no extra config; the status says why. The derived arguments are part
   of the app-server pool key, so a changed source starts a fresh host.
4. **Report, don't emulate.** Each provider's native tools are reported on its status row as
   `ready`, `unavailable` or `unknown` with a reason, from facts ace already has or can read
   cheaply (enabled plugins, whether `node_repl`'s program exists, the Chrome setting). Tools that
   need a host app ace isn't, like Codex's in-app browser, are reported unavailable. ace never
   impersonates that app or fakes its pipe. Nothing spends provider quota to find out.
5. **Claude in Chrome follows the person.** `providers.claude.chrome` is `auto`, `on` or `off`.
   `auto` follows `claudeInChromeDefaultEnabled` in the person's Claude config (`~/.claude.json`,
   or `$CLAUDE_CONFIG_DIR/.claude.json`); `on` and an enabled `auto` start Claude Code with
   `--chrome`; `off` starts it with `--no-chrome`, so ace's choice holds whatever Claude's
   default is. An `auto` with Claude's default off passes neither flag.
6. Both settings are global and admin-only: they decide what programs a provider may start.

## Consequences

- Managed Codex accounts get the person's plugins and MCP servers without re-installing them, and
  people can keep a separate tool folder for ace.
- Codex may still need to install a plugin from its marketplace into the account home on first
  use; that is Codex's own behaviour and isn't verified here.
- ace's own browser and computer-use tools and their MCP guidance are unchanged.
