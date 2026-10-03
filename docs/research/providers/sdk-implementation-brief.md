# Task: complete local provider SDK integration

This is the implementation handoff for the SDK audit. A copy is delivered at
`/tmp/ace-orch/impl-sdk-brief.md`. No implementation or paid recording was performed
by the research worker.

## Goal and baseline

Give each provider the best supported official integration while preserving
ace's local CLI ownership, indefinite human waits, complete agent-tree state and
restart/reconnect recovery. Keep Claude Agent SDK `query()` and Codex app-server.
Keep Gemini on ACP. Investigate Qwen's official local daemon SDK before changing
its primary interface. Do not replace Codex with the thinner TypeScript SDK.

Fetch the actual implementation before editing:

```sh
git fetch origin integration/train-1
git rev-parse origin/integration/train-1
```

The audit read train commit `8d98459e20c181d93abb269cc12d1df5a28ff75a`; the branch
may have moved. Work from the orchestrator-assigned implementation worktree and
branch based on the current integration train. Read its `AGENTS.md`, `README.md`,
ADRs 0002/0003/0004/0007, the provider adapter READMEs and relevant service owners.
Read the research branch `docs/sdk-audit` if its docs are not merged yet, notably
`docs/research/providers/sdk-audit.md` and proposed ADR 0043. This brief proposes
implementation; it does not turn the proposed ADR into an accepted decision.

At audit time the installed versions were Claude 2.1.286, Codex 0.159.1,
OpenCode v2.0.22, Cursor 2026.09.26-dd393fe, Gemini 0.43.0 and Qwen 0.0.14.
Inspected npm latest versions were Claude Agent SDK 0.3.288, Codex SDK 0.160.0,
Qwen SDK 0.1.17 and Google GenAI 2.27.0. Recheck primary package sources before
pinning. Wrapper upgrades do not upgrade the user's selected CLI.

## Binding constraints

- Use only the user's discovered executable and existing CLI-managed login.
  Never use SDK-bundled fallback executables, collect keys/tokens, invoke SDK
  authentication mutation APIs or introduce a hosted provider mode.
- Fresh implementation only. Provider sources establish interfaces; do not
  copy their code or code from ace-legacy/t3code.
- TypeScript, Node 24+, Bun scripts, Zod 4, erasable syntax and `.ts` relative
  imports. Protocol stays schema-only. Export cross-package APIs through
  `package.json`; do not import another package's private source.
- Pure translators report facts; shared core derives tree status. A root result
  or HTTP completion never proves that children, background tools, queued work
  or interactions are finished. Inject clocks, ids, schedulers and spawners at
  the I/O boundary. Preserve unknown native events and fields as raw data.
- Reuse the existing engine, history, MCP, models, accounts and usage owners.
  Confirm the current train contains sibling work before adding an interface or
  registry. The audited train has no `packages/accounts`; coordinate its port
  with that owner instead of building a second quota service.

## Phase 1: complete the existing Claude SDK adapter

Read `packages/adapter-claude/package.json`, `src/session.ts`, `sdk-process.ts`,
`capabilities.ts`, `interactions.ts`, `input.ts`, `translator.ts`, `usage.ts`,
`tasks.ts`, `content.ts` and `pending-transcripts.ts`. It already uses the user's
CLI path, supervised spawn, partial messages, forwarded child text, pending
permission promises, resume, task stopping and explicit cascades. Preserve them.

1. Pin the audited current SDK and lockfile without changing the user's binary.
   Split growing configuration/control logic into small modules. Expose an
   explicit normal coding configuration using the `claude_code` system-prompt
   preset and selected user/project/local settings sources. Keep isolated
   discovery/test configuration separate. Preserve explicit `permissionMode`.
   Loading local settings may add hooks/plugins/MCP; make that policy visible.
2. Carry native permission title/description, `defaultToNo`,
   `suppressAlwaysAllowRule`, MCP source and the full relevant permission-update
   set. Labels must describe their actual destination. Do not offer persistent
   grants when suppressed. Preserve request/tool/agent correlation, cancellation,
   idempotent replies and process-exit expiry.
