# ACP registry and generic agent integration

Researched 2026-10-02. This is a design proposal, with source inspection and two initialize-only local probes. No session, prompt, authentication request, model turn, recorder or test suite ran. Agent installation was not attempted. The ACP SDK and Auggie package tarballs were inspected without executing their code; upstream repositories were read for interfaces.

## Recommendation

Consume the official ACP registry v1 and keep ace's compatibility profiles separate from its distribution manifests. Offer every locally installed stdio ACP v1 agent through `@ace/adapter-acp`; label agents without verified profiles "Generic ACP, best effort". Registry inclusion identifies the catalog source and its distribution metadata. Artifact verification, correct tree status and account isolation need separate evidence. Adopt the official TypeScript SDK's stable public client API behind ace's bounded transport, while preserving the raw, lenient translator. Keep the existing transport until the replacement passes the behavior gates below. These are proposed ace decisions, subject to [ADR 0044](../../adr/0044-acp-agent-registry.md).

ADR [0002](../../adr/0002-local-cli-providers.md) remains binding. The user's CLI owns login and provider credentials. ace can launch a user-approved local bridge and point it at the user's installed CLI; it cannot silently use a bridge's bundled CLI, collect an API key, implement provider OAuth or become a hosted provider proxy. An API-key-only agent can work when the user configures its own CLI directly. An advertised OAuth method is not evidence that the user's login currently works.

## Evidence and installed versions

The research worktree starts at `4c2d6fb10115d2bb16dfa6191f812de6f79860de`. The inspected `origin/integration/train-1` is `8d98459e20c181d93abb269cc12d1df5a28ff75a`, fetched with `git fetch origin integration/train-1`. Accounts work is currently separate, inspected at `origin/feat/accounts`, `a30aa2c85849b92ee471f0ccc6147f0b3a6f6492`. Source links below pin these revisions where branch differences matter.

All six `--version` commands exited successfully. This is installed inventory, not a claim of ACP support:

| Command              | Observed version        | Executable resolved from PATH |
| -------------------- | ----------------------- | ----------------------------- |
| `codex --version`    | `codex-cli 0.159.1`     | `~/.bun/bin/codex`            |
| `opencode --version` | `opencode v2.0.22`      | `~/.opencode/bin/opencode`    |
| `agent --version`    | `2026.09.26-dd393fe`    | `~/.local/bin/agent`          |
| `claude --version`   | `2.1.286 (Claude Code)` | `~/.local/bin/claude`         |
| `gemini --version`   | `0.43.0`                | `~/.bun/bin/gemini`           |
| `qwen --version`     | `0.0.14`                | `/opt/homebrew/bin/qwen`      |

Source: local commands on 2026-10-02; uncommitted evidence `/tmp/ace-orch/acp-research/versions.json`. Absolute `~` here is `/Users/arpanbhandari`. No auth-status probes ran in this task.

For installed source citations:

