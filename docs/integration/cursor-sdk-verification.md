# Cursor SDK implementation verification

This branch contains the local SDK adapter, SDK-first daemon selection,
backend/instance persistence, capabilities, bounded portable context, HTTP MCP
injection, selected-instance model discovery, auth host seam and approval-gated SDK
scenario recording support. Browser auth backend/protocol and durable checkpoint recovery
are now assembled; UI implementation is separately owned. The branch is ready
for static review, with runtime validation deferred to merge under owner policy. No live Cursor turn, browser login,
fixture recording, benchmark or mutation was executed. The owner later authorized the eight explicitly listed failing test files plus checkpoint quota and host output named in the lead; all 602 tests in those ten files now pass.

The owner permits static checks and, for the current repair only, the ten failing test files named in the request and lead. All other tests remain deferred to merge. CI is
disabled by the owner; no CI run, rerun or watch was requested.

Static validation: `bun run fmt`, `bun run lint`, `bun run typecheck` and
`bun run check:size` passed, with 2,508 sources within the 1,500-line limit. These do not establish runtime correctness.
Main through `bdc359e2` was merged without rebasing. Its browser and desktop
integration was preserved without UI edits, and its shared handoff/transition
owner now retains SDK backend and account metadata.

## Written behavior tests — needs run at merge

- Account SDK auth source survives restart and quota updates, rejects key-bearing status and leaves another instance unchanged.
- SDK catalog normalization retains authenticated parameters and redacts unknown key-bearing metadata without guessing ACP defaults.
- SDK discovery admits CLI-free installation, refuses wrong versions/helpers and Windows, and distinguishes absence from broken installation.
- Backend registry selects SDK for new threads, permits ACP only on SDK absence and retains old native IDs through additive SQLite migration.
- Full/restricted policy mapping fails closed without verified Auto-review.
- Selected HOME and environment auth stay isolated; auth results discard the sentinel key and logout preserves another instance and history.
- Delta/stream/result overlap renders once; equal messages from different turns survive; unknown message/envelope data and ambiguous snapshot evidence are retained.
- Steering retains one ace run across SDK segments; old results cannot settle the replacement.
- Per-turn usage is emitted once, cumulative result usage is not added again and missing cost stays unknown.
- Denied MCP/nonzero shell tools stay failed after a successful root result, with no fabricated question or plan approval.
- Plans/todos/edit diffs map to canonical content and SDK truncation is visible.
- Foreground/background/nested tasks retain whole-tree status, late native identity and declared visibility limits; unresolved shells survive root end.
- Sign-out drains an outstanding login before deleting selected-instance credentials.
- Real synthetic Node host I/O preserves steering identity, rejects child control and awaits shutdown.
- Getter/depth/byte admission refuses unbounded arbitrary payloads before serialization; oversized checkpoint recovery refuses before full-conversation loading.
- Portable handoff stays within its budget, records source and exposes loss while retaining identical entries.
- Client controls honor sandbox-only/read-only policy while retaining legacy provider defaults.
- SDK HTTP injection rejects remote/decorated URLs and uses the bearer header through the existing MCP transport.
- Authoritative SDK auth/quota/network failures remain failures without fabricated retries.
- Literal JSON-shaped text fragments survive redaction while known secrets and structural secret fields remain scrubbed.
- SDK input is bounded before durable admission; the pending/queued/in-flight input backlog refuses excess commands.
- Host open publishes its native identity before frames, and unknown terminal status fences subsequent sends.

Additional continuation behavior guards (all need run at merge):