3. Connect initial `mcpServers` and runtime `setMcpServers`, status,
   reconnect/toggle through the existing MCP/configuration owner. Do not write
   user `.mcp.json` or add another registry. SDK replacements do not globally
   remove settings/plugin-owned servers; preserve that ownership and report
   errors from the returned result. Keep raw status/control results.
4. Implement `onElicitation` for form and URL interactions through the existing
   canonical elicitation schema/resolution path. Missing callback currently
   auto-declines. Keep requests pending across device latency, cancel once, and
   expire on process death. Opt into `onUserDialog` kinds only when the product
   can render/answer them; otherwise return cancellation. A URL is not permission
   for ace to manage provider login or extract credentials.
5. Consume the optional interrupt receipt advertised by
   `interrupt_receipt_v1`; track surviving UUID-stamped queued work. No public
   typed `interrupt({cancelQueued:true})` API exists in the audited SDK. Do not
   cast around that restriction or call minified/private members. Continue to
   settle status from tasks, queue and observed turn facts, including older CLIs
   that return no receipt.
6. Repair usage scope. `result.usage` is main-loop/per-turn, while `modelUsage`
   and `total_cost_usd` are inclusive cumulative query-pipeline estimates.
   Preserve child attribution and store session/model aggregates separately.
   Handle repeated results, resume/fork inherited baselines, `/clear` resets and
   zeroed startup errors. Inclusive totals cannot be added to child totals.
   Normalize stable rate-event reset/utilization/status metadata through the
   accounts owner. Do not poll the explicitly unstable SDK usage method as a
   production requirement. An allowed event only clears its own rate block.
7. Use observational SDK hooks only where they add missing child identity or
   transcript facts. `includeHookEvents` already keeps hook lifecycle raw data;
   it does not register callbacks. Return neutral hook results. Do not synthesize
   agents for every sidechain model call merely because it contributes usage.

Likely shared files: `packages/engine-api/src/index.ts` for optional control
ports/configuration, `packages/protocol/src/interactions.ts` and provider/usage
schemas for additive metadata, `apps/daemon/src/engine/sessions.ts` and the
existing command/MCP configuration intent owner. Keep new interfaces narrow;
avoid options that switch unrelated behaviours with boolean flags.

Migrate Claude model discovery in `packages/models/src/discover.ts`. Its
`claudeInitialize` duplicates raw stream-json initialization. Use an empty
streaming-input SDK Query and `supportedModels()`, adapt to the existing
`normalizeClaude` envelope, and close in `finally` with bounded cancellation.
Keep strict empty MCP and isolated settings for discovery. Do not send an empty
string or dummy prompt. Move/re-export a narrow process bridge from the existing
`sdk-process.ts` responsibility through a public package API so live sessions and
discovery share supervision without importing adapter internals.

## Phase 2: native fork and optional Claude steering

Use the existing `HistoryAdapterPort.fork` in
`apps/daemon/src/history-continuation.ts` and the continuation contract in
`packages/history-import`. Add a public home-bound provider fork operation where
needed. Claude has the official filesystem `forkSession` helper or query
resume/fork options. Prefer an idle history clone and verify which helper home
it reads; run filesystem helpers in a home-bound worker if their environment is
process-global. Never switch the daemon's global home to service one account.
Persist the new native id and source lineage, preserve source history, and keep
worktree cloning and provider file-undo semantics separate. Advertise Claude
fork only after that path exists and its behaviour is verified.

Steering is a subsequent gated change. Current Claude capability is false and
`send(...,"steer")` rejects. Priority `now` semantics can background running
tools. Carry genuine keyboard-input origin as human and retain non-human
origins for scheduler/orchestrator/model content. Add input provenance at the
shared send intent boundary rather than spoofing it inside the adapter. Use
owner-approved recordings to prove turn correlation, queues and surviving work
before advertising steer; retain engine queue fallback. Partial tool-argument
JSON may be displayed as partial data, but must not be parsed as finished input.

## Phase 3: retain Codex app-server and finish its service controls

Read `packages/adapter-codex/src/session.ts`, `session-commands.ts`,
`session-state.ts`, `capabilities.ts`, `translator.ts`, `translate-item.ts`,
`translate-turn.ts`, `translate-delta.ts`, `interactions.ts`, `resolution.ts`,
`agent-registry.ts`, `retention.ts`, and `scripts/generate.ts`. Preserve steering,
approval envelopes, native queue, child reconciliation and terminal stopping.

