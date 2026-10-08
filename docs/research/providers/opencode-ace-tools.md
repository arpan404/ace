# OpenCode ace tool discovery

Verified 2026-10-07 with the installed OpenCode 2.0.22 CLI. All work used
scratch directories under `/tmp`, a scratch ace SQLite store and loopback
listeners. No provider credentials, live ace home, installed app or other
application bundles were read. `tools/recorder` was not used.

## Registration and cause

ace already registers a location-scoped remote MCP server through OpenCode's
`PUT /api/experimental/mcp/ace` and `POST /api/experimental/mcp/ace/connect`.
The configuration includes a session-scoped Authorization header,
`protocol: "2026-07-28"`, `codemode: false`, `disabled: false`, `oauth: false`
and a 300-second execution timeout. Authority stays in the owned CLI process,
never in persistent provider or project configuration. Separate ace sessions
receive separate OpenCode processes and leases.

OpenCode's MCP connection and native model tool registry settle separately.
Its [native MCP tool registration][tools] processes catalog changes through a
100 ms debounce. A successful MCP connect is not a native tool readiness
barrier. Starting a prompt immediately after connect can omit all ace tools
from the model request, even though ace is connected and its instructions and
status resource are available. Waiting for a later registry generation makes
those tools appear. No fixed sleep is needed in ace's fix.

The native names include the server prefix. OpenCode advertises
`ace_ace_status`, `ace_ace_thread_info` and `ace_ace_list_agents` for the
read-only scope used in this probe. Its `execute` tool can list MCP resources
through `tools.opencode.list_mcp_resources`. Tools registered with
`codemode: false` are direct model functions and are absent from Code Mode
search. Searching only Code Mode's catalog therefore cannot establish that
ace is unavailable.

The fix adds a credential-free [Promise plugin][plugin] through the CLI's
`OPENCODE_CONFIG_CONTENT` plugin list. It observes native tool transforms and
exposes one readiness RPC. ace waits until the actual native catalog contains
a described `ace_ace_status` before accepting the session. The wait is bounded
and cancellable. Existing JSONC configuration and plugins are preserved; no
user config files are changed. The plugin carries no MCP URL or lease token.
MCP registration and lifecycle ownership remain in the existing adapter.
The standalone release stages the same plugin beside the daemon bundle.

## Real CLI results

| Probe                                   | Before                                      | After                                                          |
| --------------------------------------- | ------------------------------------------- | -------------------------------------------------------------- |
| MCP connection                          | ace connected                               | ace connected                                                  |
| MCP resources                           | `ace://status` present                      | `ace://status` present                                         |
| Server instructions in model request    | present                                     | present, with native status names                              |
| First model request's ace functions     | none                                        | `ace_ace_status`, `ace_ace_thread_info`, `ace_ace_list_agents` |
| Scripted status call through OpenCode   | unavailable as a direct first-turn function | returns scoped thread/agent IDs and disabled-group reasons     |
| Scripted resource list through OpenCode | status resource discoverable                | lists `ace://status`                                           |

The before/after model requests used the real CLI against an ace-owned local
OpenAI-compatible scripted model. This captures OpenCode's actual function
list and executes its native tools without external inference. A sanitized
[recorded tool-list fixture](../../../packages/adapter-opencode/src/__fixtures__/ace-native-tools-2.0.22.json)
contains only public tool definitions, with no messages, paths or headers.

One external prompt used `opencode/mimo-v2.6-flash-free`, which the isolated
CLI model catalog reported as zero-cost. Prompt: "Is ace available in this
session? Call ace_ace_status and list ace MCP resources. Reply briefly; do
nothing else."
The model selected `ace_ace_status` and `ace_ace_list_agents`. The scratch
session used the adapter's default approval policy, so both calls requested
approval. The process was stopped at the two-minute cap. There was no final
model answer or approved live tool result, and no second live prompt was sent.
The scripted full-access probe separately confirmed successful execution and
resource listing after the fix.

The owner's exact empty-resource result did not reproduce in this isolated
root session. It should not be attributed conclusively to the proven native
catalog race. OpenCode background work using another location or a separate
CLI service remains an unverified explanation. ace cannot inject a lease into
an unrelated provider process. These findings cover ace-owned sessions.

## Offline checks

- Fake OpenCode process: session admission waits for a held native catalog;
  the real readiness plugin runs in the fixture and resolves on tool reload.
- Same-account sessions preserve user MCP servers, isolate callers and revoke
  only the ended lease. Provider frames redact the session credential.
- Recorded native tool-list shape: readiness returns the described status,
  thread and agent tools; a missing status tool fails readiness on cancellation.
- Scripted Claude, Codex, OpenCode and Pi CLI processes, plus Cursor's SDK
  boundary: discover instructions, call scoped `ace_status`, list
  `ace://status`, and read resource content equal to the tool result.
  These use normal full-access sessions; existing restricted-mode contracts
  still apply.
- Packaged OpenCode adapter: waits on its staged native readiness plugin
  without reading the source plugin from the checkout.

No public wire or protocol schema changes. The readiness RPC is private to the
owned OpenCode process and contains only native tool names and descriptions.

[tools]: https://github.com/anomalyco/opencode/blob/v2.0.22/packages/core/src/tool/mcp.ts
[plugin]: https://github.com/anomalyco/opencode/blob/v2.0.22/packages/plugin/src/promise/plugin.ts