- `G:` is `/Users/arpanbhandari/.bun/install/global/node_modules/@google/gemini-cli/bundle/`. The entrypoint is `gemini.js`; ACP implementation is `gemini-YQATFAPB.js`, source comments identify `packages/cli/src/acp/acpRpcDispatcher.ts`, `acpSessionManager.ts`, `acpSession.ts`, and `acpUtils.ts`. These are the installed 0.43.0 sources.
- `Q:` is `/opt/homebrew/Cellar/qwen-code/0.0.14/libexec/lib/node_modules/@qwen-code/qwen-code/`. ACP source is `dist/src/zed-integration/zedIntegration.js`, schema and dispatch are adjacent `schema.js` and `acp.js`.
- `S:` is the published `@agentclientprotocol/sdk@1.7.0` tarball from [npm](https://registry.npmjs.org/@agentclientprotocol/sdk/1.7.0), extracted without install to `/tmp/ace-orch/acp-research/sdk/package/`. SHA-256 of the downloaded tarball is `51f1a3fd7b9a60a426ff56d390a5e05876be13ea3a29515fd734d96412c609a9`. Published files can be read at `https://unpkg.com/@agentclientprotocol/sdk@1.7.0/`.

## Upstream registry, schema and provenance

Use the official ACP registry, not an ace-invented distribution manifest. Its repository is [`agentclientprotocol/registry`](https://github.com/agentclientprotocol/registry), inspected at `697941005a9dc75b39e17515f210812a5c03b617`. The canonical stable index is [`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json). A read-only fetch today returned schema version `1.0.0` and 41 agents, saved at `/tmp/ace-acp-registry-live.json`. The inspected response is 56738 bytes with SHA-256 `dc6e992260546ff0d4ed8b006ba04eaccafc1c019505550c15315299a9ea5267`; this content digest identifies the fetched snapshot, not a signature. The ACP docs also have a broader [agent catalog](https://agentclientprotocol.com/get-started/agents); Kiro and OpenHands occur there but are absent from this registry snapshot.

Schema authority is [agent.schema.json](https://github.com/agentclientprotocol/registry/blob/697941005a9dc75b39e17515f210812a5c03b617/agent.schema.json), [registry.schema.json](https://github.com/agentclientprotocol/registry/blob/697941005a9dc75b39e17515f210812a5c03b617/registry.schema.json), and [FORMAT.md](https://github.com/agentclientprotocol/registry/blob/697941005a9dc75b39e17515f210812a5c03b617/FORMAT.md). Index `{version, agents}`. Agent required fields are `id`, `name`, `version`, `description`, `distribution`; `license_url` is required except dimcode. Optional display/provenance fields include repository, website, authors as a string array, license as a string and icon as a URL string. Args are a string array; distribution env is a string-to-string object, unlike ACP session MCP env, which is an array of name/value pairs. Binary targets map Node arm64/x64 to upstream aarch64/x86_64. `id` is lowercase with hyphens, stable `version` is X.Y.Z. Distribution has one or more of:

- `npx` and `uvx`: `{package, args?, env?}`, package may include a pinned version.
- `binary`: keyed by darwin/linux/windows and aarch64/x86_64. Each target has `{archive, cmd, sha256?, args?, env?}`. Binary archives are zip, tar.gz/tgz, tar.bz2/tbz2 or raw binary, not OS installers.

There are no authentication/model/capability profiles or installed-binary discovery paths in this schema. These must remain ace metadata keyed by upstream agent identity/version, not a replacement launch catalog. The source-manifest preview block holds version/distribution only, and published indexes strip it. Do not use the JetBrains channel: its [builder](https://github.com/agentclientprotocol/registry/blob/697941005a9dc75b39e17515f210812a5c03b617/.github/workflows/build_registry.py) adds `--hide-claude-auth` to Claude and `bundled` metadata; stable generic index excludes github-copilot while including github-copilot-cli.

No registry signature/attestation field or verification contract was found in the inspected format/schema/build pipeline. Optional binary `sha256` exists and [verify_agents.py](https://github.com/agentclientprotocol/registry/blob/697941005a9dc75b39e17515f210812a5c03b617/.github/workflows/verify_agents.py) computes and compares it. Cursor and Antigravity snapshots have no digest. A digest from the same HTTPS index is integrity evidence, not independent publisher authentication. npm/PyPI provenance verification, when provided by the selected package manager, should remain with that manager. ace should cache original bytes, source URL, fetched time, ETag, content hash, schema version and pinned selected artifact/version. Retain last valid cache, enforce fetch size/time bounds, require consent for executable downloads/runner cache misses, show missing digest, avoid implicit update-on-launch, reject executable traversal/archive extraction escapes, and never execute a remote icon. These are proposed ace design choices, not registry guarantees.

[README](https://github.com/agentclientprotocol/registry/blob/697941005a9dc75b39e17515f210812a5c03b617/README.md) says curated auth and hourly version updates. [AUTHENTICATION.md](https://github.com/agentclientprotocol/registry/blob/697941005a9dc75b39e17515f210812a5c03b617/AUTHENTICATION.md) supports agent and terminal auth, and terminal args/env **replace**, rather than append to, normal ACP launch args/env. Curated membership does not prove background-work correctness or every feature. Zed confirms [ACP Registry as the current installation path](https://zed.dev/docs/ai/external-agents), and says extension-provided agents are deprecated and migrated. Its custom command/args/env path remains available for agents outside the registry. No reason to build a Zed extension installer in ace.

## Local initialize-only probes

Each process ran in a fresh empty temp directory with the user's normal environment. The probe wrote exactly this single NDJSON request, waited at most 25 seconds with a 1 MiB output cap per stream, then terminated the process group. It sent no `initialized`, `authenticate`, `session/new`, `session/load` or `session/prompt`. Both probes returned JSON-RPC id 1, emitted no captured stderr, and reported protocol version 1. Evidence is `/tmp/ace-orch/acp-research/{gemini,qwen}-initialize.json`; the complete relevant responses are preserved below.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "clientInfo": { "name": "ace-research", "version": "0.0.0" },
    "clientCapabilities": {
      "fs": { "readTextFile": false, "writeTextFile": false },
      "terminal": false
    }
  }
}
```

### Gemini CLI 0.43.0

Launch `gemini --acp`. Installed `gemini --help` describes `--experimental-acp` as deprecated. The [official ACP page](https://geminicli.com/docs/cli/acp-mode/) also specifies `--acp`, although its explanation puts MCP server details in initialize. The implementation puts them in session setup, which agrees with [ACP session setup](https://agentclientprotocol.com/protocol/v1/session-setup). Use the wire schema and shipped code for the placement. Sources: `G:docs/cli/acp-mode.md`, `GeminiAgent.initialize`, `AcpSessionManager.newSessionConfig`.

```json
{
  "protocolVersion": 1,
  "authMethods": [
    {
      "id": "oauth-personal",
      "name": "Log in with Google",
      "description": "Log in with your Google account"
    },
    {
      "id": "gemini-api-key",
      "name": "Gemini API key",
      "description": "Use an API key with Gemini Developer API",
      "_meta": { "api-key": { "provider": "google" } }
    },
    {
      "id": "vertex-ai",
      "name": "Vertex AI",
      "description": "Use an API key with Vertex AI GenAI API"
    },
    {
      "id": "gateway",
      "name": "AI API Gateway",
      "description": "Use a custom AI API Gateway",
      "_meta": { "gateway": { "protocol": "google", "restartRequired": "false" } }
    }
  ],
  "agentInfo": { "name": "gemini-cli", "title": "Gemini CLI", "version": "0.43.0" },
  "agentCapabilities": {
    "loadSession": true,
    "promptCapabilities": { "image": true, "audio": true, "embeddedContext": true },
    "mcpCapabilities": { "http": true, "sse": true }
  }
}
```

These are advertised capabilities, not turn-level verification. Initialize does not report available models, modes, usage or subagent capabilities. Omitted capability flags stay unknown or unsupported as defined by the protocol. Source: probe above and [initialization specification](https://agentclientprotocol.com/protocol/v1/initialization).

Login happens in the user's interactive `gemini`, selecting Google sign-in or configuring the CLI's own key/Vertex setup. The official [authentication guide](https://geminicli.com/docs/get-started/authentication/) documents cached local login. `GeminiAgent.authenticate({methodId,_meta})` refreshes auth, may clear cached credentials when switching methods, writes `security.auth.selectedType`, and accepts API-key and gateway metadata. ace must not use those secret-bearing fields or invoke authenticate during discovery. Source: `G:gemini-YQATFAPB.js#GeminiAgent.authenticate`; `G:docs/get-started/authentication.mdx`.

Source inspection, without creating a session, shows legacy `models.availableModels/currentModelId` and `modes.availableModes/currentModeId` in new/load session results. `buildAvailableModels` depends on selected auth, preview access and dynamic configuration. `buildAvailableModes` returns default, auto-edit and YOLO plus plan when enabled. Set mode via `session/set_mode`; this version sets model via `session/set_model`, implemented as `unstable_setSessionModel`. It does not implement `setSessionConfigOption`. `loadSession` may omit `sessionId`, so retain the requested ID. Mode-change handling also emits an `agent_message_chunk` containing `[MODE_UPDATE]`; do not infer a whole tree's completion from message text. Sources: `G:gemini-YQATFAPB.js#buildAvailableModels`, `buildAvailableModes`, `GeminiAgent`, `AcpSessionManager.newSession/loadSession`, `Session.handleApprovalModeChanged`.

Account-home caution: core `homedir()` in `G:chunk-UJ26GAE5.js`, source comment `packages/core/dist/src/utils/paths.js`, reads `GEMINI_CLI_HOME` as the user-home root and then uses `.gemini`. Entrypoint `G:gemini.js#getMemoryNodeArgs` instead reads `<GEMINI_CLI_HOME>/settings.json`. A profile must record this mismatch and verify the actual settings/auth paths with synthetic homes before advertising isolation. Do not apply Antigravity's `GEMINI_HOME` variable to Gemini CLI by analogy.

### Qwen Code 0.0.14

Launch this installed version with `qwen --experimental-acp`, confirmed by `qwen --help` and the probe. Current official [configuration docs](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/) describe `qwen --acp` as stable. Keep these version paths distinct.

```json
{
  "protocolVersion": 1,
  "authMethods": [
    { "id": "oauth-personal", "name": "Log in with Google", "description": null },
    {
      "id": "gemini-api-key",
      "name": "Use Gemini API key",
      "description": "Requires setting the `GEMINI_API_KEY` environment variable"
    },
    { "id": "vertex-ai", "name": "Vertex AI", "description": null },
    {
      "id": "openai",
      "name": "Use OpenAI API key",
      "description": "Requires setting the `OPENAI_API_KEY` environment variable"
    },
    {
      "id": "qwen-oauth",
      "name": "Qwen OAuth",
      "description": "OAuth authentication for Qwen models with 2000 daily requests"
    }
  ],
  "agentCapabilities": {
    "loadSession": false,
    "promptCapabilities": { "image": true, "audio": true, "embeddedContext": true }
  }
}
```

There is no `agentInfo`, HTTP/SSE MCP capability or model/mode metadata in this response. `Q:dist/src/zed-integration/zedIntegration.js#GeminiAgent.newSession` returns only `sessionId`; its dispatcher supports initialize, authenticate, newSession, prompt and cancel, without model/mode setters or loadSession. CLI `--model` and `--approval-mode` exist but are launch configuration, not ACP selectors. `newSessionConfig` merges stdio MCP definitions with configured servers. HTTP objects will not work here. Sources: local probe, installed help, `Q:dist/src/zed-integration/{zedIntegration.js,acp.js,schema.js}`.

The 2,000-request OAuth description is stale. Current upstream [auth source](https://github.com/QwenLM/qwen-code/blob/main/docs/users/configuration/auth.md) says Qwen OAuth's free tier ended on 2026-04-15 and directs users to configure Coding Plan or API-key providers in their own CLI. This task did not test a login or inference entitlement. The old `GeminiAgent.authenticate` always calls `clearCachedCredentialFile`, refreshes auth and updates settings. Discovery must not call it. Account data uses `os.homedir()/.qwen` in `Q:node_modules/@qwen-code/qwen-code-core/dist/src/config/storage.js#Storage.getGlobalGeminiDir`; no dedicated home override exists in this inspected function. Offer a default instance and mark additional account isolation unverified until a profile tests the complete CLI, including credential storage. Sources: installed source and official [quickstart](https://github.com/QwenLM/qwen-code/blob/main/docs/users/quickstart.md).

## Major agents and compatibility profiles

The exact pinned distributions below come from each agent's `agent.json` in the registry commit above. Prefer user's installed executable over package runners; runner launch can download implicitly and must require consent when artifact is not installed.

| Agent         | Stable registry entry                                                                                 | Installed launch                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Gemini CLI    | `gemini`, 0.62.0, npx `@google/gemini-cli@0.62.0`, args `--acp`                                       | `gemini --acp`, version-gate old `--experimental-acp`                              |
| Qwen Code     | `qwen-code`, 0.24.7, npx `@qwen-code/qwen-code@0.24.7`, args `--acp --experimental-skills`            | `qwen --acp`; inspect installed flag support and do not assume experimental skills |
| Goose         | `goose`, 1.53.0, binary target args `acp`, digests present                                            | `goose acp`                                                                        |
| Augment       | `auggie`, 0.36.0, npx `@augmentcode/auggie@0.36.0`, args `--acp`, env `AUGMENT_DISABLE_AUTO_UPDATE=1` | `auggie --acp`                                                                     |
| Claude bridge | `claude-acp`, 0.85.1, npx `@agentclientprotocol/claude-agent-acp@0.85.1`, no args                     | `claude-agent-acp`, with `CLAUDE_CODE_EXECUTABLE` set to user's claude             |
| Codex bridge  | `codex-acp`, 2.1.1, npx `@agentclientprotocol/codex-acp@2.1.1`, no args                               | `codex-acp`, with `CODEX_PATH` set to user's codex                                 |
| OpenCode      | `opencode`, 1.18.34, binary args `acp`, digests present                                               | `opencode acp`; retain existing richer native adapter as default                   |
| Cursor        | `cursor`, 2026.10.01, binary cursor-agent args `acp`, no digest                                       | `agent acp`; existing Cursor profile still needed                                  |
| Antigravity   | `antigravity-acp`, 1.3.0, binary agy_acp_server, Linux args `--uid=`, no digest                       | `agy_acp_server.par` on macOS; not Gemini CLI                                      |
| Kiro          | Catalog only, not registry snapshot                                                                   | `kiro-cli acp`, optional `--agent NAME`                                            |
| OpenHands     | Catalog only, not registry snapshot                                                                   | `openhands acp`                                                                    |

Source URLs for the table are `https://github.com/agentclientprotocol/registry/blob/697941005a9dc75b39e17515f210812a5c03b617/<id>/agent.json`, except [Kiro docs](https://kiro.dev/docs/cli/acp/) and [OpenHands docs](https://docs.openhands.dev/openhands/usage/cli/ide/overview). These are current registry releases, not the locally installed versions reported above. The bridge projects live in the ACP organization; registry inclusion does not establish a separate Anthropic/OpenAI authorization for login.

### Claude bridge

The currently registered project is `claude-agent-acp`, not the old claude-code-acp name. Read stable v0.85.1 at `686c0c99b3b89217b74d1f5de8272e7c9ef1aab4`. [src/acp-agent.ts](https://github.com/agentclientprotocol/claude-agent-acp/blob/686c0c99b3b89217b74d1f5de8272e7c9ef1aab4/src/acp-agent.ts), `ClaudeAcpAgent.initialize`, advertises protocol 1; loadSession; image and embedded context; MCP HTTP/SSE; auth logout; providers; session additionalDirectories/close/delete/fork/list/resume/subagents; `_meta.claudeCode.promptQueueing`, authStatus marker; top-level steering support. Some richer metadata is AIR-only and must not be assumed for ace. Subagent events need bilateral capability negotiation, per [README](https://github.com/agentclientprotocol/claude-agent-acp/blob/686c0c99b3b89217b74d1f5de8272e7c9ef1aab4/README.md).

ADR 0002 requirement: `claudeCliPath` defaults to platform native binary bundled with `@anthropic-ai/claude-agent-sdk`; `CLAUDE_CODE_EXECUTABLE` override is used by the SDK query options and `--cli` delegation. ace must set it to the resolved installed user's CLI and supervise the nested process tree. Do not silently substitute the bundled CLI. [src/paths.ts](https://github.com/agentclientprotocol/claude-agent-acp/blob/686c0c99b3b89217b74d1f5de8272e7c9ef1aab4/src/paths.ts), `claudeConfigDir`, uses `CLAUDE_CONFIG_DIR` or ~/.claude. Provider credentials stay in the CLI's own home/keychain; ace stores only selected config-root references.

Auth methods depend on advertised terminal auth. Local methods `claude-ai-login` and `console-login` run bridge `--cli auth login --claudeai` or `--console`; remote `claude-login` opens CLI TUI with `--cli`. Both standardized `auth.terminal` and old `_meta["terminal-auth"]` are recognized. `authenticate` implements custom gateway methods only and otherwise throws Method not implemented, so calling ACP authenticate for these terminal methods is wrong. ace should send the user to the own CLI command instead, consistent with ADR 0002. Gateway credential headers are outside ace's auth scope.

[src/session-mode.ts](https://github.com/agentclientprotocol/claude-agent-acp/blob/686c0c99b3b89217b74d1f5de8272e7c9ef1aab4/src/session-mode.ts), `buildAvailableModes`, has default/acceptEdits/plan/auto, optional bypassPermissions. Auto can fall back based on actual model support. Model/config options come from SDK/session setup, not registry or initialize; do not freeze a static list. Native Claude adapter keeps its own provider path.

### Codex bridge

Read stable v2.1.1 at `68d7d2d5ddfc0ed5746f9f6130892dda685e65dd`. [src/CodexAcpServer.ts](https://github.com/agentclientprotocol/codex-acp/blob/68d7d2d5ddfc0ed5746f9f6130892dda685e65dd/src/CodexAcpServer.ts), `initialize`, advertises loadSession, image/embedded context, session resume/list/close/delete/fork/additionalDirectories/subagents, MCP HTTP true/SSE false/acp false, auth logout, providers, authStatus marker and steering metadata. Native subagent lifecycle requires bilateral negotiation, per [README](https://github.com/agentclientprotocol/codex-acp/blob/68d7d2d5ddfc0ed5746f9f6130892dda685e65dd/README.md).

ADR 0002 requirement: [src/CodexJsonRpcConnection.ts](https://github.com/agentclientprotocol/codex-acp/blob/68d7d2d5ddfc0ed5746f9f6130892dda685e65dd/src/CodexJsonRpcConnection.ts), `startCodexConnection`, runs resolved override `CODEX_PATH app-server`; absent override it launches package dependency `@openai/codex/bin/codex.js`. ace must set CODEX_PATH and inherit the selected user's CODEX_HOME. [src/CodexAuthMethod.ts](https://github.com/agentclientprotocol/codex-acp/blob/68d7d2d5ddfc0ed5746f9f6130892dda685e65dd/src/CodexAuthMethod.ts), `getCodexAuthMethods`, has api-key; chat-gpt unless NO_BROWSER; chat-gpt-device-code only if client supports URL elicitation; gateway only on client opt-in. These bridge-supported flows are not permission for ace to collect API keys or implement provider login. Direct own `codex login` is the appropriate ace onboarding path.

[src/AgentMode.ts](https://github.com/agentclientprotocol/codex-acp/blob/68d7d2d5ddfc0ed5746f9f6130892dda685e65dd/src/AgentMode.ts) defines read-only/workspace-write/agent/agent-full-access. Model selection is dynamic and supports legacy session/set_model plus config options in `CodexAcpServer`. Keep the richer native app-server integration default; ACP bridge is a selectable interoperability route, not a forced replacement.

### Goose

Read stable v1.53.0 at `76da81cb964b21cd096db739302329b40c2998b8`. [crates/goose/src/acp/server.rs](https://github.com/block/goose/blob/76da81cb964b21cd096db739302329b40c2998b8/crates/goose/src/acp/server.rs), `on_initialize`, advertises load_session; session list/delete/close; image and embedded_context; audio false; MCP HTTP true, with auth method `goose-provider`, Configure Provider. `mcp_server_to_extension_config` accepts stdio/HTTP and explicitly rejects SSE. `on_set_model` rebuilds the selected provider; `on_set_mode` selects GooseMode. [response_builder.rs](https://github.com/block/goose/blob/76da81cb964b21cd096db739302329b40c2998b8/crates/goose/src/acp/response_builder.rs), build_model_state/build_mode_state, derives models from provider inventory and modes from GooseMode variants.

Auth quirk: [server/dispatch.rs](https://github.com/block/goose/blob/76da81cb964b21cd096db739302329b40c2998b8/crates/goose/src/acp/server/dispatch.rs) accepts AuthenticateRequest with an empty success, without doing provider login. The initialize description says to run `goose configure`. Registry auth membership must not become a promise that ACP authenticate sets credentials up. Provider configuration is local and agent-owned; provider choice may use API keys or local models/tools. [config/paths.rs](https://github.com/block/goose/blob/76da81cb964b21cd096db739302329b40c2998b8/crates/goose/src/config/paths.rs), Paths::path_root/get_dir, supports absolute GOOSE_PATH_ROOT, producing config/data/state subdirectories. Its default platform-specific paths preserve old Block/goose naming.

### Augment / Auggie

Read actual official npm package source, not only README: [@augmentcode/auggie@0.36.0 tarball](https://registry.npmjs.org/@augmentcode/auggie/-/auggie-0.36.0.tgz), local `/tmp/ace-acp-auggie-package/package/augment.mjs`, SHA-256 `6229e1685a5c4f9305ad333d76cd1a05c4315e6a9c8af3bbc75170b524005306`. Minified symbol WFt is ACPSessionManager, `initialize` begins offset 13177790. It advertises loadSession true, image true, session list, and no MCP HTTP/SSE capability. `authMethods` includes auggie-login only when client `_meta["terminal-auth"]` true; terminal command node <current-script> login, env AUGMENT_DISABLE_AUTO_UPDATE=1 and AUGMENT_LOGIN_FAST_EXIT=1. `authenticate` at offset 13184836 is a no-op, and session/new error explicitly directs `auggie login` outside ACP.

Model/mode response: `newSession` returns feature-flag/server model registry selection. `vTr` at offset 13175999 gives default and ask modes. `unstable_setSessionModel` and setSessionMode delegate to active session. `createSession` at offset 13182611 maps supplied ACP stdio/HTTP/SSE servers into mcpConfig, despite not advertising HTTP/SSE. Nonempty client MCP config replaces root mcpConfig in this source, a profile/injection merge risk. Use advertised transports by default; source support is not a reason to bypass negotiation without a tested version quirk. CLI flag `--augment-cache-dir` is present in published package; account isolation needs a test that it covers login store as well as session cache before being called supported. [Official ACP docs](https://docs.augmentcode.com/cli/acp/agent) confirm `auggie --acp` and note interactive features may be absent in ACP.

### Kiro

[Official ACP docs](https://kiro.dev/docs/cli/acp/) document `kiro-cli acp`, optional `--agent my-agent`, stdin/stdout JSON-RPC; initialize capabilities loadSession/image; model/mode switching and optional `_kiro.dev/` methods. These docs are not an installed-binary probe and contain protocol naming shorthand, so preserve exact raw initialize on first connection. [Auth docs](https://kiro.dev/docs/cli/authentication/) support own browser login via `kiro-cli login` and device flow; `kiro-cli whoami` reports identity. Local account-root override and exact authMethods list were not verified. Do not claim multiple isolated Kiro accounts until CLI home/keychain behaviour is tested. [New harness architecture](https://kiro.dev/blog/one-agent/) and current v3 early-access docs describe `_kiro/` extensions, while older ACP docs say `_kiro.dev/`; treat namespaces/version differences as profiles, not generic protocol rules.

### OpenHands

Read OpenHands-CLI at `954f2ba646e8d749261a8f2b2b7e3031fa39be9f`. [base_agent.py](https://github.com/OpenHands/OpenHands-CLI/blob/954f2ba646e8d749261a8f2b2b7e3031fa39be9f/openhands_cli/acp_impl/agent/base_agent.py), initialize, echoes requested protocol_version and advertises load_session, HTTP/SSE, image and embedded_context, audio false, oauth method labelled OAuth with OpenHands Cloud. authenticate uses agent's own login_command device flow. set_session_mode updates always-ask/always-approve/llm-approve. **set_session_model is currently a no-op despite returning success; list_sessions is an empty no-op and set_config_option unsupported.** Do not enable model switching merely because a method exists. [local_agent.py](https://github.com/OpenHands/OpenHands-CLI/blob/954f2ba646e8d749261a8f2b2b7e3031fa39be9f/openhands_cli/acp_impl/agent/local_agent.py) and [utils/mcp.py](https://github.com/OpenHands/OpenHands-CLI/blob/954f2ba646e8d749261a8f2b2b7e3031fa39be9f/openhands_cli/acp_impl/utils/mcp.py) consume new-session MCP configuration.

[locations.py](https://github.com/OpenHands/OpenHands-CLI/blob/954f2ba646e8d749261a8f2b2b7e3031fa39be9f/openhands_cli/locations.py) supports OPENHANDS_PERSISTENCE_DIR and OPENHANDS_CONVERSATIONS_DIR. [Official IDE docs](https://docs.openhands.dev/openhands/usage/cli/ide/overview) call ACP experimental, use `openhands acp`, and say own CLI settings supply LLM credentials. Current docs navigation labels CLI as deprecated; do not assume newer main-product SDK/client has the identical ACP agent. This local CLI route satisfies the local-process design, with user-configured API provider or own OpenHands Cloud login; ace must not store keys or switch to the cloud service as its execution transport.

## Additional agents

Registry manifestations at the pinned commit provide executable launches for others, without proving exact initialized capabilities/auth/modes:

- github-copilot-cli 1.0.91: npx `@github/copilot@1.0.91 --acp`.
- cline 3.0.68: npx `cline@3.0.68 --acp`.
- pi-acp 0.0.34: npx `pi-acp@0.0.34`, no args.
- kimi 1.52.0: binary `kimi acp`.
- mistral-vibe 2.25.8: binary `vibe-acp`, no args.
- factory-droid 0.232.0: npx `droid@0.232.0 exec --output-format acp-daemon`; DROID_DISABLE_AUTO_UPDATE=true and FACTORY_DROID_AUTO_UPDATE_ENABLED=false.

Sources: corresponding `<id>/agent.json` files under [registry pinned commit](https://github.com/agentclientprotocol/registry/tree/697941005a9dc75b39e17515f210812a5c03b617). Label these generic, best effort until exact version fixture/profile work verifies capabilities, auth, MCP behaviour and background-work visibility. Registry provenance and profile fidelity are separate concepts.

## Modern Qwen source, separate from the installed 0.0.14

Read registry-pinned v0.24.7, commit `b12edec1401a28fc53cd9e714d5928b285071fc8`, without running it. [packages/cli/src/acp-integration/acpAgent.ts](https://github.com/QwenLM/qwen-code/blob/b12edec1401a28fc53cd9e714d5928b285071fc8/packages/cli/src/acp-integration/acpAgent.ts), initialize, advertises loadSession true, prompt image/audio/embeddedContext true, session list/resume, MCP SSE/HTTP true, plus imageCapability metadata. This is a substantial change from installed 0.0.14 and must have a separate profile; do not copy modern claims to the old installation.

[authMethods.ts](https://github.com/QwenLM/qwen-code/blob/b12edec1401a28fc53cd9e714d5928b285071fc8/packages/cli/src/acp-integration/authMethods.ts), buildAuthMethods, advertises only `AuthType.USE_OPENAI`, named Use OpenAI API key, with `_meta.type=terminal` and args `--auth-type=openai`, requiring user-owned OPENAI_API_KEY. The old qwen-oauth advertised by installed 0.0.14 is absent from this modern list. authenticate still contains a QWEN_OAUTH branch and calls clearCachedCredentialFile/refreshAuthWithPersistedReasoning and writes selected auth type, so it is not a safe read-only discovery action. Never call it during probing. ace must not collect/store API keys; users configure their own Qwen CLI. The current official auth docs cited above say Qwen OAuth's free tier was discontinued on 2026-04-15 and removed from the auth picker. Residual OAuth source does not prove service availability.

[packages/cli/src/config/config.ts](https://github.com/QwenLM/qwen-code/blob/b12edec1401a28fc53cd9e714d5928b285071fc8/packages/cli/src/config/config.ts) exposes `--acp`; `--experimental-acp` is hidden/deprecated, and `--experimental-skills` is hidden/deprecated and ignored because skills now default enabled. The registry's extra skills flag therefore should not become a semantic ace requirement. `setSessionMode` and `unstable_setSessionModel` in acpAgent delegate to session and models/configOptions are session-derived, not initialize-derived. No prompt/session was sent to verify them. [packages/core/src/config/storage.ts](https://github.com/QwenLM/qwen-code/blob/b12edec1401a28fc53cd9e714d5928b285071fc8/packages/core/src/config/storage.ts), Storage.getGlobalQwenDir, supports QWEN_HOME; do not assume the same override existed in 0.0.14.

Modern Qwen [session/Session.ts](https://github.com/QwenLM/qwen-code/blob/b12edec1401a28fc53cd9e714d5928b285071fc8/packages/cli/src/acp-integration/session/Session.ts), setMode, validates plan/default/auto-edit/auto/yolo. Model changes are validated session operations; exact model choices come from session setup. The acpAgent initialize source has an optional active-work heartbeat negotiation in metadata. That is a promising profile-specific liveness signal, not proof that generic ACP reports every child/background task. Its bilateral opt-in and exact fields need fixture validation before ace advertises full background visibility.

## Official TypeScript SDK

`npm view @agentclientprotocol/sdk version dist.tarball dist.integrity repository --json` returned **1.7.0**, newer than the 1.6.0 cited in earlier provider research. The package is Apache-2.0, compiled ESM JavaScript with declarations, and accepts Zod `^3.25.0 || ^4.0.0`. Its root export is stable ACP v1; `experimental/v2` and HTTP/WebSocket/server/node paths are explicit experimental exports. None requires provider credentials. The SDK is protocol plumbing, not a model-provider API. Source: [published package.json](https://unpkg.com/@agentclientprotocol/sdk@1.7.0/package.json) and npm metadata above.

### Current API and exact limits

New code uses `client({name})`, `.onRequest(method, handler)`, `.onNotification(method, handler)` and `.connect(stream)` or scoped `.connectWith(stream, async ctx => ...)`. `connection.agent` is a `ClientContext` with typed `request`/`notify` and `buildSession`. For example, use `connection.agent.request(methods.agent.initialize, params)` and `connection.agent.notify(methods.agent.session.cancel, params)`. The method constants cover authentication, session creation/loading/listing/resumption/closure, mode/configuration, prompt and cancellation; named convenience methods such as `newSession` belong to deprecated `ClientSideConnection`. Custom methods accept an explicit parameter parser. `ClientSideConnection` and `AgentSideConnection` remain deprecated compatibility wrappers. Connection lifetime exposes `signal`, `closed` and `close`. Sources: [acp.d.ts](https://unpkg.com/@agentclientprotocol/sdk@1.7.0/dist/acp.d.ts), `S:dist/acp.js#ClientApp`, `ClientContext`, `methods`.

The shipped code is better than an older README suggests, but does not replace ace's resource policy:

| Published implementation                                                              | Finding                                                                                                                                                                            | Consequence for ace                                                                                                          |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `dist/stream.js#ndJsonStream`, `line-buffer.js`, `stream-limits.js`                   | UTF-8 line buffer with default 32 MiB message limit; public `maxMessageBytes`; serialized output waits for writes                                                                  | Set an ace limit explicitly; keep byte accounting before allocation                                                          |
| `stream.js#ndJsonStream`                                                              | Eager async `start` keeps reading and enqueuing; it does not consult `desiredSize`                                                                                                 | Do not use default readable as the only backpressure boundary                                                                |
| `jsonrpc.js#Connection`                                                               | `pendingResponses`, `incomingRequests`, `retryQueue`, and promise write chain have no count/byte admission caps in the stable client path                                          | Charge requests, handler concurrency and queued bytes before SDK admission                                                   |
| `jsonrpc.js#prepareRequest`                                                           | `cancellationSignal` sends `$/cancel_request`; it does not locally reject/remove the pending response                                                                              | Metadata deadlines must close the owned connection when the peer does not settle; a Promise.race alone leaks pending entries |
| `jsonrpc.js#receive/close`                                                            | EOF or read/write error closes connection, rejects pending responses and aborts incoming handlers                                                                                  | Map closure to process lifecycle and expire human interactions; still stop the supervised process group                      |
| `acp.js#SessionUpdateRouter`, `schema/zod.gen.js#zSessionUpdate/zSessionNotification` | Client router parses every `session/update` before custom notification handlers. Union lists known variants only; ordinary Zod objects strip extra fields from parsed handler data | A custom parser registered on `session/update` alone does not make the router lenient                                        |
| `jsonrpc.js#receiveWireMessage/isJsonRpcEnvelope`                                     | Requires JSON-RPC 2.0 envelope; stable app rejects batches                                                                                                                         | Preserve original raw data; normalize a documented legacy envelope only through a profile                                    |

Sources for every row: [stream.js](https://unpkg.com/@agentclientprotocol/sdk@1.7.0/dist/stream.js), [line-buffer.js](https://unpkg.com/@agentclientprotocol/sdk@1.7.0/dist/line-buffer.js), [stream-limits.js](https://unpkg.com/@agentclientprotocol/sdk@1.7.0/dist/stream-limits.js), [jsonrpc.js](https://unpkg.com/@agentclientprotocol/sdk@1.7.0/dist/jsonrpc.js), [acp.js](https://unpkg.com/@agentclientprotocol/sdk@1.7.0/dist/acp.js), [generated validators](https://unpkg.com/@agentclientprotocol/sdk@1.7.0/dist/schema/zod.gen.js). The separate `dist/connection.js#AgentConnectionManager` has HTTP/WebSocket buffering limits. It is not the stable stdio `jsonrpc.js#Connection`; those limits cannot be credited to the root client's stdio path.

### Proposed SDK adoption

Use root SDK types, method constants and public client request/response handling. Place an ace-owned custom `Stream` between the client and `spawnSupervised`, using provider-kit's bounded framing/writer ownership. Observe original inbound and outbound frames before any normalization, redact ephemeral MCP headers before persistence, and dispatch all `session/update` frames to the existing lenient translator and session routing. Keep those notifications out of the SDK session router, including unknown variants, and avoid SDK session builders that need its update queues. This preserves Cursor's custom child updates without fabricating a valid SDK update. Register standard permission requests and profile-specific extension requests through public `.onRequest` overloads with lenient boundary schemas. Unknown requests retain raw evidence and get method-not-found.

The bridge must admit pending outgoing requests and incoming handler lifetimes before the SDK dispatches them, charge every queued/in-flight write at admission, and release charges on confirmed settlement or complete connection closure. A sink-only limit is too late because SDK calls can accumulate in its promise chain. Use one ACP connection per supervised process lifetime. Preserve final stdout drain before disposal, reject replacement-process work using old request IDs, and cancel human requests on exit. Profile gates control protocol cancellation; ace still sends `session/cancel` for prompt interruption and waits for completion facts. These are proposed engineering requirements grounded in the SDK code above and [ADR 0007](../../adr/0007-adapter-and-engine-contract.md).

Adopt neither experimental ACP v2 nor experimental network transports in this change. Keeping ace's byte framing is deliberate: it also owns malformed stdout diagnostics and bounded raw capture. No private SDK imports, copied SDK implementation or SDK fork. If the public client cannot meet the acceptance tests, retain `JsonRpcPeer` for live sessions, use official types/constants, and document the remaining upstream blocker rather than weakening correctness.

## Existing ace adapter and migration

The integration branch already has one generic translator and separate Cursor/Antigravity quirks. `createAcpAdapter(quirks, {command,args,env})` resolves a local executable and returns `ProviderAdapter`; `genericQuirks.provider` is `acp`. Generic discovery has no command until configured. The factory computes capabilities from the discovery version, without using initialize results. The session advertises no filesystem or terminal callbacks, sends an `initialized` notification, then unconditionally opens or loads a session with `mcpServers: []`. A requested model unconditionally uses `session/set_config_option` with `configId: "model"`. Sources: [adapter.ts](https://github.com/arpan404/ace/blob/8d98459e20c181d93abb269cc12d1df5a28ff75a/packages/adapter-acp/src/adapter.ts), [session.ts](https://github.com/arpan404/ace/blob/8d98459e20c181d93abb269cc12d1df5a28ff75a/packages/adapter-acp/src/session.ts), `quirks/{types,generic,cursor,antigravity}.ts` at that revision.

Those assumptions must change. Installed Gemini needs legacy model selection; installed Qwen has no ACP selector and cannot load sessions. ACP initialization does not specify an MCP-style `initialized` notification. Remove the unconditional notification, allowing a profile only if a provider actually requires an extension. Merge live negotiated capabilities before accepting feature-dependent commands. Preserve the pure translator, child routing, request interactions, shell settlement, cancellation grace and injected identity allocator. Sources: probe/source sections above, [ACP initialization](https://agentclientprotocol.com/protocol/v1/initialization), train `session-routing.ts`, `settlement.ts`, `shell-settlement.ts`, `identity.ts`, `translator.ts`.

Use the train branch's provider-kit baseline. It now enforces 256 outgoing pending requests, 16 MiB outbound messages, 32 MiB queued/in-flight writes and 4,096 explicit ID reservations by default. `RpcWriter` waits for both callback and drain; pipe ownership survives facade replacement and peer disposal. The docs branch's older `JsonRpcPeer` lacks these guarantees. The SDK migration must retain or tighten the train defaults, including bounded input framing, instead of benchmarking against the older local implementation. Sources: train [jsonrpc.ts](https://github.com/arpan404/ace/blob/8d98459e20c181d93abb269cc12d1df5a28ff75a/packages/provider-kit/src/jsonrpc.ts), `rpc-owner.ts`, `rpc-writer.ts`, `rpc-ids.ts`, `process-bytes.ts`.

Keep the native Claude, Codex and OpenCode adapters as preferred integrations. An ACP bridge is an additional selectable agent identity and may expose less tree/history detail. The installed OpenCode 2.0.22 also falls outside the train native adapter's stated `>=1.18.33 <2` range; this task establishes no compatibility for that release. Sources: existing provider research [overview](README.md), train `packages/adapter-{claude,codex,opencode}/README.md`, especially `adapter-opencode/README.md` and `opencode.md`'s primary ACP source references.

## Proposed registry service

These are ace design requirements, not claims about upstream implementation. Ownership follows ADRs [0002](../../adr/0002-local-cli-providers.md), [0004](../../adr/0004-canonical-agent-model.md), [0006](../../adr/0006-large-payloads.md), [0007](../../adr/0007-adapter-and-engine-contract.md), [0010](../../adr/0010-ace-mcp-server.md), and [0036](../../adr/0036-model-catalog.md).

### Identity and profile rules

A registry entry is upstream distribution metadata. An installation is a specific local executable/package version and platform. An account instance is an opaque ace ID referring to the user's CLI-owned config home and login revision. A compatibility profile is ace-authored knowledge about one agent identity and tested version ranges. None is a credential store.

Keep `ProviderKind = "acp"` for arbitrary registry agents and add a separately persisted `acpAgentId`, installation reference and instance reference to thread creation, thread/native identity, model and account metadata. Do not add an enum case for every registry entry. Preserve existing `cursor` and `antigravity` values and native providers during migration. A custom entry gets a source-qualified ID so it cannot replace the official entry with the same name. Existing `ProviderKind` already includes `acp`; existing account schemas only permit Codex, Claude, OpenCode and Cursor. Sources: `packages/protocol/src/provider.ts`, `thread.ts`, `models.ts`; [accounts schema](https://github.com/arpan404/ace/blob/a30aa2c85849b92ee471f0ccc6147f0b3a6f6492/packages/protocol/src/accounts.ts).

Profiles describe local command candidates, metadata-only version/help probes, verified config-home selectors, login hints, underlying CLI overrides for bridges, accepted agent identity, tested version intervals, selector dialects, client extension negotiation and lifecycle quirks. They do not replace live initialize/session negotiation. Compute support as the intersection of what this installation advertises, what ace implements, and any safety restrictions established by its profile. Absence of a profile disables vendor extensions and claims of account migration, background control or complete subagent visibility, while allowing standard ACP operation.

Keep raw advertised capabilities separately from canonical capabilities. Image support in initialize is useful evidence; it does not prove image handling or background visibility. Display "Profile available, source/probe verified" until turn fixtures validate behavior; reserve "Verified profile" for recorded coverage of the stated version. Unknown versions fall back to "Generic ACP, best effort", retaining standard negotiated features and reporting exactly which controls are unavailable. Known outstanding work and lifecycle uncertainty always block a done state. For hidden work that the protocol cannot observe, report limited visibility in the UI; ace cannot promise a complete provider tree from an initialize reply.

### Catalog, cache and provenance

Add `@ace/agent-registry` with a pure manifest decoder, distribution selector, profile matcher and install-plan builder; thin shells fetch bounded HTTPS metadata, manage the cache and inventory local installations. `@ace/protocol` contains only schemas/types. Reuse provider-kit executable resolution, metadata probes, supervised processes and transport. The registry service owns no provider status machine, account store or model cache.

Cache one atomically replaced valid upstream snapshot and bounded refresh metadata in ace-owned storage. Proposed initial budgets are 4 MiB index body, 2,048 entries, 64 KiB per entry, 64 KiB icon, 512 local installations and a 24-hour freshness TTL. Coalesce refreshes; return stale validated data immediately; retain it after network/validation failures; bound retries and support injected clocks/endpoints. Fetch lazily or through explicit refresh, and keep installed agents usable offline. An unsupported schema major keeps the previous valid snapshot. For a supported major, validate known fields, retain additive metadata as raw data, and leave future distribution types visibly unavailable rather than causing the entire registry to disappear. This forward-compatible decoder does not treat unknown executable distributions as approved launch plans.

Persist upstream URL, fetched timestamp, schema version, response digest and available release/commit identity. An ETag is cache validation, not publisher authentication. Use the official HTTPS endpoint and inspect changed distribution URLs/package versions. Verify per-platform artifact hashes where supplied and package-manager integrity/provenance where available; record the actual verification result. Do not claim the registry is signed without a verifiable signature mechanism. If signatures are added later, pin accepted publisher keys and reject failed verification rather than degrading to unsigned metadata. A user-added HTTPS registry or local command remains visibly third party.

A registry refresh never installs or updates code. A selected update cannot change a running thread's installation. Capture the installation digest/version when opening a process so restarts use the same launch plan, or explain that the original version is no longer available. An explicit update becomes a new installation with its own profile check.

### Discovery, installation and local login

Discovery checks PATH and explicit user paths for known profiles and previously approved installations. It does not run every command listed by a remote catalog or use `npx`/`uvx` as a presence check, because those can download and execute packages. Unknown agents are added by the user through an explicit local command/argv or an approved registry installation. Initialize an approved installed process with a deadline; it may still execute startup hooks or contact services, so it is executable-code trust, even without a prompt.

Before installation, show a concrete plan containing publisher/source, exact package or artifact version, platform, integrity/provenance evidence, destination, prerequisite runtime and argv. The user chooses their package manager. Installing or updating through it requires an explicit install intent and owner consent. Execute argv directly under supervision, with bounded output and a cancel action. Verify artifact hashes before extraction; reject traversal, links escaping the destination, excessive archive expansion and unsupported target triples. Do not evaluate manifest values through a shell.

After installation, ordinary launches resolve the approved local artifact without implicit package download or auto-update. If a distribution uses a package runner, prove its launch can use the already approved cached package offline; otherwise install and resolve its entrypoint first. A manifest update, missing cache or changed executable must produce a new reviewable installation plan, not a background fetch.

Authentication metadata gives methods, not login status. Prefer safe provider-owned status commands where documented. Otherwise report auth unknown until the agent rejects an authorized real session with auth-required. Direct the user to the CLI's own login command in a local terminal with the same instance environment. ace does not consume a browser callback, solicit secrets in a UI or call ACP authenticate to offer a provider login. Configuration homes are references; discovery reads no credential files. Secret environment settings remain CLI/user-owned and are not persisted as registry overrides.

### Accounts and model catalog

Extend `@ace/accounts` through a profile-specific home strategy, using its existing instance registry and login-revision contract. A strategy defines the root semantics and the selectors that actually isolate that CLI. Default instances can share the user's existing home; additional accounts need documented and verified isolation. A custom agent without a home profile cannot claim isolation just because it accepts an environment variable. Preserve native account migration; return unsupported for generic ACP migration until a profile demonstrates provider-owned resume/fork across homes. Sources for current owner: [accounts instances.ts](https://github.com/arpan404/ace/blob/a30aa2c85849b92ee471f0ccc6147f0b3a6f6492/packages/accounts/src/instances.ts), `service.ts`, `registry.ts`, and `migration.ts` at that revision.

Register each ACP instance with `@ace/models` using its resolved launch plan, `acpAgentId`, installation version, profile revision and login revision. Keep its cache isolated from other ACP agents and accounts. Initialize alone provides no standard model listing. Prefer `configOptions` with actual IDs/categories and `session/set_config_option`; otherwise use advertised model/mode lists. Standard `session/set_mode` can follow an advertised modes list even without a profile; legacy/unstable model setters need a profile dialect and known no-op restrictions still apply. Never assume config ID `model`, synthesize a global provider model list, infer entitlement from advertised choices, or change permission mode automatically. Source: [ACP config options](https://agentclientprotocol.com/protocol/v1/session-config-options), installed Gemini/Qwen source above, `packages/models/src/{discover,normalize,types,cursor}.ts`.

Propose an amendment to ADR 0036's blanket generic ACP empty-session discovery. Unknown third-party agents cannot establish that `session/new` is metadata-only; it may run startup hooks, initialize extensions or background services. For a profiled version with a reviewed safe empty-session path, allow bounded metadata-only discovery with no MCP and no prompt, under the existing local process trust. Otherwise populate selectors from the first user-authorized real session, or show catalog unavailable and let the CLI choose its default. No model access checks through inference. This research created no empty sessions, including for Gemini and Qwen.

### MCP injection and lifecycle

Use `@ace/mcp-server`'s existing `acpInjection` helper and ephemeral per-session lease. For agents advertising `mcpCapabilities.http`, append the `ace` definition to `mcpServers` on session new/load or another session method whose schema permits it:

```json
{
  "type": "http",
  "name": "ace",
  "url": "http://127.0.0.1:<port>/mcp",
  "headers": [{ "name": "Authorization", "value": "Bearer <ephemeral-ace-lease>" }]
}
```

These are ace-local capabilities, never provider credentials. Keep user-defined servers, detect name collisions, and revoke the lease with process/session shutdown, startup failure and daemon restart. MCP URLs/lease secrets stay in memory and never enter registry manifests, account storage, thread persistence, raw wire capture or support exports. Wire capture must redact the header before `ctx.onFrame`, retaining the rest of the frame. Source: [ADR 0010](../../adr/0010-ace-mcp-server.md), `packages/mcp-server/src/{injection,credentials,registry}.ts`, [ACP session setup](https://agentclientprotocol.com/protocol/v1/session-setup).

For stdio-only agents such as installed Qwen, add an ace-owned supervised stdio MCP client bridge to the loopback server, using the same lease. Send the standard `{name,command,args,env:[{name,value}]}` ACP definition and pass the ephemeral lease through the bridge's environment/pipe, never command arguments or disk. This is new future feature work in `@ace/mcp-server`, not an existing capability. Bound its stdin/stdout, requests and child processes; stop it with the session. Until that bridge exists, mark ace MCP unavailable on stdio-only agents rather than silently injecting an HTTP object. SSE-only peers require a separately supported transport, or the stdio bridge; do not reinterpret HTTP as SSE.

Keep filesystem and terminal capabilities false unless actual ace callbacks exist. A future terminal callback can improve observable shell ownership but is its own scoped feature. Adding MCP does not invent ACP tree events. ace-spawned agents still join the canonical tree through accepted MCP spawn intents; provider-native hidden subagents remain limited visibility. Source: [ADR 0004](../../adr/0004-canonical-agent-model.md), [ADR 0010](../../adr/0010-ace-mcp-server.md) and train `session.ts`.

## Validation required for implementation

Use public behavior tests and synthetic local ACP processes for catalog/cache and transport failures, plus replay of existing fixtures. Tests should guard these outcomes:

- An offline daemon lists its last valid catalog and launches an approved installed agent; a malformed refresh preserves that catalog. Duplicate IDs, unsupported targets, unknown distribution types and failed hashes produce actionable results without executing code.
- Listing/discovery never installs, logs in, starts a model turn or runs an unapproved registry command. Changed package versions require a new install intent; installation cancellation removes incomplete staging and leaves the previous installation usable.
- Two ACP agents and two homes never share account/model cache entries. Login revision changes invalidate only the matching instance. A bridge always launches the user's resolved native CLI.
- Unknown fields, vendor methods and update variants remain raw and never kill the connection. Child work, permission waits and surviving shells keep the thread unsettled after the root prompt returns; uncertain completion cannot admit the next prompt.
- Initialize negotiates before resume/model/MCP decisions. Legacy Gemini model selection works, old Qwen does not receive unsupported setters/load/HTTP MCP, and a current profile does not inherit an old profile's auth guarantees.
- Partial UTF-8 lines, malformed/oversize frames, stalled stdin, many server permission requests and ignored cancellation remain within byte/count budgets. EOF, process death and replacement close pending work once, expire interactions and preserve final stdout facts.
- MCP injection preserves configured servers and selects an advertised transport. Lease revocation denies old processes, startup failure cleans up, and raw capture contains no bearer token.
- Catalog refresh uses no prompt and does not create a session for an unprofiled agent. Dynamic selector changes preserve native IDs and replace dependent options without offering unsupported effort/tier controls.

Real provider recordings require a separate owner request because they spend quota. The worker brief lists proposed recording scenarios. Current evidence supports initialize and source claims only; no agent here earns a verified turn-behavior profile from this research.