- Implement the history fork port with `thread/fork`; validate and persist its
  returned native id and home ownership. The adapter currently advertises fork
  but does not expose the operation. Use supported `deferGoalContinuation` when
  an explicitly requested fork must stay idle. Never call fork/resume as a
  discovery probe; a stored goal may start work.
- Wire `review/start` with native targets and inline/detached delivery to
  `packages/review` and daemon `src/review.ts`. Plan review currently uses
  collaboration mode and is a different action. Persist detached thread
  identity and observe its work; do not turn a review command into a text prompt.
- Reuse `packages/models/src/discover.ts`, `native-schemas.ts` and `normalize.ts`.
  They already discover `serviceTiers/defaultServiceTier`. Carry resolved
  model/effort/tier to session/turn settings through the existing intent path,
  validating against that instance's catalog. Do not add a second listing.
- Add bounded account-window reads and updates to the accounts owner. Preserve
  `rateLimitsByLimitId` buckets, reset seconds, unknown fields, stale/unavailable
  state and optional earned-reset metadata. Do not consume reset credits, change
  auth, convert subscription percentages to token limits or claim model
  entitlement from catalog presence.
- Keep the fixture-backed version floor, but gate optional controls with
  installed-binary definitions, read-only method evidence and invocation error
  handling. Generate changed type dependencies using the existing script.
  Source types do not replace lenient runtime schema parsing.

No transport migration, Python sidecar or process pooling is required. The
TypeScript SDK starts exec, which rejects interactive approvals and filters
child/delta events. A shared app-server per home is separate future work.

## Phase 4: conditional Qwen daemon SDK investigation

Coordinate with sibling ACP work. Installed Qwen 0.0.14 initializes ACP but
advertises `loadSession:false`; do not offer resume or send `session/load`.
Keep this compatibility mode. Do not install/upgrade Qwen for the user.

The official `@qwen-code/sdk` 0.1.17 offers both Query and `DaemonClient`.
Query's router awaits a human callback, blocking later lines, with a 60-second
default timeout. Do not adopt it as ace's primary interactive transport unless
upstream resolves those limits and new evidence supports it.

Investigate a compatible user's `qwen serve` with the official daemon client.
The inspected source corresponds to CLI 0.24.7; no universal minimum daemon
version was established. Use `serve --help`, `/capabilities` and non-prompt
status/list reads to negotiate support. The client does not spawn the CLI.
ace must supervise the resolved user's executable on loopback with their home
and login, and connect the SDK to that local URL. Never use SDK authentication
routes or connect to a hosted provider endpoint.

Suggested new responsibility is `packages/adapter-qwen`, with a small daemon
process shell, SDK session shell and pure frame translator. Reuse ACP translation
through public exports for underlying ACP updates. If that fits better as a
session implementation beside the shared ACP adapter, document the public seam
first. Extend provider-kit discovery, daemon registration and protocol provider
schemas only if sibling work has not already added Qwen/Gemini support.

Investigate permission voting independent of the event pump, child metadata,
queue controls, model/MCP controls, usage, reconnect cursors and event epochs.
On `state_resync_required`, read authoritative history/status/pending permissions
before clearing recovery guards. SDK reducer state is not ace tree status.
Map idle history cloning to `branchSession`, not directive-taking `forkSession`;
the latter launches agent work. Keep it an explicit work action if ever exposed.
Deliver compatibility evidence and a gated follow-up change before switching
the primary transport. Runtime daemon behaviours remain unverified by this audit.

Gemini remains the user's `gemini --acp`. The CLI SDK embeds core and does not
drive the installed binary; Google GenAI is a cloud/model client. Preserve newer
ACP usage and child metadata when observed, using sibling ACP ownership.

## Behaviour tests for the implementation worker

Use public adapter/engine/service APIs, recorded native frames and synthetic
provider CLIs at the process boundary. Name tests after user-visible behaviour.
Implement these tests; follow the owner's test-execution rule at merge.

- Partials and completed blocks produce one transcript, including late child
  events. Incomplete tool JSON is never accepted as complete input.
