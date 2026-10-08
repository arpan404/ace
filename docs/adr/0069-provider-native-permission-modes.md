# 0069: Provider-native permission modes

Date: 2026-10-07. Status: accepted by owner decision.

This supersedes [ADR 0061](0061-permission-modes.md)'s ace-wide permission modes,
default, reviewer, enforcement guarantees, synthetic tool gates and parent
permission ordering. The owner asked ace to use each provider's own modes and
let the provider enforce them. ace still presents native approval requests and
questions, persists their identity, and returns the user's native answer.

## Decision

Permission selection is provider configuration. There is no common permission
rank, promise of equivalent protection across providers, ace automatic reviewer,
or ace restriction on the provider's offered approval scopes. Delegated children
follow the provider's own inheritance rules. A native `plan` mode may appear in
the permission picker when the provider defines it there; ace does not convert
all planning features into permission modes.

Provider instances advertise `permissionModes` descriptors containing an opaque
`id`, provider label, description, display risk and, when known, `default: true`.
Risk is a UI annotation, never a permission comparison or enforcement rule.
Native enums and ACP selectors retain their exact IDs. For a provider with
independent native options, an ID can serialize a small native configuration
object. That encoding carries the provider's fields, not an ace policy whose
meaning an adapter must approximate. The adapter validates the object and passes
its fields to the native API. IDs belong to the selected provider instance and
backend; a Claude ID is not a Codex ID even when the words match.

An absent or null selection means let the provider choose its own configured
default. It is not a new mode ID. This distinction is necessary for Claude's
conditional startup default, OpenCode's mixed permission rules, user-defined
Codex profiles, and agents with no native selector. Pi advertises an empty list.
Providers without a known default do not mark an arbitrary descriptor as default.
An explicit Deck or scoped settings selection overrides absence for that
provider. A composer provider or model change retains an ID only if the new
instance still advertises it; otherwise it clears the selection to native
default. Defaults are stored per provider rather than interpreted as a universal
permission preference.

Apply mode changes at the native boundary the provider supports. A pending
change is distinct from an acknowledged effective selection. A process restart
needed for a session option waits until its whole tree is idle; it must not end
live child work or unanswered interactions. Codex can apply the next turn's
configuration without retiring its app-server. Native approval/question identity,
first-answer-wins behavior, restart uncertainty and whole-tree status remain as
specified by ADRs 0004, 0007 and 0053.

## Research method and installed evidence

Research ran only version/help commands, inspected public SDK declarations
installed by `bun install`, and read official documentation and public provider
interface source. It sent no provider prompt, started no authenticated session,
ran no recorder, read no provider credential file, and inspected no other app's
bundle. Published sources were read to establish interfaces, not to copy code.

The safe local commands on 2026-10-07 were:

| Provider                                  | Installed version    | Evidence commands                                                                                   |
| ----------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------- |
| Codex                                     | `codex-cli 0.159.1`  | `codex --version`, `codex --help`, `codex app-server --help`, `codex app-server generate-ts --help` |
| Claude Code                               | `2.1.286`            | `claude --version`, `claude --help`                                                                 |
| OpenCode                                  | `v2.0.22`            | `opencode --version`, `opencode --help`, `opencode run --help`                                      |
| Cursor CLI, distinct from the SDK backend | `2026.10.01-e373342` | `agent --version`, `agent --help`                                                                   |
| Pi                                        | `0.85.1`             | `pi --version`, `pi --help`                                                                         |
| Gemini CLI                                | `0.43.0`             | `gemini --version`, `gemini --help`                                                                 |
| Copilot CLI                               | `1.0.68`             | `copilot --version`, `copilot --help`, `copilot help permissions`, `copilot help commands`          |
| Qwen Code                                 | `0.0.14`             | `qwen --version`, `qwen --help`                                                                     |

Codex's metadata-only `app-server generate-ts --experimental --out <temp>/types`
also ran with `CODEX_HOME` pointed at a fresh temporary directory. It confirmed
the installed permission-profile listing and selection contract without opening
a session or accessing the user's Codex home. The repo's generated v2 types
already contain the native reviewer and thread/turn selection fields.

SDK declaration locations, relative to the worktree, were:

- Claude Agent SDK **0.3.288**: `node_modules/.bun/@anthropic-ai+claude-agent-sdk@0.3.288+cbe4395b12e12b2e/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, `PermissionMode`, `Options.permissionMode`, `Query.setPermissionMode`, `CanUseTool` and `PermissionResult`.
- Cursor SDK **1.0.35**: `node_modules/.bun/@cursor+sdk@1.0.35/node_modules/@cursor/sdk/dist/esm/options.d.ts`, `LocalAgentOptions.autoReview`, `sandboxOptions` and `SandboxOptions`; public agent/run declarations supply lifecycle controls.
- OpenCode client **2.0.22**: `node_modules/.bun/@opencode+client@2.0.22+11eac7cfbf53fc55/node_modules/@opencode/client/dist/promise/generated/types.d.ts`, `PermissionEffect`, `PermissionRule`, session create/update inputs, `PermissionRequest`, `PermissionReply` and permission events; `client.d.ts` supplies public methods.
- ACP SDK **1.7.0**: `node_modules/.bun/@agentclientprotocol+sdk@1.7.0+fff7ddf946fac095/node_modules/@agentclientprotocol/sdk/dist/schema/`, native session modes/config options and permission request/response declarations; `dist/acp.d.ts` supplies public methods.
- Codex generated **0.159.1**: `packages/adapter-codex/src/generated/v2/AskForApproval.ts`, `ApprovalsReviewer.ts`, `ThreadStartParams.ts`, `TurnStartParams.ts`, and `SandboxPolicy.ts`. The temporary metadata generation additionally confirmed `PermissionProfileListParams`, `PermissionProfileListResponse`, `PermissionProfileSummary` and `ActivePermissionProfile`.

Descriptions below summarize provider behavior. Labels and IDs are provider
terms; where the provider API has no user-facing name, ace uses the option name
and explains that it is a native option rather than claiming a named mode exists.

## Codex app-server

Codex has separate sandbox/profile, approval policy and reviewer controls. The
installed CLI lists `read-only`, `workspace-write`, `danger-full-access` sandbox
values, `on-request` and `never` approval policies, and `--approve-for-me` for
automatic review with workspace-write. Generated `AskForApproval` additionally
retains `untrusted` and a granular object. Current official documentation retires
`untrusted` as a selectable policy, so its presence in compatibility types is not
a reason to advertise it. `on-failure` is not in the installed type or help.
[Sandbox documentation](https://learn.chatgpt.com/docs/sandboxing) and installed
help/types.

The installed app-server also accepts real native permission profile IDs:

| Native ID                          | Provider meaning                                                  | Display risk                                          |
| ---------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------- |
| `:read-only`                       | Read-only local command execution                                 | low                                                   |
| `:workspace`                       | Writes in active workspace roots and native temporary directories | medium                                                |
| `:danger-full-access`              | No local sandbox restrictions                                     | high                                                  |
| A returned user-defined profile ID | Native configured filesystem/network rules                        | medium unless provider metadata establishes otherwise |

`permissionProfile/list` takes `cwd`, optional `limit` and pagination `cursor`.
It returns `data` entries with `id`, nullable `description`, and `allowed`, plus
`nextCursor`. Use allowed profiles and preserve the provider description. Named
profiles and the built-ins are selected through `permissions` on
`thread/start`, `thread/resume`, `thread/fork`, or `turn/start`; a profile cannot
be combined with legacy `sandbox` or `sandboxPolicy`. The profile API requires
`capabilities.experimentalApi`. Current config chooses a profile using
`default_permissions`; omission retains Codex's own effective configuration.
[Native profile documentation](https://learn.chatgpt.com/docs/permissions) and
[app-server profile discovery](https://learn.chatgpt.com/docs/app-server).

`ApprovalsReviewer` is `user | auto_review | guardian_subagent`. Its declaration
states that the default is `user`. `auto_review` uses a separate reviewer agent
for sandbox escalation decisions. The provider shows this as Approve for me;
this is distinct from workspace sandboxing or the older Auto label. It leaves
the sandbox boundary in place. It needs an interactive approval policy; setting
`never` leaves nothing to review. `guardian_subagent` is accepted by installed
types but lacks a separately verified public UI label or behavior description;
use its native ID as the label, without inventing guarantees.
[Auto-review documentation](https://learn.chatgpt.com/docs/sandboxing/auto-review)
and installed `ApprovalsReviewer`.

ace initially exposes built-in profiles before a live session, enriches that
list with allowed native profile results after opening, publishes those results
on the selected model-catalog instance, and serializes explicit
reviewer selections as native objects, for example
`{"permissions":":workspace","approvalsReviewer":"auto_review"}`. Plain
profile selection overrides only `permissions`; it does not rewrite the user's
approval policy or reviewer. The documented ordinary local sandbox default is
workspace-write, but native config/requirements can select another profile or
policy. ace does not replace them with a hardcoded default.

Thread configuration establishes subsequent turns. `turn/start` approval policy,
reviewer and profile overrides apply to that turn and subsequent turns; native
`turn/steer` has no corresponding mode override. Do not describe a queued next
turn selection as an immediate change to existing background operations.

Native server requests include `item/commandExecution/requestApproval`,
`item/fileChange/requestApproval`, `item/permissions/requestApproval`,
`item/tool/requestUserInput` and `mcpServer/elicitation/request`. Preserve offered
decisions, including session grants when native requests offer them. Respond to
the same JSON-RPC request ID; consume `serverRequest/resolved` to settle the
interaction. Automatic reviewer results belong to Codex, not an ace reviewer.
Installed generated request/response types and
[approval protocol](https://learn.chatgpt.com/docs/app-server).

## Claude Code / Agent SDK

The SDK native enum has six IDs. CLI `manual` is an alias for SDK/config
`default`; the installed help prints the alias, while the SDK requires the enum.

| Native ID           | Provider label     | Provider behavior                                                                                 | Display risk |
| ------------------- | ------------------ | ------------------------------------------------------------------------------------------------- | ------------ |
| `default`           | Manual             | Read operations can proceed; other operations follow native rules and approval prompts            | low          |
| `acceptEdits`       | Accept edits       | Native file edits and selected filesystem operations auto-approve                                 | medium       |
| `plan`              | Plan               | Native planning restrictions and plan review apply                                                | low          |
| `auto`              | Auto               | Claude's classifier handles permission decisions, subject to availability and provider safeguards | medium       |
| `dontAsk`           | Don't ask          | Actions needing a permission prompt are denied unless native rules already allow them             | low          |
| `bypassPermissions` | Bypass permissions | Skips ordinary permission checks; native managed/deny/interaction safeguards still apply          | high         |

Source: installed SDK `PermissionMode` and its option documentation,
[provider mode labels and behavior](https://code.claude.com/docs/en/permission-modes),
and [SDK permission evaluation](https://code.claude.com/docs/en/agent-sdk/permissions).

Set `Options.permissionMode` for session startup. Bypass requires
`allowDangerouslySkipPermissions: true`. In streaming input mode,
`Query.setPermissionMode(id)` changes the current session, including during
generation. The native SDK checks availability and provider policy; ace relays a
rejection rather than claiming a mode is active.

The provider's own default is conditional, and `default` means Manual rather
than "whatever the CLI would choose". The installed SDK documents omission as
loaded `permissions.defaultMode`, otherwise native `auto` where it is the
default, otherwise Manual. Current official docs distinguish SDK/`claude -p`
sessions that fetch feature flags, whose built-in default is Manual, from
sessions without them, whose default can be Auto starting in CLI 2.1.285.
Organization, model and managed settings can disable Auto. ace leaves the
option absent when no explicit override exists and observes native startup
state. This is why a universal `default: true` on Manual or Auto would be wrong.
Installed `Options.permissionMode` and
[startup default table](https://code.claude.com/docs/en/permission-modes#which-mode-a-session-starts-in).

`canUseTool` receives unresolved native permission requests after Claude's own
mode/rule evaluation. Keep it as a UI relay, return native allow/deny results,
and keep question/plan interactions. Remove ace's synthetic `PreToolUse` hook
that forces every call to ask, ace review decisions, and ambient-setting
rewrites added to enforce ace modes. Native rules, hooks and managed settings
remain the provider's responsibility. `auto` can still request human decisions;
`dontAsk` can deny without calling the callback. Installed callback/result types
and [SDK evaluation order](https://code.claude.com/docs/en/agent-sdk/permissions).

## OpenCode

OpenCode **2.0.22** exposes native rule effects, not named read-only/manual/auto
presets. A `PermissionRule` contains `action`, `resource` and
`effect: allow | deny | ask`. Session create and update accept rules. Native
agent and global configuration can supply more specific rules. The picker can
offer native `allow`, `ask` and `deny` applied to `action: "*", resource: "*"`;
the description must state that scope. `deny` is not read-only. It denies all
matching tools, including reads. No ace permission translator decides exceptions.
Installed `PermissionEffect`, `PermissionRule` and session input declarations.

An absent selection preserves native mixed defaults and configured agent rules.
Official docs describe most permissions as allow, outside-directory and repeated
tool-loop requests as ask, and sensitive environment-file reads as denied. A
single wildcard allow would overwrite that default, so it must not be selected
implicitly. Installed `opencode run --help` also has `--auto`, described as
approving permissions not explicitly denied; it is a run-command option, not a
verified additional session-rule enum. The docs' older `permission` object form
must not replace the installed v2 client's plural rules API.
[Permission configuration and defaults](https://opencode.ai/docs/permissions),
installed help and v2 client declarations.

Rules are session configuration and can change through session update. The
public declarations do not establish the exact timing for an already queued
tool, so ace applies its own selection at a settled session boundary rather
than claiming retroactive enforcement. Native `permission.asked` and
`permission.replied` events carry request/session identity. Replies are `once`,
`always`, or `reject` through `permission.reply`; forms/questions retain their
own native path. ace must no longer reject a provider-offered `always` answer
because of an ace mode. Installed request/reply/event declarations and
[native approval outcomes](https://opencode.ai/docs/permissions#what-ask-does).

## Cursor SDK

ace uses **@cursor/sdk 1.0.35**, not the separately installed Cursor CLI. The
SDK has no `PermissionMode` enum or human permission-decision callback. Its
independent native local options are `sandboxOptions.enabled` and `autoReview`,
both false by default. Encode the four combinations directly as opaque JSON
IDs using those two fields. The false/false entry is the native unconfigured
SDK default; other entries describe sandbox enabled, Auto-review, or both.
There is no native Manual SDK mode. Installed `LocalAgentOptions` and
`SandboxOptions`, plus [official SDK options](https://cursor.com/docs/sdk/typescript).

Native Auto-review uses Cursor's backend classifier. It can deny a call and let
the agent retry; it cannot stop for an ace human-approval card. The classifier
is conditional on backend availability. Enabling sandboxing is a separate
choice. Unsupported native sandbox setup errors must be shown; ace removes its
fallback that secretly substitutes a read/search tool allowlist. Tool selection
is a different option and cannot implement a promised native mode.
Installed option comments and
[SDK sandbox and Auto-review behavior](https://cursor.com/docs/sdk/typescript).

These are create/resume local-agent options, not a native per-turn or mid-turn
permission setter in the inspected public API. Apply a changed selection at a
settled restart/resume boundary. Keep execution-denial/error projection and
existing supported interactions, without synthesizing approval requests the SDK
does not provide. The CLI separately offers `--auto-review`, `--force`/`--yolo`,
`--sandbox enabled|disabled`, and plan/ask execution modes. Its interactive modes
must not be advertised as SDK capabilities. Installed `agent --help` and
[Cursor run modes](https://cursor.com/docs/agent/security/run-modes).

## Pi

Pi **0.85.1** has no built-in permission modes, per-tool approval API or OS
sandbox. It runs its configured tools with the process user's rights. Advertise
`permissionModes: []` and retain absent/null selection. `--tools`,
`--exclude-tools`, `--no-tools` and `--no-builtin-tools` select available tools.
`--approve` and `--no-approve` concern project resource trust. Neither is a
native permission mode. Remove ace's permission `tool_call` extension and its
synthetic approval protocol. Keep ace's history-control and MCP bridge
extensions where independently needed. Installed help,
[versioned security guide](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/security.md),
and [ADR 0050](0050-pi-local-rpc-adapter.md).

Native extension `select`, `input`, `editor` and `confirm` requests still become
questions; confirm is a yes/no question, not evidence of tool approval. Return
`extension_ui_response` with the native dialog ID and selected value or
confirmation. There is no Pi permission setter to invoke per session, turn or
mid-turn. [Versioned RPC guide](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/rpc.md).

## ACP agents, including Gemini, Copilot and Antigravity

ACP is a protocol, not a permission model. Its mode IDs, names, descriptions and
current value come from each session's `configOptions` or
`modes.availableModes/currentModeId`. Preserve exact values rather than deriving
permissions from names such as code, plan or unrestricted. An unadvertised
selector stays absent. `session/set_config_option` uses the actual advertised
config ID; the legacy mode path uses `session/set_mode` with its exact `modeId`.
ACP permits a mode change while idle or generating. Observe native mode/config
updates and only publish an applied choice after acknowledgement.
[Session modes](https://agentclientprotocol.com/protocol/v1/session-modes) and
[session config options](https://agentclientprotocol.com/protocol/v1/session-config-options).

All ACP agents use `session/request_permission` with provider-defined option
IDs and kinds such as allow_once or allow_always. ace returns the selected
native `optionId`, or cancellation, without an automatic reviewer or blanket
rejection of persistent scopes. These requests may cover only some actions;
ace stops publishing cross-provider enforcement guarantees.
[Permission request contract](https://agentclientprotocol.com/protocol/v1/tool-calls#requesting-permission).

The adapter's present native ACP kind is Antigravity, and registry profiles
also cover Gemini, Qwen, Claude/Codex bridges, Goose and Auggie. Copilot and any
other user-approved registry/custom agents use this same dynamic path. Known
interface evidence is:

| Agent/backend                        | Native interface evidence and default handling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gemini CLI 0.43.0                    | Installed `--approval-mode` choices are `default`, `auto_edit`, `yolo`, `plan`. Their help meanings are prompt, edit auto-approval, all-tool auto-approval, and read-only planning. Set at launch or via advertised ACP mode selection. `default` is ordinary prompt behavior; native settings may override. Copy ACP values from session metadata rather than assuming CLI spellings. [Official ACP guide](https://geminicli.com/docs/cli/acp-mode/) and [configuration](https://geminicli.com/docs/reference/configuration/).                                                                                                                     |
| Copilot CLI 1.0.68                   | Installed help has tool/path/URL allow and deny flags plus `--allow-all`/`--yolo`. `interactive`, `plan`, `autopilot` are agent modes and are not equivalent to permission grants. Current docs additionally describe permission IDs `default`, `assisted`, `allow-all`; installed help did not establish that exact catalog. Native default prompts when necessary. Use negotiated metadata and retain native startup config. [CLI reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference) and [ACP server reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server). |
| Antigravity `agy_acp_server`         | Not installed for this research. No exact static permission-mode set/default verified through permitted sources; use its actual advertised ACP metadata. Google's current CLI docs describe `toolPermission` values `request-review`, `proceed-in-sandbox`, `always-proceed`, `strict`, default `request-review`, but that CLI is a distinct backend from ace's ACP executable. Do not copy those values into the ACP catalog. [Official CLI reference](https://antigravity.google/docs/cli/reference/).                                                                                                                                            |
| Qwen 0.0.14                          | Installed help has `plan`, `default`, `auto-edit`, `yolo`; `auto` is absent. The old profile has no ACP mode setter or mode catalog, so no picker can claim those launch flags are negotiated selectors. Keep native startup configuration.                                                                                                                                                                                                                                                                                                                                                                                                         |
| Qwen 0.24.7 profile                  | Separate newer ACP implementation with mode negotiation. Do not apply newer mode/default claims to 0.0.14. Read live advertised values. [Pinned ACP interface](https://github.com/QwenLM/qwen-code/blob/b12edec1401a28fc53cd9e714d5928b285071fc8/packages/cli/src/acp-integration/acpAgent.ts).                                                                                                                                                                                                                                                                                                                                                     |
| Claude bridge 0.85.1                 | Source-defined `default`, `acceptEdits`, `plan`, `auto`, optional `bypassPermissions`, with provider names and descriptions. Actual model availability can change effective mode. Use the bridge's returned current mode/default, not the native adapter's startup assumptions. [Pinned session modes](https://github.com/agentclientprotocol/claude-agent-acp/blob/686c0c99b3b89217b74d1f5de8272e7c9ef1aab4/src/session-mode.ts).                                                                                                                                                                                                                  |
| Codex bridge 2.1.1                   | Source IDs `read-only`, `workspace-write`, `agent`, `agent-full-access`; names Read-only, Workspace access, Auto review, Full access. The bridge's own built-in default is `agent`, subject to its environment/config. These differ from app-server profile IDs. [Pinned mode interface](https://github.com/agentclientprotocol/codex-acp/blob/68d7d2d5ddfc0ed5746f9f6130892dda685e65dd/src/AgentMode.ts).                                                                                                                                                                                                                                          |
| Goose 1.53.0 profile                 | ACP modes derive from the native GooseMode variants and provider config; use advertised IDs/names/current value. It changes session mode through its native ACP setter and relays confirmation requests. [Pinned server](https://github.com/block/goose/blob/76da81cb964b21cd096db739302329b40c2998b8/crates/goose/src/acp/server.rs) and [profile research](../research/providers/acp-registry.md#goose).                                                                                                                                                                                                                                          |
| Auggie 0.36.0 profile                | Official docs establish `auggie --acp` but not a fixed permission catalog/default. This run did not inspect its app bundle or launch it. Native session metadata is authoritative; no assumed static list. [Official ACP guide](https://docs.augmentcode.com/cli/acp/agent).                                                                                                                                                                                                                                                                                                                                                                        |
| Any unprofiled registry/custom agent | No fixed permission catalog or default claim. Use the native session advertisement; empty until known. A registry entry's installation metadata alone does not establish permission behavior.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

No model invocation, auth operation, or new empty provider session was run to
complete this matrix. Per-instance metadata that requires a session becomes
available on the user's authorized session. Pre-session catalogs must therefore
distinguish unknown metadata from a verified empty mode list, and cannot claim
to know every custom configuration before connecting.

## Compatibility and one-time migration

Protocol changes are additive. Historical `PermissionMode`, guarantees and
review events can still parse for replay/old clients, but new writes contain
native IDs or an absent/null selection. Remove production enforcement and new
emission of the old semantics. Map legacy values at ingress and when loading
mutable stored defaults/overrides; persist the native result once. Do not rewrite
the immutable event log merely to rename historical review facts.

| Previous ace value | Codex                                                        | Claude SDK          | OpenCode rules                                                           | Cursor SDK                                                                                     | Pi                                              |
| ------------------ | ------------------------------------------------------------ | ------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `read-only`        | `:read-only`                                                 | `plan`              | `deny` wildcard, closest available restriction, explicitly not read-only | Sandbox enabled, Auto-review false, closest native option, explicitly permits workspace writes | Clear selection; no native equivalent           |
| `ask`              | `:workspace`, native user reviewer where explicitly selected | `default`           | `ask` wildcard                                                           | Sandbox enabled, Auto-review false; no SDK manual mode                                         | Clear selection; no native equivalent           |
| `auto-review`      | Workspace profile with `auto_review` reviewer                | `auto`              | `ask` wildcard; OpenCode has no native automatic reviewer enum           | Sandbox enabled, Auto-review true                                                              | Clear selection; no native equivalent           |
| `full-access`      | `:danger-full-access`                                        | `bypassPermissions` | `allow` wildcard                                                         | Sandbox disabled, Auto-review false                                                            | Clear selection; retain Pi native configuration |

Migration does not preserve protection that the old ace layer supplied through
synthetic gates. Descriptions must make the native behavior clear. For ACP,
legacy migration uses only advertised native values and a reviewed matching
profile; if no corresponding native choice is known, clear to the provider
default rather than inventing a selector or sending a foreign ID. A native ID
already present is not repeatedly interpreted as an ace mode. Scope the
migration to provider/backend and record the new representation so overlapping
words such as read-only or ask cannot trigger repeat migration.

## ace tools and credentials remain separate

This decision does not grant permission to ace's own Mac/browser tools. Thread
MCP leases, computer-control consent, screen access, browser-origin grants,
human control handback and OS permission prompts remain independently owned by
ace. Their consent does not depend on a provider's selection. A provider Full
access or bypass choice cannot approve an ace browser origin or acquire the
computer lease. Keep those interactions on ace's own consent path, without
routing ordinary provider tool requests through it.
[ADR 0010](0010-ace-mcp-server.md),
[ADR 0011](0011-screen-and-computer-use.md), and
[browser consent](0054-desktop-shell.md#thread-browser-origin-consent).

[ADR 0002](0002-local-cli-providers.md) and its accepted official local SDK login
amendment remain unchanged. Provider authentication and secret persistence stay
inside the user's CLI or authorized local SDK. Permission discovery reads public
metadata, not credential files. No hosted ace provider proxy or ace credential
collection is introduced.

## Verification and remaining limits

Root turns retain the selected provider and acknowledged native mode on their
run record. Historical runs and native children whose selection is unknown omit
that metadata; ace does not infer a child mode from its parent's picker.

Behavior tests must prove native IDs/options reach fake provider boundaries,
catalogs carry native descriptors, old stored settings migrate once, provider
switches clear invalid selections, and approvals/questions round-trip with the
offered native option. Remove tests whose purpose was ace review decisions,
permission rank ceilings, synthetic gates or coverage guarantees. Keep tests for
whole-tree status and durable interaction delivery.

This research verifies interfaces, not real-provider execution. Classifier
availability, managed policy, configured defaults, native mid-turn timing and
custom ACP catalogs depend on the actual provider instance. The native provider
remains the authority and may reject a selected mode. Fake contract tests cannot
prove a sandbox or classifier's real runtime enforcement. Recording and paid
provider turns remain separate owner-authorized work.