- Remote paired clients receive and poll their own browser login URL; another device is refused, and completion clears the URL.
- Login return keys stay out of socket results; credentials/challenges stay out of accounts SQLite and canonical event history.
- Sign-out cancels a browser exchange before deleting credentials; expiration clears challenges without a timed test sleep.
- Default SDK admission enters accounts ownership with its original home before thread/auth requests; configured SDK launch environment remains separate from ambient credentials.
- Selected account identity survives registry restart; thread creation pins it before asynchronous dispatch and honors an explicit override.
- Official SQLite checkpoints and native run identity survive close/reopen; existing SDK JSONL remains readable and conflicting/partial formats preserve their source.
- A real killed daemon resumes its pinned native/account identity, recovers a journal delta that missed ace's commit, skips a repeated committed delta and preserves identical messages in separate turns.
- Callback boundary offsets never become durable SDK ObserveRun offsets, including after journal recovery.
- Native queued/running records become interrupted after restart without resending input or changing already completed outcomes.
- Torn journals, torn legacy native records and cursors beyond their journal refuse recovery without truncating evidence; metadata without native conversation state requires explicit handoff.
- Oversized native checkpoint writes visibly fence further writes while retaining the previous checkpoint.
- Late failed tools settle their original call and surviving-work marker without splitting replacement text or ending the logical steering run; authoritative success clears execution uncertainty.
- An old segment's callback/checkpoint overflow fences the shared host instead of letting replacement execution continue.

Review-round behavior guards, all need run at merge:

- Foreground child success closes child text and preserves an unresolved nested shell before core end-turn cleanup; the tree remains waiting.
- Aggregate checkpoint admission rejects a one-MiB write into a 7.9-MiB store without changing the previous checkpoint bytes.
- Concurrent reservations admit only the write that fits, and a rejected SQLite replacement preserves the checkpoint through close/reopen.
- CLI creation of a fresh SDK account receives the daemon browser challenge, polls completion and keeps the registered home, without persisting the challenge.
- Recovery reads its committed ObserveRun cursor and emits only the later native event, even when subsequent Send callbacks have larger boundary offsets.
- Live shell output is visible before completion; final stdout overlap is not appended twice, and nonzero exit stays failed.
- The public SDK host admits a megabyte tool result through bounded frames; the engine stores complete output and raw provenance in SQLite chunks and rejects cross-thread chunk access.
- Large text deltas retain complete content through ordered chunks; raw redaction excludes cross-chunk sentinel secrets and numeric secret fields while preserving usage counters and refusing getters.
- A real synthetic host waits for the engine's durable frame acknowledgement before completing send.
- Typed client auth errors stay outside the durable command outbox.

Verifier-round behavior guards, all **not executed (tests run at merge)**:

- Large one-level child text and thinking retain every chunk under the observed task identity, with no appended preview or root contamination.
- Surviving child chunks from an older steering segment remain attributed while the replacement root stays active; deeper data remains raw evidence with a visibility notice.
- Text-only child completion closes its message before the root result, independently of shell/tool boundaries.
- Public session send waits across two independent host round trips with the engine commit blocked; only a durable ACK releases send.
- Concurrent journal callbacks reach one blocked durability barrier together; neither resolves early, backlog is refused, and shutdown drains/recovery retains both ordered offsets.
- Oversized journal groups refuse before any write, fence later admission and preserve the previous recoverable bytes.
- The SDK recorder rejects absent approval, unverified Auto-review and missing MCP setup before capture/provider admission.
- Approved synthetic recorder workflows retain selected HOME/policy/model, redact catalog sentinel keys, resume the same checkpoint and fork a fresh identity while preserving source observations.
- Root result alone cannot complete a recording with unresolved background work; auth challenges/channels are excluded, repeated close is safe, and an already-finished root cannot spend another steering turn automatically.

Existing engine restart tests cover committed input, acknowledged/pending intents
and uncertain delivery without automatic resend. Parent-death, slow-consumer,
heap failure and combined cancellation/admission races still need execution and
live SDK evidence at merge; static review is not runtime proof.

Merge integration guards, all need run at merge:

- SDK portable forks create a fresh native identity, preserve the source and resume the recipient's pinned account/backend after restart.
- Same-account SDK model switches close/resume the original checkpoint; account/provider switches refuse CLI migration and require a fresh portable handoff.
- Old ACP Cursor resume and model changes stay pinned after SDK becomes the default; a new context fork selects SDK.
- `handoffFrom` uses the shared citation/budget owner, grants frozen source history and excludes later source content.
- Migration-10 SDK raw streams and backend identity survive the main history/transition migration and subsequent reopen.
- Native SDK forks with opaque ACP/task IDs are refused before host admission.
- Equal completed source messages retain separate citations in shared portable history.
- Authenticated socket handoff creation refuses an unreadable source before engine admission and still accepts authorized sources.

## Mutation cases — not executed (tests run at merge)

1. Accept a resolved SDK version other than 1.0.35: discovery version refusal.
2. Treat missing sandbox helpers as supported: discovery helper refusal.
3. Run restricted execution without Auto-review: policy failure assertion.
4. Reuse the launch HOME: selected-home assertion.
5. Return SDK login's apiKey: safe auth/sentinel exclusion assertion.
6. Delete the other instance or checkpoint during logout: preserved-file assertions.
7. Append both stream messages and onDelta: single rendered message assertion.
8. Deduplicate equal content from separate operations: two identical messages assertion.
9. End the logical run on steering cancellation or late result: one active run assertion.
10. Add terminal cumulative usage to per-turn counters: one usage event assertion.
11. Complete a background child on dispatch: whole-tree status assertion.
12. Treat denied MCP/nonzero shell as success: failed tool assertions.
13. Invoke getters/serialize oversize frames: admission refusal and untouched getter assertion.
14. Load checkpoint history before the disk budget gate: oversized recovery refusal.
15. Permit child interrupt/stop/question resolution: unsupported-control assertions.
16. Remove portable context byte limits: bounded handoff/truncation assertions.
17. Redact numeric token counters as secrets: safe SDK accounting assertion.
18. Overwrite a failed run with a duplicate success result: first failed outcome assertion.
19. Erase literal JSON-shaped deltas: literal streaming text assertion.
20. Remove durable input admission bounds: oversized input and queue-full command results.
21. Accept further sends after unknown terminal status: uncertain-delivery refusal.
22. Publish the open frame before native identity: frame callback checks the pinned native ID.
23. Mask SDK environment auth or inherit it into ACP: selected backend environment assertions.
24. Lose safe auth-source metadata on quota updates/restart: SQLite registry status assertions.
25. Persist a key-bearing auth status: strict auth schema refusal.
26. Stop the other selected instance or release its writer: live second-host send and migration refusal.

27. Expose one device's login challenge to another device: forbidden poll assertion.
28. Retain a login URL after completion/cancellation: terminal event exclusion assertions.
29. Delete credentials before the login worker exits: ordered sign-out outcomes assertion.
30. Remove login expiration: cancelled/not-found state and challenge exclusion assertions.
31. Resolve the account at async dispatch instead of command acceptance: selected/explicit account edge assertions.
32. Replay a committed journal delta again: killed-daemon transcript assertion.
33. Skip the journal delta missing from ace's commit: recovered complete text assertion.
34. Feed callback positions into SDK ObserveRun: native offset independence assertion.
35. Mark finished native runs interrupted: completed native outcome assertion.
36. Reuse a partial/conflicting native store as a fresh SQLite checkpoint: source-preservation refusal assertions.
37. Admit an oversized native checkpoint blob: prior checkpoint preservation and visible fence assertions.
38. Split replacement text on a late tool completion: one replacement message assertion.
39. Ignore shared host overflow from an old segment: failed whole-tree status assertion.

40. Substitute the current default account for an unpinned resume: refused resume assertion.

41. Re-register the original default SDK identity under a new home or bypass accounts ownership: daemon composition/pinned native home assertions.
42. Substitute ambient credentials for the configured SDK environment: synthetic host auth-source assertion.

43. Let the SDK silently drop a torn legacy JSONL record: source-preserving malformed checkpoint refusal.
44. Resume agent metadata without its native conversation checkpoint: missing native state refusal.