- Permission metadata and update destinations survive. Two device answers settle
  once; cancellation and process exit expire the correct interaction. Child
  progress remains visible while a human takes longer than 60 seconds.
- MCP initial/dynamic changes expose tools/errors and preserve settings/plugin
  ownership. Form/URL elicitation sends the typed answer once and expires after
  death. Unsupported dialogs cancel.
- Multiple cumulative results, duplicate delivery, children, resume, fork and
  clear do not double count tokens/cost or erase persisted usage on startup
  failure. Allowed rate events do not clear unrelated network retries.
- Interrupt survivors and background tasks keep the thread unfinished. Explicit
  cascade failures remain observable. EOF/restart never leaves dead work active.
- Fork returns a new native id without mutating source history; account homes
  remain isolated. Native detached review remains live until its work settles.
- Tier/effort selection reaches the correct native control; unsupported options
  fail visibly. Quota windows keep native units and unknown fields.
- SDK model discovery returns real normalized models, cleans up on every exit,
  and sends only initialize/control traffic, never a user prompt.
- Qwen cursor replay deduplicates canonical output; epoch/ring reset reconciles
  history/status/interactions. Legacy Qwen never attempts unsupported resume.
- Unknown SDK/protocol fields remain raw and nonfatal. Recovery and reconciliation
  cannot make the tree done while child activity is still unknown.

## Recordings requiring owner approval

Do not run `tools/recorder` now. Request approval for the following concrete list
after the implementation is reviewable. Keep existing fixtures and add a new
version directory for any changed CLI.

| Provider    | Existing fixtures to re-record if behaviour changes                                                                                                                                     | New scenarios to approve                                                                                                                                                                                                                                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude      | `fixtures/claude/2.1.286/{tool-read,approval-edit,question,plan-review,subagent,subagent-background,background-shell,interrupt}.jsonl`                                                  | Resume; idle fork; partial/tool-argument streaming; nested children; monitor completion; permission suppression/default/persistent updates; MCP initial/replace/remove/failure and plugin ownership; form/URL elicitation; queued-survivor interrupt; priority-now steering with backgrounded work; multi-turn/model/child accounting; normal preset and project settings |
| Codex       | `fixtures/codex/0.159.1/{tool-read,approval-edit,question,plan-review,subagent,subagent-background,background-shell,interrupt}.jsonl` only where modified control behaviour warrants it | Resume pending approvals; idle fork with deferred goal; native inline/detached review; tier selection; late descendant reconciliation and surviving terminals                                                                                                                                                                                                             |
| Qwen daemon | None committed for this mode in the audited baseline                                                                                                                                    | Streamed tool/thinking activity; approval allow/deny and long wait; foreground/nested/background child approvals; monitor/shell after root completion; cascade interrupt; permission-time crash; reconnect replay/epoch reset; resume; idle branch versus explicitly launched fork; models/MCP/usage                                                                      |
| Gemini ACP  | Sibling ACP owner decides                                                                                                                                                               | Approval, loading, usage and child fidelity only where sibling changes require evidence                                                                                                                                                                                                                                                                                   |

Read-only version/help/initialize/catalog/quota captures can be collected without
paid turns. Quota rejection/backoff fixtures should use naturally observed data
or separately approved scenarios; never deliberately exhaust the user's plan.
No real prompt is authorized by this research handoff itself.

## Risks and delivery

SDK/CLI drift, removed previews and experimental controls need separate wrapper
and executable capability evidence. Settings loading changes the coding
environment; preserve an explicit isolated option. SDK-decoded JSON still needs
ace boundary schemas. Inclusive usage and inherited fork totals can inflate
analytics. Global filesystem-helper homes can cross account boundaries.
Replay rings are finite; unknown ancestry and epoch reset require conservative
recovery. Qwen's fork naming can start paid work. Keep daemon authentication
APIs and provider credentials outside all new control ports.

Deliver small attributed commits, updated adapter/service docs and the approved
ADR when the owner adopts it. Run formatting and permitted static checks during
implementation; run required tests/full `bun run check` at the authorized merge
gate. Do not run tests or record fixtures as part of the docs-only audit. Report
remaining capability gates explicitly, with evidence for every advertised one.
