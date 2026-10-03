# Cursor SDK audit for ace

Implementation status: the SDK-first adapter and preserved ACP fallback are documented in [the package README](../../../packages/adapter-cursor/README.md). [Assembly and verification limits](../../integration/cursor-sdk-verification.md) remain explicit; no SDK fixtures are approved or recorded. The historical ACP evidence below remains unchanged.

Researched 2026-10-02. Accepted decision: [ADR 0043](../../adr/0043-cursor-sdk-local-runtime.md).

## Decision and recommendation

Use **`@cursor/sdk`'s local runtime** for new Cursor threads, with ace's event log
as canonical history and SDK checkpoints for native continuation. The owner
accepted this choice on 2026-10-02. The SDK supplies structured failures, tool
names, token usage and session history. It embeds a local runtime rather than
driving the installed `cursor-agent`; its login is separate from editor and CLI
login. S-auth, S-local, S-run, S-messages, S-store in the [source index](#primary-source-index).

This changes the original ACP-retention recommendation. The
[official SDK login amendment to ADR 0002](../../adr/0002-local-cli-providers.md#amendment-official-sdk-logins)
authorizes SDK-owned per-instance browser sign-in and environment-only API keys.
ace remains local and never holds provider credentials in its own storage or
client protocols. Cloud execution is available in the SDK, but ace selects only
local execution; this decision adds neither Cursor Cloud nor hosted ace.

The price is reduced human interaction and incomplete child transcripts. The
inspected runtime denies requests needing human approval, rejects questions, and
accepts plan creation without a review callback. Sandbox plus Auto-review is the
chosen policy, advertised as `approvals: "sandbox-only"`. Task children are
read-only tree projections. Steering uses interrupt/restart under one ace run;
forks use a portable-context handoff to a fresh agent. These are ace decisions,
not claims of native SDK feature parity. S-local, S-options, S-deltas; [ADR 0043](../../adr/0043-cursor-sdk-local-runtime.md).

Keep generic ACP for registry agents, existing Cursor ACP threads and fallback
when the SDK is absent. Resume identities stay tied to their original backend.
On-disk CLI transcripts remain a possible lossy import source; they are neither
SDK continuation state nor evidence of live completion. [Existing recordings](../fixtures/cursor.md), sections 2 and 5; S-store; C-storage.

As requested by the owner, only t3code's
[public Cursor user documentation at commit `de343914`](https://github.com/pingdotgg/t3code/blob/de343914273eceb852a1d1d739cd1d38df7796ee/docs/user/cursor.md)
was read to understand its published integration approach. That document describes
local SDK execution, separate sign-in, policy-based execution and projected task
children. It is primary evidence of t3code's user-facing approach, not authority
for Cursor API claims. No t3code implementation was read or copied. The SDK
findings below come from Cursor's own docs and published package.

## What “Cursor SDK” means

| Product                                                                 | Evidence and meaning                                                                                                                                                                                                                                                              | Relationship to the installed CLI                                                                                                                                 |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@cursor/sdk`                                                           | Official TypeScript package, npm `latest` **1.0.35**, published `2026-10-01T01:25:07.460Z`. Official docs name this package; registry metadata and its published implementation were inspected. S-registry, S-package; [TypeScript docs](https://cursor.com/docs/sdk/typescript). | Local mode embeds Cursor's local executor; cloud mode calls Cursor's API. No executable-path option or CLI-supervision API in `AgentOptions`. S-options, S-local. |
| `@cursor/sdk-{darwin-arm64,darwin-x64,linux-arm64,linux-x64,win32-x64}` | Matching 1.0.35 optional platform packages for native helpers, not five independent agent SDKs. S-package, `optionalDependencies`.                                                                                                                                                | Helpers for SDK tool execution; not an installed `agent` wrapper. S-local, vendored binary resolution.                                                            |
| `@cursor/february`, `@cursor/july`                                      | February 1.0.7 describes an older private-alpha agent SDK; July 0.2.18 is a bot development kit depending on `@cursor/sdk` 1.0.35. Their published code was also checked. S-other.                                                                                                | Neither provides a separate CLI-login route. July's SDK runner requires an API key.                                                                               |
| `cursor-sdk`                                                            | Official Python SDK, linked by Cursor's docs and `cursor/sdk-bridge`; bridge protocol manifest also reports 1.0.35. Python uses a local bridge embedding the TypeScript library. [Python docs](https://cursor.com/docs/sdk/python); B-manifest, B-protocol.                       | A local bridge process is not the user's logged-in CLI.                                                                                                           |
| `cursor/sdk-bridge`                                                     | Official public protobuf/Connect bridge contract, `sdk.v1`, with local and cloud operations and custom-tool/store callbacks. GitHub HEAD inspected at `d932194bcaf3d8ca4cae7373dfec32633ed0c9d0`. B-manifest, B-services.                                                         | Runs an SDK host locally and connects to Cursor services. It does not convert SDK auth into `agent login` reuse. B-protocol, S-auth.                              |
| Cloud Agents REST API                                                   | Durable agents plus per-prompt runs; v1 is public beta and accepts user/service-account API keys through Basic or Bearer authentication. [Official endpoints](https://cursor.com/docs/cloud-agent/api/endpoints).                                                                 | Separate cloud control plane; not a wrapper around local ACP.                                                                                                     |

Search coverage was npm's registry search for `@cursor`, `scope:cursor` and `@cursor/sdk`, the direct `@cursor/sdk` packument, Cursor's TypeScript/Python/Bridge docs and SDK/CLI changelogs, and the public `cursor` GitHub organization. `scope:cursor` returned zero results; the broader `@cursor` search found the scoped SDK and sibling packages. This is a bounded search, not an exhaustive namespace inventory. The official SDK identity is established by Cursor's own documentation and public `sdk-bridge` repository, not by trusting a package name or publisher username. S-registry, S-other; [Cursor org API](https://api.github.com/orgs/cursor/repos?per_page=100&type=public), [SDK bridge](https://github.com/cursor/sdk-bridge), [SDK changelog](https://cursor.com/docs/sdk/changelog), [CLI changelog](https://cursor.com/docs/cli/changelog).

The npm package's repository metadata points to `cursor/cursor`; its published runtime contains bundled internal `@anysphere/*` modules. `sdk-bridge` publishes the protocol, not the TypeScript agent-loop source as a normal source checkout. Read the npm tarball for implementation evidence. The SDK's license is “SEE LICENSE IN LICENSE.md”; that file refers to Cursor's terms and reserves rights. The bridge repo's MIT license does not license the npm implementation. No implementation was copied into ace. S-package, S-license, B-manifest.

## Authentication and process ownership

The decisive distinction is **local execution versus local CLI integration**.

1. `resolveDefaultApiKey()` resolves explicit `apiKey`, then `CURSOR_API_KEY`, then the SDK's stored login key. `getStoredLoginApiKey()` reads and validates the SDK auth file, checks expiry and backend identity, and caches the result briefly. It does not read the CLI's OAuth credential store. S-auth, published `index.js` module `src/agent/auth/stored-credentials.ts`; [official authentication description](https://cursor.com/docs/sdk/typescript#cursorauth).
2. `Cursor.auth.login()` performs browser sign-in, uses the resulting session token to mint an expiring user API key, and returns that key. The default `FileCredentialStore` writes `~/.cursor/sdk/auth.json`; `store: null` still returns a key to the caller. In-memory storage changes persistence, not the authentication boundary. S-auth, `sdkLogin`, `SdkLoginResult`, `StoredSdkCredentials`, `FileCredentialStore`.
3. `createLocalExecutor()` builds the workspace runtime, tool executors and subagent sessions inside the Node host and uses API-key auth against Cursor services. This is not a `spawn(agent, ...)` adapter. Shell tools, MCP processes and native sandbox helpers can still spawn children. S-local, module `src/agent/local-executor.ts`, exported function `createLocalExecutor`; S-options, `LocalToolExecutor`, `LocalAgentOptions`.
4. There is consequently no CLI launch/readiness/exit lifecycle for ace to supervise through this SDK. An SDK host would need explicit run cancellation, resource disposal, and probably its own supervised sidecar to isolate faults. `SDKAgent.close()` initiates disposal; `[Symbol.asyncDispose]()` can be awaited. The Python bridge has a readiness handshake and shutdown RPC, but supervises an SDK process, not Cursor CLI. S-agent, S-run; B-protocol.
5. ACP instead launches the user-resolved `agent acp`. The initialize-only probe below advertises `cursor_login` and explicitly describes reuse of existing CLI credentials. ace can tell a logged-out user to run `agent login` outside ace. [ACP docs](https://cursor.com/docs/cli/acp#authentication); [probe](#prompt-free-local-evidence); T-adapter, `createAcpAdapter`.

Under the accepted amendment, the SDK owns browser login and all provider
credential persistence and authenticated requests. ace supervises an isolated
host and exposes safe auth status. Discard `SdkLoginResult.apiKey` inside that
host. The daemon, event log, frame recorder, clients and account registry never
receive key-bearing login results or credential-store contents. User keys enter
only through the launch environment, which the SDK reads directly. This is an
explicit architecture change, not evidence of CLI credential reuse.
[ADR 0002 amendment](../../adr/0002-local-cli-providers.md#amendment-official-sdk-logins); S-auth.

A critical isolation detail is that `login`, `status` and `logout` can accept a
custom `FileCredentialStore`, but `resolveDefaultApiKey()` reads the **default**
SDK path and caches the stored key process-wide for five seconds. Passing a
custom store to login does not wire it into `Agent.create()`. Start each SDK host
with the selected instance's private home before importing the SDK, and use that
host's default store. The accounts contract places Cursor's `HOME` at
`<instance.homeDir>/user`, yielding
`<instance.homeDir>/user/.cursor/sdk/auth.json` on the inspected macOS/Linux path.
Verify Windows home resolution for the pinned runtime before claiming support.
This host design is an inference from S-auth and A-instances, not an SDK-managed
multi-account feature.

The SDK store uses directory mode 0700 and file mode 0600, subject to Windows chmod
handling. `Cursor.auth.logout()` removes the local credential file and clears its
cache; it does not revoke the minted key or delete conversation history. Stop
selected-instance hosts before logout. Revocation is in Cursor's dashboard. An
inherited environment key takes precedence and remains active until removed from
the launch environment. S-auth, `FileCredentialStore.save`, `clear`, `sdkLogout`.

Accounts PR #25 currently strips ambient `CURSOR_API_KEY` in `instanceEnv`.
Implementation therefore needs a narrow SDK-only environment inheritance policy
and an SDK auth driver at the accounts boundary. Persist only instance identity
and safe auth status, never a key or key-bearing environment value. Preserve
instance pinning on resume and the isolation rules for every other provider.
A-instances, A-service, A-login; [accounts ADR 0018](https://github.com/arpan404/ace/blob/a30aa2c85849b92ee471f0ccc6147f0b3a6f6492/docs/adr/0018-accounts-and-session-portability.md).

## API inventory of the local SDK

These are published API and source findings, **not model-turn observations**. No SDK agent was created or sent input during this audit.

| Need                 | API and limits at 1.0.35                                                                                                                                                                                                                                                                                                                                                                                              | Primary evidence                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Agents and sessions  | `Agent.create`, `Agent.resume`, `Agent.list`, `Agent.listRuns`, `Agent.getRun`, `Agent.cancelRun`, `Agent.messages.list`. `SDKAgent.send()` returns a `Run`; multiple sends reuse an agent's conversation. Local state belongs to the SDK's store.                                                                                                                                                                    | S-stubs, S-agent, S-store.                                                                                            |
| Streaming            | `run.stream()` yields `SDKMessage`: system, user, assistant, thinking, tool_call, status, task, request, usage. `SendOptions.onDelta` gives converted SDK interaction updates and `onStep` gives completed steps. These callbacks do not expose every native provider frame. `run.wait()`, `run.conversation()`, status listeners and capability checks are public.                                                   | S-messages, S-agent, S-run.                                                                                           |
| Tools and failures   | `call_id`, actual `name`, running/completed/error status, opaque args/results and truncation flags. `RunResult.error` has message and optional code. Exceptions include auth, rate-limit, network, busy and configuration errors.                                                                                                                                                                                     | S-messages, S-run, S-errors.                                                                                          |
| Approvals            | No `canUseTool` or equivalent permission callback in public options. Internal `requestApproval` rejects a request needing a human. Default execution is unrestricted; sandbox/auto-review can deny calls. Custom-tool `execute` callbacks execute caller-defined tools, not approval decisions for built-in tools.                                                                                                    | S-options, `LocalAgentOptions`; S-local, internal class `o_`, `requestApproval`, workspace permissions construction.  |
| Questions and plans  | Local executor rejects `askQuestionInteractionQuery`; `createPlanRequestQuery` returns success with an empty plan URI. File hooks are policy mechanisms, not an SDK interaction callback. A `request` event type alone does not establish an answer API.                                                                                                                                                              | S-local, `createLocalExecutor` query switch; S-messages; [hooks docs](https://cursor.com/docs/sdk/typescript#hooks).  |
| Subagents            | Named `AgentDefinition`s, task execution and nested children exist. `local.subagentInherit` controls executor/workspace/tool-filter inheritance. Nested task deltas expose text and tool start/completion one level down; deeper nested tool deltas are dropped, and nested shell/edit deltas are omitted. No high-level `parentId` or per-child transcript method comparable to ACP child-session routing was found. | S-options, `AgentDefinition`, `LocalSubagentInherit`; S-deltas, `NestedTaskUpdateSchema`; S-messages.                 |
| Background children  | The current executor drains background child results through parent follow-up turns. This improves on the SDK's earlier behavior, but is not proof that every shell or descendant has stopped when `wait()` resolves.                                                                                                                                                                                                 | S-local, `createLocalExecutor`, background follow-up loop; [1.0.31 changelog](https://cursor.com/docs/sdk/changelog). |
| Models and modes     | `Cursor.models.list()` yields models, parameters and variants under SDK auth. Local creation requires a model selection; successful send overrides update the handle's model. `AgentModeOption` is `agent` or `plan`; no public `ask` mode in this version.                                                                                                                                                           | S-options, S-agent, S-stubs.                                                                                          |
| Steering and cancel  | Optional `run.steer(text)` resolves `complete_delivered` or `revert_to_followup`. Delivery ownership transfers only on the first result. This is a local live-run feature; detached/cloud handles fall back. `run.cancel()` is public, but is not an individual subagent/task-stop API.                                                                                                                               | S-run; S-local, steer handling; [steering docs](https://cursor.com/docs/sdk/typescript#steering-a-run-in-flight).     |
| Resume and fork      | `Agent.resume` restores SDK-owned checkpoints. No public fork operation or CLI/ACP-store import operation found in `Agent`, `SDKAgent`, `Run`, `AgentOptions` or the bridge agent service. ace implements a context handoff to a fresh agent; this is not a native checkpoint fork.                                                                                                                                   | S-stubs, S-agent, S-run, S-options; B-agent.                                                                          |
| Usage and limits     | Per-turn `usage` messages; cumulative `run.usage`/`RunResult.usage`; `getUsage()` supplies billed token/cost records. Local entries use usage UUIDs, not client run IDs. `RateLimitError` is useful failure evidence, not an account quota-window feed. No public account rate-limit snapshot API found.                                                                                                              | S-messages, S-usage, S-agent, S-errors, S-stubs.                                                                      |
| History and recovery | `LocalAgentStore` composes agents, runs, events and checkpoint blobs; JSONL and SQLite implementations exist. `Agent.messages.list`, `listRuns`, `getRun` and `conversation()` read SDK history. SDK IDs/stores are separate from ACP IDs/stores.                                                                                                                                                                     | S-store, S-stubs, S-run; C-storage.                                                                                   |

## Comparison with the findings in cursor.md

ACP evidence here comes from the installed bundle and existing raw fixtures, not from assuming the generic ACP schema is implemented. The [fixture analysis](../fixtures/cursor.md) corrects several earlier code-reading assumptions in [cursor.md](cursor.md).

| Finding                      | ACP today                                                                                                                                                                                                                                                                 | SDK today                                                                                                                                          | Consequence for ace                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Subagent tree                | `_meta.subagents` enables spawned/state updates; child content carries its own session ID. Background child keeps the prompt open in existing recordings. C-tree; F-subagent.                                                                                             | Rich task execution but limited nested delta fidelity; high-level events lack parent linkage. S-deltas, S-messages, S-options.                     | Show SDK task children read-only with summary/placeholder fidelity. Keep unresolved background children live.        |
| Turn failure                 | Runtime failure is diagnostic text followed by `end_turn`, so success cannot be inferred from stop reason. C-errors.                                                                                                                                                      | `RunResult.error`, typed exceptions and error status. S-run, S-errors.                                                                             | Use typed SDK errors. Never treat a terminal event as proof that the whole tree settled.                             |
| Tool failure and identity    | Provider reports completion; ace must inspect `rawOutput.error`, rejection, denial or nonzero exit. Mostly no raw tool name. C-tools; T-tools.                                                                                                                            | Tool name plus `error` status, opaque args/results with truncation flags. S-messages.                                                              | Use SDK identity/status and preserve opaque output, including truncation markers.                                    |
| Mid-turn steering            | A second prompt cancels the first; ace queues input. C-prompt; T-session, `drain`.                                                                                                                                                                                        | Live local `steer` with acknowledgement and follow-up fallback. S-run.                                                                             | Choose interrupt/restart under the same ace run, despite optional native SDK steering. Keep backend policy explicit. |
| Human interactions           | Permission RPC plus Cursor question/plan requests. Existing plan rejection fixture exercises the bidirectional path; the approval/question recordings did not actually request their named feature. C-interactions; F-plan, F-approval.                                   | No interactive approval callback; questions rejected; plan creation auto-accepted. S-local.                                                        | Accept the loss. Advertise sandbox-only approvals; no fake question, approval or plan-review prompts.                |
| Token usage                  | No `usage_update` in bundle or recordings. C-errors, F-tool.                                                                                                                                                                                                              | Per-turn/cumulative usage and billed lookup. S-usage, S-agent.                                                                                     | Use SDK usage on SDK threads; ACP fallback remains unavailable. Billed lookup is separate from token totals.         |
| Rate limits and network      | ACP exposes no structured retry/connection events. C-errors.                                                                                                                                                                                                              | Typed rate/network failures and local retry option; no account quota-window API found. S-errors, S-options.                                        | Report SDK rate/network failures; keep account quota windows unknown without independent evidence.                   |
| Models and modes             | Parameterized picker opt-in; agent/plan/ask recorded, and model selection is process-global. C-models; F-tool, seq 3.                                                                                                                                                     | Per-agent/per-send model config, agent/plan modes, API-key catalog. S-options, S-agent.                                                            | Use per-agent SDK settings and SDK catalog through `@ace/models`; do not offer local ask mode.                       |
| Resume/fork                  | `session/load` for ACP-created stores; no native fork. C-storage.                                                                                                                                                                                                         | SDK checkpoint resume; no public fork or ACP conversion found. S-stubs, S-store.                                                                   | Pin existing ACP IDs to ACP. Resume SDK checkpoints; fork through explicit context handoff.                          |
| Transcripts                  | Recordings found no root ACP JSONL transcript; child transcripts appeared at top-level child-ID paths. TUI transcript content is lossy. C-storage; F-subagent, seq 92; [fixture corrections](../fixtures/cursor.md#2-open-questions-in-cursormd-and-the-recorded-claims). | SDK store/events/checkpoints and history reads, not CLI history readers. S-store, S-stubs.                                                         | Keep ace events canonical and SDK history as reconciliation input. CLI import remains partial and separate.          |
| Cancellation and hidden work | Child disconnect does not prove termination; background shells can look completed while still running. F-background, F-interrupt; C-tree.                                                                                                                                 | Run cancellation and background follow-up processing exist; no separately addressable background-task inventory/control API found. S-run, S-stubs. | Keep uncertain work visible. Neither SDK terminal status nor ACP `end_turn` alone proves tree completion.            |

## Version, stability and operational risks

`latest` is 1.0.35; the registry's `next` tag remains `1.0.27-beta.0`, so `next` is not the newest build. Node requirement is `>=22.13`; ace's Node 24 satisfies it. Exports include ESM/CJS, `/sqlite` and bundled entries; Bun resolves to the flat build. Runtime dependencies include Zod 3.25, separate from ace's Zod 4 schemas. These are published package facts, not reasons to change ace's runtime or protocol package. S-registry, S-package.

The published changelog currently stops at 1.0.31, behind npm. It documents recent fixes to browser login, local billed usage, long-running credential refresh, streaming and background follow-ups. Stable version numbering is not evidence of full CLI feature parity. S-registry; [SDK changelog](https://cursor.com/docs/sdk/changelog).

The bridge promises additive `sdk.v1` wire compatibility, while the SDK tool payloads remain opaque. Some docs lag implementation: bridge prose still calls usage cloud-only and shows `local.cwd` as an array, while 1.0.35 types allow local billed usage and use `cwd: string` plus `dirs`. Treat published versioned code as the deciding source. S-agent, S-options; B-versioning, B-services.

SDK local resume needs durable checkpoint storage. Dropping a bridge stream does not cancel a run, and live `Send` offsets cannot safely be reused as durable `ObserveRun` offsets. The SDK adapter needs recovery deduplication and crash reconciliation. The bridge offset caveat is specific to bridge consumers; ace selects the direct TypeScript SDK. B-streaming; S-store. These findings have not been tested against a live model run.

History paging has an important implementation limit. In 1.0.35,
`CursorAgentPlatform.getAgentMessages()` loads
`checkpointStore.getFullConversation(agentId).turns` **before** applying
`offset`/`limit`. Paging bounds returned data, not SDK heap. Its history UUID is
synthesized as `${agentId}:${offset + index}`, while live
`SDKAssistantMessage` has no message ID. A shared stable message identity across
streams and snapshots cannot be assumed. Recovery needs persisted segment/order
provenance, snapshot revision checks and an explicit memory budget in an isolated
host. Ambiguous snapshots must not append duplicate text or collapse equal
messages from different turns. S-history, S-messages. These are source-derived
implementation constraints, not measured runtime behavior.

## Migration from integration/train-1

Inspected `origin/integration/train-1` at **`8d98459e20c181d93abb269cc12d1df5a28ff75a`**, after `git fetch origin integration/train-1`. This is a bounded source audit, not a verification that the integration branch passes tests.

The train already resolves the installed `agent`, spawns ACP through provider-kit, opts into Cursor subagents/models, translates vendor requests, queues sends, detects raw tool failures, and retains cancellation uncertainty. Discovery still advertises Cursor capabilities from a date-shaped version string. Session initialization checks protocol v1 but does not require the advertised subagent capability. General history scan explicitly returns Cursor unsupported. T-adapter, T-session, T-quirks, T-routing, T-tools, T-history.

The migration adds the SDK adapter while preserving ACP-owned history and
continuation. It requires coordinated engine and accounts changes, rather than
an SDK package substitution:

1. Add `packages/adapter-cursor` with an exact `@cursor/sdk` 1.0.35 pin, pure
   translator and supervised Node SDK host. Extend discovery to identify the SDK
   separately from the CLI and gate its version before opening a turn. Register
   SDK-first selection for new Cursor threads; use ACP only on package absence.
   Keep generic ACP registry and Antigravity paths intact. T-adapter, T-daemon;
   S-package; [ADR 0007](../../adr/0007-adapter-and-engine-contract.md).
2. Store backend identity with the native session and provider instance. Existing
   Cursor ACP threads remain on `session/load`; SDK threads use `Agent.resume`
   with their own durable store. Offer migration as a bounded portable-context
   handoff into a fresh SDK agent, preserving source provenance and history.
   Neither SDK auth errors nor unknown versions authorize automatic ACP downgrade.
   C-storage, S-store, S-stubs; A-service; [ADR 0043](../../adr/0043-cursor-sdk-local-runtime.md).
3. Integrate SDK login/status/logout with accounts' private homes. Isolate SDK
   imports and caches in child processes; narrowly allow the user's environment
   key into the selected SDK host. Preserve account pinning, writer reservations
   and safe status. SDK logout removes only its auth store, and dashboard
   revocation stays external. A-instances, A-service, A-login; S-auth.
4. Add honest `approvals: "sandbox-only"` capabilities and distinguish native
   controls from ace's steering/fork policies. SDK restricted mode enables
   sandbox plus Auto-review; full access disables sandbox. Persist restart
   segments under one ace run, including pending input and cancellation
   uncertainty. Expose SDK task children read-only and reduce status over the
   entire tree. S-options, S-local, S-run, S-deltas; [ADR 0004](../../adr/0004-canonical-agent-model.md).
5. Use ace's existing thread-scoped MCP server and public injection helper.
   SDK custom tools execute host callbacks outside the normal approval path, so
   they are not the integration mechanism. Keep SDK checkpoint state private to
   the instance; reconcile `messages.list` snapshots with ace events using stable
   identities and bounded pages. CLI transcript import stays unsupported for
   automatic SDK continuation. S-options, `customTools`; S-stubs, S-store;
   [MCP owner](../../../packages/mcp-server/README.md).
6. Extend the recorder with SDK-boundary frames, keep all ACP recordings versioned,
   and add replay expectations plus offline behavior tests. Record `composer-2.5`
   scenarios only after the owner approves the list in the implementation brief.
   No recordings ran during this research. [ADR 0007](../../adr/0007-adapter-and-engine-contract.md).

Task-child association needs special care. High-level `SDKTaskMessage` lacks a
child ID. Task tool args/results can carry `agentId`; results may also carry
`isBackground`, `backgroundReason` and `transcriptPath`. Use the owning call ID
for a provisional child, then associate its native identity when observed. A
background dispatch result does not prove child completion. Nested delta
conversion exposes one level and omits deeper tool-call, shell-output and edit
deltas. Declare summary or placeholder fidelity, preserve unknown payloads and
keep unresolved work conservative. S-task, S-deltas, S-local,
`LocalSubagentHostAdapter.awaitBackgroundWorkers`.

The self-contained worker handoff is `/tmp/ace-orch/impl-cursor-brief.md`. It names
packages, boundary capture, behavior tests, memory limits and the quota-spending
fixture scenarios for owner approval. These changes are a future implementation
scope; this PR contains documentation only.

## Prompt-free local evidence

All commands ran on 2026-10-02 in this worktree. Each `--version` was invoked independently; none starts a model turn.

| Command              | Output                  |
| -------------------- | ----------------------- |
| `codex --version`    | `codex-cli 0.159.1`     |
| `opencode --version` | `opencode v2.0.22`      |
| `agent --version`    | `2026.09.26-dd393fe`    |
| `claude --version`   | `2.1.286 (Claude Code)` |
| `gemini --version`   | `0.43.0`                |
| `qwen --version`     | `0.0.14`                |

`agent --help` describes print/stream-json, modes, model, resume, login and worker commands. `agent help acp` describes the ACP server; ACP is absent from the top-level command list. `agent` resolved to `/Users/arpanbhandari/.local/bin/agent`. The launcher and bundle inspected are under `/Users/arpanbhandari/.local/share/cursor-agent/versions/2026.09.26-dd393fe/`.

One fresh process in an empty temporary directory received only this JSON-RPC request, then was terminated after the reply. No `authenticate`, session creation/load, prompt, model turn or recorder was run.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "clientInfo": { "name": "ace-cursor-sdk-research", "version": "0.0.0" },
    "clientCapabilities": {
      "fs": { "readTextFile": false, "writeTextFile": false },
      "terminal": false,
      "_meta": { "subagents": {}, "parameterizedModelPicker": true }
    }
  }
}
```

The response returned protocol 1, `loadSession:true`, HTTP/SSE MCP support, image input, and `sessionCapabilities:{list:{},subagents:{}}`. Its auth method was `cursor_login`, described as existing Cursor login credentials with `agent login` as the prerequisite. Exact request/response artifact: `/tmp/ace-orch/cursor-sdk-initialize.json`. This verifies advertisement and startup only, not child streaming, permissions, auth success or completion behavior.

## Primary source index

All npm file citations below mean **the extracted 1.0.35 package**, not a mutable `latest` URL. Downloaded without installation or lifecycle scripts from [the npm tarball](https://registry.npmjs.org/@cursor/sdk/-/sdk-1.0.35.tgz). Integrity reported by npm: `sha512-CJQR4ocRFm74N1miSqSSrhWyEbvTRIJGyMfHQvZlcBIYzLMXCVPmb1bV82L4NJ8mG9TyvbckEjERjbnzpG5akQ==`. Extraction root: `/tmp/ace-orch/cursor-sdk-source/package`. Registry snapshot: `/tmp/ace-orch/cursor-sdk-source/registry.json`.

- **S-registry**: [npm packument](https://registry.npmjs.org/@cursor%2fsdk), `dist-tags`, `time`, version `1.0.35`; [scope search](https://registry.npmjs.org/-/v1/search?text=scope%3Acursor&size=250).
- **S-other**: [broader npm search](https://registry.npmjs.org/-/v1/search?text=%40cursor&size=250); [February 1.0.7 tarball](https://registry.npmjs.org/@cursor/february/-/february-1.0.7.tgz), `package.json`, `dist/esm/options.d.ts`, `AgentOptions`, `dist/esm/local-executor.d.ts`, `createLocalExecutor`; [July 0.2.18 tarball](https://registry.npmjs.org/@cursor/july/-/july-0.2.18.tgz), `package.json`, `dist/internal/sdk-runner.js`, `CursorSdkRunner.requireApiKey`.
- **S-package**: `package.json`, version, exports, engines, dependencies, optionalDependencies and license.
- **S-license**: `LICENSE.md`, Cursor SDK license and terms link.
- **S-auth**: `dist/esm/auth/{stored-credentials,credential-store,login}.d.ts`; `dist/esm/index.js`, embedded `src/agent/auth/{stored-credentials,credential-store,login,login-flow}.ts`, `resolveDefaultApiKey`, `getStoredLoginApiKey`, `sdkLogin`, `getDefaultSdkAuthPath`.
- **S-local**: `dist/esm/689.js`, embedded `src/agent/local-executor.ts`, `createLocalExecutor`, internal `o_.requestApproval`, interaction-query switch, subagent/background execution and disposal. Embedded source names are locators, not public import paths.
- **S-options**: `dist/esm/options.d.ts`, `AgentOptions`, `AgentModeOption`, `LocalAgentOptions`, `AgentDefinition`, `LocalSubagentInherit`, `SDKCustomTool`.
- **S-agent**: `dist/esm/agent.d.ts`, `SDKAgent`, `SendOptions`, `GetUsageOptions`, `CursorRequestOptions`.
- **S-stubs**: `dist/esm/stubs.d.ts`, public `Agent` and `Cursor` declarations. Despite the filename, the runtime `index.js` implements these APIs; do not infer nonimplementation from the name.
- **S-run**: `dist/esm/run.d.ts`, `Run`, `RunResult`, `RunOperation`, `SteerAckOutcome`.
- **S-messages**: `dist/esm/messages.d.ts`, `SDKMessage`, `SDKToolUseMessage`, `SDKRequestMessage`, `SDKUsageMessage`.
- **S-history**: `dist/esm/index.js`, `CursorAgentPlatform.getAgentMessages`, full-conversation load before page slicing and positional `AgentMessage.uuid`; `dist/esm/messages.d.ts`, `SDKAssistantMessage`.
- **S-task**: `dist/esm/vendor/cursor-sdk-shared/tool-call-types.d.ts`, `TaskArgsSchema`, `TaskSuccessSchema`; `dist/esm/messages.d.ts`, `SDKTaskMessage`; `dist/esm/689.js`, local Task conversion and `LocalSubagentHostAdapter.awaitBackgroundWorkers`.
- **S-errors**: `dist/esm/errors.d.ts`, `CursorSdkError`, `RateLimitError`, `NetworkError`, `AgentBusyError`.
- **S-usage**: `dist/esm/usage-types.d.ts`, `TokenUsage`, `AgentUsage`, `RunUsage`, `UsageCost`.
- **S-deltas**: `dist/esm/vendor/cursor-sdk-shared/delta-types.d.ts:9607`, `NestedTaskUpdateSchema` and its fidelity comment; `dist/esm/types/delta-types.d.ts`, `InteractionUpdate`.
- **S-store**: `dist/esm/store/{local-agent-store,open-default-local-agent-store,sdk-state-root,jsonl-local-agent-store,sqlite-local-agent-store}.d.ts`, `LocalAgentStore`, `openDefaultLocalAgentStore`, `getDefaultSdkStateRoot`; `dist/esm/run-store-public-types.d.ts`, run/checkpoint contracts.

Bridge references are pinned to the inspected public commit:

- **B-manifest**: [proto/manifest.json](https://github.com/cursor/sdk-bridge/blob/d932194bcaf3d8ca4cae7373dfec32633ed0c9d0/proto/manifest.json).
- **B-protocol**: [docs/protocol.md](https://github.com/cursor/sdk-bridge/blob/d932194bcaf3d8ca4cae7373dfec32633ed0c9d0/docs/protocol.md), bridge process/auth lifecycle.
- **B-services**: [docs/services.md](https://github.com/cursor/sdk-bridge/blob/d932194bcaf3d8ca4cae7373dfec32633ed0c9d0/docs/services.md), service roles and callbacks.
- **B-agent**: [SdkAgentService](https://github.com/cursor/sdk-bridge/blob/d932194bcaf3d8ca4cae7373dfec32633ed0c9d0/proto/sdk/v1/sdk_agent_service.proto).
- **B-versioning**: [docs/versioning.md](https://github.com/cursor/sdk-bridge/blob/d932194bcaf3d8ca4cae7373dfec32633ed0c9d0/docs/versioning.md).
- **B-streaming**: [docs/streaming.md](https://github.com/cursor/sdk-bridge/blob/d932194bcaf3d8ca4cae7373dfec32633ed0c9d0/docs/streaming.md).

Installed CLI citations use the versioned directory above and modules in `5672.index.js`:

- **C-prompt**: `src/acp/agent-session.ts`, `handlePrompt`, `pendingPromptCancel`.
- **C-errors**: `src/acp/agent-session.ts`, `processPrompt` catch/finally; no `usage_update` emitter found in the ACP chunk.
- **C-tree**: `src/acp/session-resources.ts`, subagent publisher `announce`, `sendState`, `meta`.
- **C-tools**: `src/acp/{session-update-presenter,tool-call-presentation}.ts`, completion presentation.
- **C-interactions**: `src/acp/interaction-handlers/{ask-question,create-plan}-handler.ts`, vendor request round trips; `src/acp/agent-session.ts`, permission handling.
- **C-models**: `src/acp/cursor-acp-agent.ts`, model/config methods; `src/acp/session-resources.ts`, model-manager wiring.
- **C-storage**: `src/acp/{acp-storage,agent-store,cursor-acp-agent}.ts`, ACP stores and `loadSession`.

Raw recordings are committed under `fixtures/cursor/2026.09.26-dd393fe/`. They were read, not regenerated:

- **F-tool**: `tool-read.jsonl`, initialize seq 1, session metadata seq 3, turn completion seq 59.
- **F-subagent**: `subagent.jsonl`, child spawn seq 92 and `cursor/task` seq 184; `subagent-background.jsonl`, spawn seq 25, final prompt reply seq 148.
- **F-plan**: `plan-review.jsonl`, plan request/answer/completion seq 154/155/156.
- **F-approval**: `approval-edit.jsonl`, edit seq 40–43 with no permission RPC; `question.jsonl`, no question request. Neither is an approval/question success fixture.
- **F-background**: `background-shell.jsonl`, completed shell seq 27; [analysis section 5.1](../fixtures/cursor.md#51-background-shells-are-invisible-over-acp-this-is-a-correctness-gap-for-agentsmd-priority-1) records the still-running local shell.
- **F-interrupt**: `interrupt.jsonl`, cancellation without final shell completion; [round-2 addendum](../fixtures/cursor.md#addendum-round-2-recordings-2026-10-02).

Train references mean `git show 8d98459e20c181d93abb269cc12d1df5a28ff75a:<path>`:

- **T-adapter**: `packages/adapter-acp/src/adapter.ts`, `createAcpAdapter`.
- **T-session**: `packages/adapter-acp/src/session.ts`, `openAcpSession`, `AcpSession.initialize`, `drain`, `resolve`, `interrupt`.
- **T-quirks**: `packages/adapter-acp/src/quirks/{cursor,types}.ts`, `cursorQuirks.capabilities`, `baseCapabilities`.
- **T-routing**: `packages/adapter-acp/src/{session-routing,association,children,settlement,lifecycle}.ts`, child ownership, cancellation and uncertain task handling.
- **T-tools**: `packages/adapter-acp/src/{tools,tool-raw,tool-final}.ts`, `toolStatus`, raw preservation.
- **T-daemon**: `apps/daemon/src/engine/adapters.ts`, `discoverAdapters`.
- **T-history**: `packages/history-import/src/scan.ts`, `scan`, Cursor unsupported branch.

Accounts references are pinned to PR #25 head
`a30aa2c85849b92ee471f0ccc6147f0b3a6f6492`, fetched as `origin/feat/accounts`:

- **A-instances**: [packages/accounts/src/instances.ts](https://github.com/arpan404/ace/blob/a30aa2c85849b92ee471f0ccc6147f0b3a6f6492/packages/accounts/src/instances.ts), `createInstance`, `instanceEnv`, `loginStatus`, environment masking and private home selection.
- **A-service**: [packages/accounts/src/service.ts](https://github.com/arpan404/ace/blob/a30aa2c85849b92ee471f0ccc6147f0b3a6f6492/packages/accounts/src/service.ts), `AccountAdapterFactory`, `AccountService.bindAdapter`, `openSession` and pinned resume.
- **A-login**: [packages/accounts/src/login.ts](https://github.com/arpan404/ace/blob/a30aa2c85849b92ee471f0ccc6147f0b3a6f6492/packages/accounts/src/login.ts), `addAccount`, current CLI login driver.

No tests, benchmark, fixture recorder, provider login or model turn ran. Verification for this docs-only change is formatting and source review.