45. Admit a linked or oversized SDK credential store: cross-home source-preservation refusal.

46. Resolve the shared migration number as only SDK or only ACP: cold-store identity assertions for both historical shapes.

47. Leave a surviving tool uncertain after authoritative completion: late-success whole-tree settlement and late-failure marker assertions.

48. Remove recovery's committed observe lookup: only the second native event may be emitted by actual recovery.
49. End a foreground child before preserving its shell: running shell, completed child text and waiting-tree assertions.
50. Commit aggregate overshoot before admission: unchanged JSONL bytes and preserved SQLite checkpoint after reopening.
51. Allow concurrent checkpoint admission against one stale inventory: only the first write may commit.
52. Restore the CLI's always-throwing login fence: public account-add browser challenge and completion assertions.
53. Bypass SDK body streaming or terminate on a normal megabyte result: public host and engine output/raw completeness assertions.
54. Duplicate final stdout after live output: exactly one incremental output stream assertion before and after terminal success.
55. Remove storage acknowledgement waiting: two independent host round trips must observe no ACK while the public session commit is blocked, then observe ACK after commit.
56. Leak numeric or cross-chunk secrets, or execute payload getters: raw reconstruction, sentinel exclusion and untouched getter assertions.
57. Render a large text preview as fresh content: one complete assistant message must contain every original chunk.
58. Append raw bytes to another thread: cross-thread storage refusal.

59. Keep a partial call's unknown kind after shell identity arrives: visible live shell output assertion.

60. Treat an empty environment override as authenticated or silently fall back to the SDK store: logged-out environment-source assertion and host admission fence.

61. Lose the SDK backend on portable fork creation: restart resumes the recipient's own pinned native ID.
62. Send SDK checkpoints into CLI account migration: an actionable refusal preserves source continuation.
63. Select the current SDK default for an old ACP model switch: ACP continuation retains its original native ID/model.
64. Remove handoffFrom history grants or allow later history: scoped public MCP reads retain the frozen cutoff.
65. Drop SDK migration-10 raw data or metadata: reopen preserves raw bytes, backend and execution metadata.
66. Accept an opaque native SDK fork: public adapter admission rejects before discovery.
67. Clear SDK native identity on a same-account model switch: private source history survives close/resume.
68. Reclaim an old SDK checkpoint during provider switches: both directions require fresh context and preserve continuation.

69. Remove source-thread authorization from socket handoff creation: denied history creates no recipient, while authorized history still creates one.

70. Render a large child text preview instead of chunks: full child-attributed text assertion.
71. Drop child thinking chunks or render the preview twice: complete reasoning text and one-item assertion.
72. Omit the task call from child chunks: child ownership and no root message assertion.
73. Fence surviving old-segment child chunks: complete child text with the replacement root still active.
74. Remove child-terminal transcript closure: text-only message becomes complete before the root result.
75. Restore per-callback fsync for concurrent admission: both real file rows must reach the first blocked durability barrier.
76. Resolve a journal group before fsync: no callback may release across the independent file-I/O round trip.
77. Check group quota after writing: prior journal bytes and recovery remain unchanged.
78. Drop accepted callbacks during close: both commits and reopened offsets must survive shutdown drain.
79. Skip host/session storage ACK waiting: the second independent host probe must still report no ACK while the engine commit is blocked.
80. Bypass recorder approval: public API must return the authorization schema error and create no capture.
81. Reuse ambient HOME or omit recorder policy/model: synthetic provider output must report the selected home, composer-2.5 and effective policy.
82. Start a fresh agent instead of checkpoint continuation: resumed capture retains one native agent and two distinct ace runs.
83. Resume the source during portable fork: source/recipient native identities must differ and source status remain preserved.
84. Complete recorder on root result with surviving background work: capture must be incomplete with a non-done tree.
85. Remove recorder Auto-review setup refusal: the public refusal must name Auto-review before any capture.
86. Bypass required fixture MCP setup: the public refusal must name the missing lease before any capture.
87. Append deeper task previews or remove fidelity warning: no attributed assistant text and an explicit beyond-one-level notice.
88. Admit SDK auth/non-SDK channels into capture: no browser challenge may reach the artifact.
89. Make capture close non-idempotent: public auth-exclusion cleanup closes twice without waiting for a nonexistent second finish.
90. Send replacement after the steering trigger's root already finished: incomplete capture contains only the original ace run.
91. Lose SDK backend/account on prepared-thread admission: the public queue-integration guard checks durable metadata before any dispatch.
92. Accept conflicting account selectors: the public admission guard refuses without creating a second thread.
93. Accept SDK queue migration or close before refusal: the live-session guard retains queue, native identity and account, then successfully steers that same session.
94. Release new SDK input automatically after crash: the killed-daemon guard asserts a held restart queue before explicit continuation.
95. Claim crash-live SDK work certainly stopped: the killed-daemon guard requires an unresolved native-outcome notice.

