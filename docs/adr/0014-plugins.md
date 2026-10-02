# 0014: Portable plugins with version-specific trust

Date: 2026-10-02. Status: accepted.

## Context

Claude Code and Cursor bundle several capability types behind their own manifests. Codex packages skills and tools with OpenAI extensions. The open Agent Plugins standard deliberately covers only skills and MCP, leaving installation and permissions to clients. Provider-native marketplaces do not give ace one installation or one review across CLIs. The competitor inventories supplied for this workstream describe t3code discovering provider skills without managing portable plugins. No competitor implementation is reused.

Primary sources read for this decision:

- [Agent Plugins 1.0 specification](https://agent-plugins.org/specification) defines root `plugin.json`, fixed `skills/` and `mcp.json`, transport types and extension namespaces.
- [Claude plugin reference](https://code.claude.com/docs/en/plugins-reference) and [marketplaces](https://code.claude.com/docs/en/plugin-marketplaces) describe component paths and Git catalogs. [CLI reference](https://code.claude.com/docs/en/cli-reference) documents session-only `--plugin-dir`.
- [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins) describes portable packages, compatibility manifests and local catalogs. [Codex configuration](https://developers.openai.com/codex/config-reference/) documents local marketplace selection, plugin enablement, MCP and hooks overrides. Plugin hooks also require native CLI trust.
- [Cursor plugins](https://cursor.com/docs/plugins), [reference](https://cursor.com/docs/reference/plugins) and [CLI flags](https://cursor.com/docs/cli/reference/parameters) describe native components and `--plugin-dir`.
- [OpenCode configuration](https://opencode.ai/docs/config/), [schema](https://opencode.ai/config.json) and [skills](https://opencode.ai/docs/skills/) document inline configuration, extra skill paths, commands, agents and instructions.
- [ACP session setup](https://agentclientprotocol.com/protocol/session-setup) defines session `mcpServers`; transport support still depends on the adapter's negotiated capabilities.

## Decision

Add `@ace/plugins`, with Zod validation, import normalization, Git acquisition, a per-user SQLite registry, pure projectors and a file writer. Do not add provider behavior to protocol or runtime dependencies on daemon internals.

`ace-plugin.json` version 1 has `name`, display `version`, optional description, lists of `{name, path}` skills, commands, agents and rules, an MCP server map, and command hooks. Skill paths name directories containing `SKILL.md`; other lists name Markdown files. Names and paths are bounded and validated before filesystem access. MCP supports stdio, HTTP and SSE. Hooks carry an event, command and optional matcher. Unsupported event mappings produce diagnostics rather than a fabricated equivalent. Rules are unconditional instruction files; richer provider-specific rule selectors are outside v1.

A catalog at root `marketplace.json` contains named plugins with relative `source` directories and optional SHA-256 expectations. Claude's `.claude-plugin/marketplace.json` and local directory entries are accepted too. Remote per-entry repositories, install scripts and package-manager dependencies are not interpreted. The catalog's Git commit pins all its local entries, making review reproducible without nested mutable references.

### Import mapping

| Input                                  | ace normalization                                                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ace-plugin.json`                      | Strict version 1 schema; explicit component lists                                                                                                |
| Agent Plugins `plugin.json`            | Recognize the 1.0 schema locally; discover fixed `skills/` and `mcp.json`; preserve extension data and report unsupported namespaces             |
| Claude `.claude-plugin/plugin.json`    | Discover default skills, commands, agents, `.mcp.json`, `hooks/hooks.json`; support relative custom component paths and inline MCP/command hooks |
| Codex or Cursor compatibility manifest | Accept the same practical directory/path subset, with native Cursor hook names preserved                                                         |

Import is a supported subset, not a claim of full standard conformance. Unsafe packages are rejected as a whole. Unknown metadata and extensions are retained for inspection, never executed. Prompt hooks, LSP servers, browser extensions, mods, dependencies, and MCP bundles need separate ownership and are reported as unsupported. Files outside the plugin directory, symlinks and Git submodules are rejected.

### API and provider output

The manager prepares an install or update, returning a review with plugin name, commit SHA, content hash, exact hook strings, stdio command/argv/env/cwd and remote endpoints. Acceptance requires that review's commit and content hash. Each accepted version records explicit trust. Updates always require a new acceptance, including script changes behind an unchanged command. There is no automatic executable update path.

`projectPlugins(provider, installed, {root})` returns `{env, args, files, sessionConfig, unsupported}`. Inputs are verified installed snapshots with bounded files. The root is an absolute ace-owned projection directory, not a user config directory. Adapters materialize files before starting the CLI and merge the returned overrides into their session configuration.

| Provider                  | Injection                                                                                                                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude                    | ace plugin directories passed through repeated `--plugin-dir`; MCP uses `--mcp-config`; rules use `--append-system-prompt`                                                                                                                                                     |
| Codex                     | ace local marketplace selected with `-c marketplaces.*`, plugins enabled with `-c plugins.*`; MCP uses TOML overrides and hooks use the native bundled file; rules use additional developer instructions; portable agent Markdown and custom slash commands report unsupported |
| OpenCode                  | `OPENCODE_CONFIG_CONTENT` supplies extra skill roots, MCP, command templates, subagent prompts and instruction file paths; hooks report unsupported                                                                                                                            |
| Cursor                    | ace native directories through `--plugin-dir`, with skills, commands, rules, agents, native hooks and MCP                                                                                                                                                                      |
| Antigravity / generic ACP | session `mcpServers`; file capabilities and hooks report unsupported until supported override paths are confirmed                                                                                                                                                              |

Provider CLI versions vary. Adapters must capability-probe flags and ACP transports and display diagnostics before launch. Native hook trust remains in force; ace does not disable provider approval or trust policies. A pure projector does not send prompts or start tools. Hook root placeholders map to native environment variables rather than literal shell text, preserving authored quoting.

### Registry, files and restarts

The caller passes a per-user ace root, clock and id generator. SQLite owns the accepted install and pending review records. Files live under that root in staging and immutable version directories. Mutations hold an exclusive SQLite file transaction lock; concurrent calls fail promptly rather than queue without a bound. Promotion writes a version before committing its registry pointer. Removal drops the pointer before deleting files. Startup and successful mutations collect unreferenced staging/version directories, so a crash between those steps is recoverable. Registry rows and files are revalidated before projection; integrity mismatch rejects use.

Projection roots require an ace ownership marker and must be empty on first adoption. Writers reject symlinks and replace the generated file set, removing obsolete output. Session owners must not rewrite or delete a projection while a provider is using it. They create separate roots for concurrent sessions and remove them after shutdown.

## Protocol and wire additions

Add a separate schema-only `@ace/protocol/plugins` export for prepare, accept, remove and list requests plus review/install summaries. The schemas carry commit and hash rather than trusting a display version. This is an additive contract for the daemon's command owner; this package does not rewrite the evolving main command union or WebSocket dispatcher. Daemon wiring and client consent UI are follow-up integration work. Pending reviews and diagnostics are backend results, not a false successful provider capability.

## Security

Nothing from a plugin executes during acquisition, import or acceptance. Read Git blobs directly from a shallow bare fetch; never checkout, run Git hooks, smudge filters, package scripts or provider CLIs. Git uses isolated config and restricted protocols. Hash sorted relative paths, executable bits and streamed bytes with unambiguous framing. Verify optional catalog expectations and stored hashes on every read and acceptance. Trust binds the complete package, not just its manifest.

Cap manifest bytes, file bytes, total package bytes, file counts, catalog entries and pending reviews. Reject absolute paths, traversal, backslashes, control characters, reserved names, symlinks and submodules. Executable review includes env and working directories, not only command names. This is consent and containment, not a sandbox: accepted hooks and MCP processes have the permissions of the provider process. No provider credentials are read, copied or stored.

## Performance

No session event or delta path is added. Preparation and verification stream files with bounded read buffers; Git output is capped and processes are killed on overflow. The external Git fetch may consume repository-dependent disk space before inspection; callers should apply host disk quotas for untrusted remote repositories. Projection is linear in selected package bytes once at session startup. SQLite uses prepared statements and transactions, with bounded list queries. A non-gating benchmark measures projection throughput and streaming verification, including RSS. No timer or wall-clock threshold is a gating test.

## Tests

Public API tests use temporary SQLite databases and real local Git repositories. They cover traversal and oversized input, both import formats, every provider's projected invocation/configuration, command review, version-bound consent, executable-bit preservation, integrity rejection, update/removal cleanup, crash recovery, concurrent lock rejection, and unchanged hashes of synthetic user configuration files. At least eight production mutations must cause a behavior test to fail before delivery. No provider session or recorder is run.
