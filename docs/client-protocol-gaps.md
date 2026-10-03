# Web client protocol integration

ADR [0056](adr/0056-client-requests-and-thread-organization.md) records the ownership decisions. All changes are additive; protocol version remains 1. This backend PR supplies the contracts for replacing the web app's `TODO(train-2)` adapters. It does not change those frontend adapters.

## Gap ownership

| Reported backend gap                                          | Contract / owner                                                                                                                                                 |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Creation result guessed from sidebar                          | `commandResult.threadId`; command retries return the same receipt                                                                                                |
| Account, model, options, local/worktree mode, base branch     | `thread.create`; the daemon prepares isolated worktrees through `@ace/git` before opening a provider session                                                     |
| Composer's next model/options                                 | `thread.send`; selection is applied before delivery through #69’s rollback and history rules, with explicit errors for unsupported controls                      |
| Rename, delete, pin, read state, settle, unsettle, snooze     | Daemon organization commands, `thread.client.updated`, both thread and sidebar projections                                                                       |
| Archive undo lost when a tab closes                           | Immediate `thread.archive` and durable `thread.unarchive`                                                                                                        |
| On-device auto-settlement                                     | Indexed daemon deadlines; layered `threads.autoSettleAfter`, `settleOnMerge`, `settleOnClose`; whole-tree done required                                          |
| Branch, worktree, project, host, PR, diff stats               | `thread.details`; creation supplies project/machine facts, refresh supplies actual Git state, forge links supply PR state                                        |
| Live model/account/provider, agents, background work          | `thread.live`; subagent count counts known non-root agents, background count counts running tasks; changes use point lookups                                     |
| Context meter / Limited / queue visibility and removal        | Covered by [#72](https://github.com/arpan404/ace/pull/72): its queue snapshot/commands and meter remain authoritative                                            |
| Fork, merge back, provider/account switching                  | Covered by merged [#69](https://github.com/arpan404/ace/pull/69); its registered commands and switching owner are integrated                                     |
| Delegate and agent control                                    | Covered by [#70](https://github.com/arpan404/ace/pull/70); preserve its scoped MCP and daemon services                                                           |
| Service reads persisted as durable commands                   | `Client.request()`; legacy `client.command({type:'diagnostics.health'})` becomes a direct read                                                                   |
| Settings/models/accounts/usage/files/search/commands adapters | Typed `Client.request()` over the existing services; settings subscriptions also gain explicit unsubscribe                                                       |
| Missing settings keys                                         | Typed `SettingsValues` and defaults for the web's `threads.*`, startup, retention and notification keys                                                          |
| Pairing/device HTTP access                                    | `AccessClient`, existing `/v1/*` routes, scopes in the pairing fragment; live device streams are covered by [#71](https://github.com/arpan404/ace/pull/71)       |
| Scripts and Open in editor                                    | `workspace.request` discovery; `workspace.script.run` returns an owned terminal; `workspace.editor.open` returns a native bridge descriptor                      |
| Commit / push / PR actions                                    | `git.commit`, `git.push`, canonical `ForgeCommand` routing through public Git/forge packages; `workspace.request` / `pr.status` is a direct read                 |
| Attachments before a thread exists                            | Device-owned `context.request` draft scope, resumable upload, adoption into the matching project's thread                                                        |
| Turn picker tied to the 200-item window                       | Stable root-turn `Run.ordinal`, paged `runs.list`; child runs do not consume root-turn numbers                                                                   |
| Per-turn diff refs absent                                     | `Run.checkpoints`, `run.client.updated`; before delivery and after whole-tree settlement through `@ace/git`                                                      |
| Deck lacks a run/plan wire view                               | `conductor.request` list/get/subscribe/unsubscribe; `conductor.changed`; public compact persisted views                                                          |
| Plugin requests outside canonical wire                        | `pluginRequest` / `pluginResult` in canonical unions; trust review stays mandatory                                                                               |
| Skill availability/source/reveal/edit                         | Paged installed-plugin component catalog; persisted provider policy; bounded immutable source read with host path; CAS edit produces a new pinned trust review   |
| Fake automations feed and guessed next run                    | Real daemon `@ace/automations` service, persisted inbox and `schedules[].nextRunAt`; file watching reuses `@ace/workspace`; recurrence has a browser-safe export |
| Terminal wire and character offsets                           | `terminal.request`, `terminal.output`, `terminal.credit`; bounded ring, byte offsets and one outstanding chunk per viewer                                        |
| Browser wire/backends                                         | Canonical browser messages and `Client.request/send/onMessage`; backend selection and embedded relay covered by [#74](https://github.com/arpan404/ace/pull/74)   |
| Preview wire                                                  | Thread-owned `preview.request` list/forward/unforward on the existing configured preview gateway                                                                 |
| Native editor opening / desktop controls                      | Descriptor consumed by the bridge in [#73](https://github.com/arpan404/ace/pull/73)                                                                              |

All of `/tmp/ace-orch/web-open-issues.md` was considered. Theme/editor presentation, Tailwind class merging, shimmer styles, shortcut rebinding/reserved shortcuts, rail inset, route generation, glyph reuse, renderer replacement, frontend interaction deduplication, and history-navigation UI are frontend work, not daemon/protocol additions.

## Client adapter pattern

```ts
const settings = await client.request(
  {
    type: "settings.get",
    key: "threads.autoSettleAfter",
    scope: {},
  },
  { signal },
);
const models = await client.request({ type: "models.list" });
const details = await client.request({
  type: "workspace.request",
  operation: { op: "thread.details", threadId },
});
const created = await client.command({
  type: "thread.create",
  workspaceId,
  provider: "codex",
  account,
  mode: "worktree",
  baseBranch: "main",
  model,
  options: { reasoningEffort: "high" },
  input,
});
if (!created.ok || !created.threadId) throw new Error(created.error);
```

`request()` allocates its own request ID. Its response type follows the query type. Correlated `error` messages reject only that request. Domain results such as `context.result`, `files.error` and `search.error` retain their service-specific shapes. Reads have bounded capacity, cancellation and deadlines, reject on disconnect, and never replay. Reconnect subscribers explicitly and release both server subscription and `onMessage` listener on unmount. Use distinct subscription IDs across services.

Use durable `command()` for user mutations in `CommandPayload`. Service-specific operations such as uploads, settings writes and browser controls follow their existing request contracts; they are never automatically replayed. `send()` handles one-way ACK/credit/control frames. `AccessClient` takes an injected trusted fetch and credential supplier; HTTP operations never use the outbox. HTTPS or local IPv4 loopback is required, credentials stay in headers, redirects are refused, and response bodies are capped at 1 MiB. Pairing redemption does not send the administrator credential.

For a terminal, request `open`, then `subscribe` with a byte cursor. Consume `terminal.output`, then send `terminal.credit` after rendering each data chunk. An exit or resync ends that subscription. Resubscribe from the advertised resync cursor. Never slice terminal replay by JavaScript character count. The fake follows this credit and byte-offset contract. Browser subscriptions use their existing per-frame ACK instead; fake browser images are synthetic data URLs.

For new-thread attachments, create a draft with the project ID, upload with `draft.upload.begin` and the existing chunk/status/commit operations, and put `draftId` in `thread.create.context`. The context owner adopts completed refs before composition. The project authorization root stays distinct from an isolated worktree's actual filesystem root. Cross-device and cross-project adoption is refused. Attachment composition/delivery at the engine boundary is covered by #72; preserve these draft hooks when integrating it.

## Runtime decisions and boundaries

Organization never changes execution status. Delete is a tombstone, allowed only for a quiescent tree with no pending engine intent or owned terminal; search/rebuild excludes it. Archive is reversible independently of execution. A renewed active tree clears settlement immediately. Snooze expiry is persisted on the daemon clock. Organization and Git metadata refresh do not prolong inactivity.

Workspace reads/actions and checkpoints use the persisted provider session cwd. Preparation must finish before an isolated binding becomes usable. Forks inherit that actual cwd, and Git refresh retries if the authoritative binding changes during its reads. Client-projected worktree paths never authorize filesystem actions. Script discovery reads bounded regular manifests, including package.json, Procfile, Makefile and justfile, and exposes declared targets. A script ID is rediscovered before launching. Windows script execution reports unsupported until a platform shell owner is supplied. Editor detection returns an installed executable and workspace path; the desktop bridge opens it on the host. Remote web devices do not run that executable locally.

Git commit compares the supplied HEAD before staging; it refuses conflicts. Push uses an existing remote and named current branch, without force. Forge uses the user's local `gh` login and a GitHub remote, with its runner factory injected at the runtime boundary. Links, metadata and receipts persist. Asynchronous external actions reserve receipts before I/O: concurrent retries share one flight; a cold uncertain reservation returns `action_outcome_uncertain` and does not repeat the effect.

Root-turn checkpoint capture includes descendant edits. The next admitted turn waits for the previous capture. Boundaries interrupted by restart or native turns without a before-delivery hook report `unavailable`; they are never guessed. Imported historical root-turn ordinals are seeded from retained runs once at startup. `runs.list` is authoritative for historical numbering; old event payloads are not rewritten. The brief does not request automatic checkpoint pruning, so refs persist like existing Git checkpoints.

Deck views and command routing use the real conductor store/driver. Execution requires `DaemonOptions.conductor.execute` and an account supplier backed by the host's engine/orchestrator/Git/forge/verification ports. This PR does **not** implement that native Deck executor: reconstructing delegation, native fork, account migration or verification would overlap the in-flight workers and expand beyond client routing. Without the port, start returns `conductor_executor_unavailable`, while existing stored plans remain readable. This is a remaining integration requirement, not covered completion by another PR.

Preview forwarding requires the daemon's existing `preview` gateway configuration. Discovery is host-owned; this PR adds explicit per-thread forwarding, not automatic interpretation of arbitrary terminal URLs. The fake supplies fixture forwards. Browser backend policy remains in #74. Installed plugin components form this catalog; repository/user slash commands remain in the existing command library. Source edits retain upstream commit provenance but produce a new content hash and require acceptance before launch. Inline command replies add `virtual` and `manifestPath`, with `path` pointing to the owning physical manifest for reveal/open. Edits still use the catalog's virtual path. Warm catalog pages reuse bounded validated snapshots and an indexed component list; an installation revision invalidates them across processes. Provider execution always verifies integrity again.

Automations run only when the global `automations.enabled` setting is true. Schedule/manual/GitHub/file events use the existing scheduling and execution owner, deterministic command admission and whole-tree observers. File observations are coalesced into one bounded event per watcher batch; the admitted event key persists in the automation run. Next-run timestamps are null while the scheduler is disabled. File watcher startup errors are reported to daemon logs. Startup, retention and notification preference keys are persisted typed settings; desktop and notification consumers must apply them through their existing host/device APIs. Global quiet-hours strings do not replace device notification timezone preferences.

## Verification at merge

Fast static checks are run locally. Tests, mutation runs, benchmarks and provider probes are not run under the owner's merge-only policy. Written tests exercise real local sockets, SQLite, temp Git/bare remotes, PTYs, upload bytes, restart and typed fake transports. All execution claims need a run at merge.

Non-gating benchmark sources measure metadata point changes, persisted root ordinals and point metadata events, reply validation/correlation, blocked fake terminal rings and indexed compact Deck views, authoritative root/terminal-ownership point reads, and cached plugin catalog pages. They print ops/s, microseconds per operation and peak RSS. Numbers are **needs run at merge**, not measured locally. Metadata updates do O(change) work; terminal output retains one bounded ring and no per-viewer output queue; Deck reads index current lanes and omit retired execution artifacts. Maintenance uses disk-backed bounded batches, not memory proportional to thread history.