These are designed mutation cases, not evidence that executed mutations were killed.

## Performance — needs run at merge

`packages/adapter-cursor/bench/translate.ts` measures admitted delta translation
without accumulated transcript scans; `bench/ipc.ts` covers payload admission and
shared writer backpressure. `bench/checkpoints.ts` measures callback journal
sequential/group-commit fsync/replay with a retained handle and the production `boundedCheckpointStore`
decorator, sharing its quota with the journal. `bench/body-stream.ts` measures
redacted raw JSON, output and one-level child text/thinking preparation. `bench/children.ts` exercises
owner-indexed child terminal preservation; `apps/daemon/bench/cursor-raw.ts`
measures the shared SQLite append/read path. `tools/recorder/bench/cursor-sdk.ts`
measures the bounded canonical recording evidence fold. All report ops/s,
microseconds/op and peak RSS. **No numbers are available:** the owner prohibits benchmark execution.
Long-session identity eviction, terminal boundaries, IPC/backpressure throughput
and SDK full-conversation/native-helper RSS still need measured coverage. The SDK
can buffer internally; an old-space budget is not a total process RSS guarantee.

## To record after approval

Approved SDK fixtures: **none**. Existing ACP fixtures remain intact.
All SDK scenarios use **1.0.35**, **composer-2.5**, disposable workspaces and a fresh
isolated fixture instance. Namespace:
`fixtures/cursor-sdk/1.0.35/composer-2.5`. The passive sink remains separately
available; `recordCursorSdkScenario` from `@ace/recorder/cursor-sdk` now provides explicit
per-scenario approval-gated orchestration, selected-instance catalog capture,
interrupt/steer/resume/fresh portable workflows and bounded canonical tree
analysis. It never signs in or automatically retries/promotes artifacts. MCP
scenarios require a fixture thread/instance lease and storage owner; restricted
scenarios require established Auto-review availability. Observed analysis is not
a conformance verdict: approved live observations need owner review before
fixture expectations become authoritative. See
[recorder setup/contract](../../tools/recorder/CURSOR_SDK.md).

1. Text/thinking/read: streaming order, channel overlap, identities and terminal result.
2. Edit/shell success/failure: diffs, output, exit status and failed tool/root outcomes.
3. Restricted sandbox/Auto-review: safe read, denied outside operation and MCP denial without approval UI.
4. Full access: sandbox disabled and safe write/shell in a disposable workspace.
5. Plan/todos/question attempt: native plan/todos and unavailable answer/review callbacks.
6. Foreground child: call/native association, nested content and completion order.
7. Background child: dispatch versus continued work and whole-tree settlement.
8. Nested task: observed grandchildren and incomplete deeper content.
9. Background shell: observable completion or preserved uncertainty.
10. Interrupt with shell/child: cancel/result/close order and surviving work.
11. Steering restart: two SDK runs, one ace run and late old frames.
12. Close/resume/history: checkpoint identity, positional reconciliation and usage overlap.
13. Portable fork: fresh native identity, bounded provenance and preserved source.
14. Thread MCP/image: lease identity, policy result and image mapping.
15. Usage: per-turn/cumulative association and optional billed lookup.

Auth uses only stubbed SDK operations and sentinel temp stores in offline tests.
Actual browser login is a separate owner action; auth callbacks, challenge URLs,
keys and raw auth results never belong in recordings. No artificial quota-spending
rate-limit scenario is proposed.

## Deliberate limits and merge-time work

- Backend browser auth and selected-instance lifecycle are assembled through the
  daemon service registry. Web/desktop auth views and other client control wiring
  are separately owned. Generated protocol schema references are refreshed as
  documentation artifacts; verification beyond the permitted static checks stays
  deferred to merge.
- New SDK threads use the public transactional SQLite store. Existing SDK JSONL
  stores keep their format. Redacted callback journals commit before IPC and ace
  commits its cursor atomically with canonical facts. Pure translation hydration
  and journal replay own canonical content; native durable observations and
  positional snapshots remain bounded evidence, never text-equality guesses.
- Native active runs reconcile before continuation, and ace marks crash-live runs
  failed/interrupted with actionable uncertain-delivery notices. Input is retained
  without automatic resend. Native store cancellation cannot prove that provider
  inference or every helper stopped; explicit uncertainty remains visible.
- Restricted admission defaults to refusal. A trusted availability flag is the
  current gate; no authoritative Auto-review availability probe exists here.
  Sandbox/MCP fail-closed behavior needs the approved live scenario.
- SDK task children inherit MCP credentials without reliable caller attribution.
  The daemon grants a read-only lease to the entire SDK host, including root;
  mutating ace MCP calls remain unavailable. No privileged custom-tool bypass.
- Large SDK bodies stream into shared ADR 0006 storage in bounded redacted chunks,
  with full raw references and bounded semantic previews. Explicitly identified
  shell output and large text use canonical streams; unknown shell association
  remains evidence. Final/live overlap is disclosed without guessed suffixes.
  Chunk storage commits atomically with provider offsets and acknowledges the
  host before further intake. Raw chunk hydration retains positions, not a second
  copy of the bytes. Each raw body has a 16-MiB ceiling.
- Heap/checkpoint/IPC/callback limits, native write guards and ancestor-symlink
  refusal are implemented. Auth workers also reject linked/oversized credential
  stores before SDK import without reading their contents. The SDK may buffer internally; heap limits do not
  establish total native/helper RSS. Serialized pre-write aggregate reservations
  preserve the previous checkpoint on admission rejection; only changed known
  paths update the ledger. Failed SDK I/O or unexpected allocation/format changes
  fence execution without assuming rollback. Conservative page/WAL headroom can
  refuse before the configured raw ceiling. Measurements need
  run at merge; no unbounded resume or total RSS guarantee is claimed.
- Windows home/sandbox/process ownership is unsupported. POSIX parent-death and
  idle cleanup need execution at merge. Exact 1.0.35 remains the admission gate;
  future SDK versions require explicit acceptance.
- Deeper nested task and background completion evidence remains incomplete.
  Late authoritative tool completion across steering now settles the original
  call; incomplete or missing evidence remains uncertain. Children are read-only,
  with no independent send/resume/stop.
- SDK catalog parameters are retained/normalized. Arbitrary parameter selection
  awaits the shared model-selection contract. Billed usage and quota windows stay
  unknown rather than inferred from token totals.
- Separate SDK sign-in and the launch API-key override remain visible. Logout
  deletes only the selected SDK credential store and does not revoke a key or
  remove the environment override. No native ACP-to-SDK checkpoint conversion
  or cross-account checkpoint copying; bounded context handoff preserves source.
  In-place `thread.switch` into/out of SDK or across SDK accounts is refused
  before disposal/migration. Use a fresh portable fork or `thread.create` with
  `handoffFrom` and the destination `instanceId`. Same-account model switches
  keep the native checkpoint and backend. The merged main's `@ace/handoff`
  owns portable budgets/citations and frozen source-history grants.

Do not merge this branch without the orchestrator's instruction.

## UI follow-up for the Claude web agent

No web, desktop, mobile or UI package was edited. Use
`Client.cursorAuth({ type: "cursor.auth.start", instanceId, label })`, poll by
`loginId`, open a browser-state URL on the client's device, and cancel on explicit
user action. Status/select/logout use the same typed API. Do not store URLs in
client persistence or telemetry. Show effective auth source, including the
environment override after sign-out. Thread creation can specify `instanceId`;
`handoffFrom` preserves source context. Existing `@ace/client` provider controls
expose sandbox-only approvals, interrupt/restart steering, context-handoff fork
and read-only task children. Recovery/uncertain-delivery notices must stay visible.

## Independent verifier response

The report at PR comment `5967107620` identified R1 nested preview truncation and
R2 an immediate-promise-state ACK guard. Complete one-level chunk routing and
markers fix R1; a public session with an independent second JSON-RPC peer now
crosses two real-process round trips while commit remains blocked for R2.
Foreground text-only closure isolates F2. F1 uses bounded concurrent group
commits while preserving sequential durability; F4 extracts pure SDK input and
failure mapping, leaving a 393-line host. SDK recording orchestration is now
written behind explicit approval. No fixture or model operation was executed.

MCP child caller attribution, unknown positional snapshot/live association,
credential/cancellation/parent-death observations, SDK/helper RSS and benchmark
numbers still need merge-time or owner-approved live evidence. Current read-only
policy and uncertainty notices preserve these limits. No Integration rehearsal
finding comment was present when PR comments were refreshed; mentions in earlier
response comments are not rehearsal reports. All verifier mutation rows remain
unexecuted; N7/N12/N13 now have the stronger guards named above.

## Integration train 3

Merged main `bdc359e2` without rebasing. Cursor auth remains a registered listener service in degraded startup. Prepared-thread `accountId` and direct creation `instanceId` select the same pinned SDK account; conflicting values refuse admission. Queue recovery retains its shared owner, while native frame offsets remain atomic with canonical facts/raw chunks. SDK account migration refuses before session disposal and remains fenced at execution for old durable intents. Crash-live SDK work gets an uncertainty notice, and pending new input stays held until explicit continuation. SDK leases grant no mutating MCP capabilities through either factory. No UI source was edited.

## Merge-time failure repair

The owner authorized the explicitly listed files plus checkpoint quota and host output called out in the lead. The initial reliability run reproduced 12 failures and 17 unhandled errors; Cursor/protocol guards reproduced five failures and checkpoint/host guards reproduced three. After repair, all 602 tests across the ten authorized files pass without unhandled errors. The full suite, other test files, benchmarks, mutations and live provider operations were not run.

The shared scripted provider was structured-cloning `ProviderPayload`, losing its private admission certificate. It now copies metadata separately, retains immutable certified data and awaits frame commits. SDK frame admission stays strict. Void frame consumers no longer create unhandled rejection noise after the actor fences a persistence failure; awaiting consumers still receive a rejected commit. The existing persistence-failure guard now checks both paths.

Child terminal guards assert canonical item-update events using the canonical ID instead of indexing internal native item keys. The quota guard retains the failed run/error and absence of retries, while expecting main's durable limited thread status. Browser auth rejects whitespace-decorated URLs with an aborting HTTPS constraint before URL normalization can produce conflicting intersection results; schema generation and explicit invalid-challenge guards pass. Protocol references were regenerated.

Checkpoint quota guards now compare bytes across SDK Buffer/Uint8Array representations. The host output stub supplies the pinned SDK schema's required `modelCallId`, so the test reaches bounded output and disposal instead of failing schema validation before send. The orchestrator's main merge `4dc670a3` was pulled before repair.

## Remaining merge-time failure repair

The owner's next exception authorized only these ten process-test files: adapter discovery, Claude registration, accounts server, release bundle, Cursor daemon recovery, supervisor diagnostics, Cursor auth composition, SDK checkpoint recovery, SDK account binding and SDK account CLI. The baseline reproduced all eleven reported failures plus two unhandled Claude frame errors. After repair, **26 tests in those ten files pass**, with no unhandled errors. The extra discovery case exercises installed SDK admission without a CLI. Typecheck, lint and scoped formatting pass. No full suite, other tests, CI, benchmark, mutation, browser login, recording or provider turn was run.

- Cursor-only capture, raw chunks and durable offsets are gated by the pinned Cursor SDK backend. Claude still uses the SDK channel, without needing Cursor generation metadata or entering its journal. Boundary admission and actor poisoning stay strict.
- Account auth projects the registered account to the SDK identity schema for status, login and logout. CLI account creation uses the registry's canonical home after registration. Its guard supplies a real home alias and verifies the browser challenge and completed login through the public command API.
- Release packaging externalizes the exact SDK and subpaths, stages its installed dependency/peer closure and target helper, and bundles the supervised host separately. Manifest reads cap at 64 KiB and the graph at 64 entries; incompatible helper/version or conflicting dependency versions refuse staging. Archive normalization retains executable helpers.
- The artifact guard writes and reopens an SDK SQLite checkpoint in the isolated release directory and checks executable helper access. It uses no authentication or model request. Existing standalone startup, diagnostic export and supervisor failure guards pass.
- CLI discovery is injected independently from SDK discovery; accounts-list guards compare CLI, delegated CLI and socket lists while allowing the automatically registered default SDK account.
- Crash recovery asserts the native run's failed terminal event and the queue's waiting status, then verifies explicit pinned continuation and replay deduplication. Synthetic recovered callbacks await durable ACKs. Checkpoint guards compare preserved bytes across Buffer and Uint8Array implementations.

These targeted results do not establish full-suite success or live SDK lifecycle evidence. The fixture scenarios remain pending owner approval with composer-2.5.

## Second merge-time failure repair

The owner authorized only the ten process files named in the second failure report.
`git pull` was already current at `6b7f89e8`. The first focused run reproduced
11 failed tests and two unhandled rejections across those ten files.

- Claude shares the `sdk` channel. Cursor checkpoint capture, raw chunk handling
  and durable-offset reconciliation now require the selected Cursor SDK backend;
  Claude frames retain their own translation and account/MCP behavior. Poisoning
  and frame certificate validation stay enabled.
- Accounts explicitly projects its registered account into the strict SDK
  identity contract. SDK account addition uses the canonical registered home.
  Tests retain canonical macOS temp-path identity instead of requiring an alias.
- Release packaging stages SDK 1.0.35, the installed runtime dependency closure
  and the selected platform helper unchanged. The SDK stays external to esbuild;
  its supervised host is built beside the daemon. Manifest reads and closure
  discovery are bounded. Archive mode normalization preserves helper executability.
  The isolated artifact guard creates a real local SDK checkpoint, closes and
  reopens it, verifies retained bytes and admits the packaged executable helper,
  without browser authentication or provider inference.
- Discovery guards inject both CLI and SDK availability and cover a CLI-free SDK.
  Registry guards compare the CLI/delegated/socket account inventories while
  allowing the automatically registered SDK account. Restart guards assert the
  crashed run failed and the thread waits on its durable continuation; replay
  callbacks await committed acknowledgements. Checkpoint preservation compares
  bytes across Buffer and Uint8Array readers.

Final permitted run: **10 files passed, 26 tests passed, no unhandled errors**.
`bun run typecheck`, `bun run lint` and scoped `bun run fmt` passed. No full suite,
other test files, CI, benchmarks, mutation execution, UI edits, recordings, browser
sign-in or provider prompts were run. Full-suite integration remains with the
orchestrator. All live fixture scenarios remain pending owner approval.
