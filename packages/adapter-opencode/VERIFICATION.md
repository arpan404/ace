# OpenCode v2 verification

Implementation targets CLI/client 2.0.22. Evidence is the accepted research brief, the pinned official client's generated signatures, and primary v2 schema/operation contracts. ADR 0047 is still Proposed. No provider prompt, probe, fixture recording, test, benchmark or mutation run was executed during this implementation. The owner's final instruction reserves all dynamic verification for merge.

Static verification: formatting, lint, TypeScript and source size checks are the permitted checks. Their final status is reported in the implementation PR. Runtime behavior below **needs run at merge**.

## Authored behavior coverage

- Native execution defines a turn; step boundaries and HTTP admission cannot finish it.
- Duplicate native terminals, idle projections and inherited durable prefixes do not create extra turns or finish newer work.
- A background child or native shell survives parent/tool completion; child human input blocks the thread and synthetic completion wakes its owner.
- Interrupt acknowledgement and a no-op interrupt leave cleanup work visible.
- Child permissions reply on the owning session; always is explicitly a project grant.
- Question forms retain q0/q1 keys and multi-select answers; generic forms and dismissal feedback survive translation.
- IDs-only native cancellation acknowledgements retain the submitted feedback; SDK exceptions and projected snapshot metadata cannot expose transport secrets.
- A transient disconnect retains pending interactions until scoped reconciliation.
- Recovered full text reconciles prior deltas without duplicate appends.
- JSON readiness, PID/version/spec gates and method-specific SDK return shapes govern observable startup.
- Steer/queue admission uses distinct IDs; an uncertain acknowledgement reconciles the inbox without resending.
- Concurrent admissions preserve HTTP order, exact engine command correlation and canonical queue counts without duplicating native inputs.
- EOF, malformed JSON, oversized SSE and comment-only keepalives exercise transport recovery and liveness.
- Oversized projected content fails recovery before bounded evidence truncation can hide work.
- Recovery discovers missing children, permissions and owned shells while excluding foreign directories, forks, global forms and unowned shells.
- Opaque child/history pagination retains filters; subsequent recovery refreshes the head rather than rescanning history, and never uses unretained logs.
- Ephemeral transport/config secrets are absent from frames; location-scoped model metadata retains variants and limits under the models owner.
- Generic input admission transfers queue ownership in the daemon without manufacturing a run; a later run cannot acknowledge the next unanswered steering input.
- A late recovered admission for a failed send cannot acknowledge a newer steering input; stale idle outcomes cannot finish an execution started before disconnect.
- Empty inbox snapshots keep an uncertain admission canonically blocked after a previous completed run, without duplicating queue counts; cancellation, history or admission proof closes its uncertainty task.
- Cancelling startup closes its lease; an external attachment survives adapter closure and transport recovery.
- Account environments reach the owned executable, preserve input correlation, and retain their process after refused idle closure; standalone discovery probes honor cancellation.
- Same-account sessions reuse their owned server; cancelling one leaves its peer usable and a different account remains isolated.
- Adapter shutdown stops every owned account process and closes external consumers/recovery waiters without stopping an unrelated or externally owned server.
- Native submitted `input.background` owns child work, including repeated dispatches to a completed child and stale historical synthetic replay.
- A running snapshot cannot be discarded by a newer text delta; covered message/ordinal chunks reconcile once, including delayed HTTP responses, and late suffixes/other ordinals survive. A partial chunk boundary fails recovery rather than claiming completeness.
- Empty-data location shutdown expires owned permissions/forms and rejects actions; foreign and moved-away directories cannot expire them.
- Newer buffered work, inbox entries and forms defeat stale recovery idle/absence; foreign events cannot delay the send barrier.

`v2.test.ts` checks public translation through core/projection. `v2-session.process.test.ts` uses an actual local HTTP/SSE server behind a fake executable. Provider spawning tests use the `.process.test.ts` convention. Historical v1 assertions use the archived implementation explicitly.

## Mutation designs

Each case is **not executed (tests run at merge)**:

1. Treat `session.step.ended` as execution terminal: execution/step lifecycle test must fail.
2. End a turn on HTTP prompt admission: admission test must fail.
3. Drop live tool background work at root terminal: interrupt cleanup test must fail.
4. Retire native shell on tool success: shell/root completion test must fail.
5. Ignore child permission ownership: child permission reply test must fail.
6. Flatten multi-select answers into scalar values: keyed form test must fail.
7. Expire pending interactions on transport loss: disconnect reconciliation test must fail.
8. Append buffered deltas over recovered text: full projected text test must fail.
9. Remove the version/spec/content-type gates: startup rejection cases must fail.
10. Retry an uncertain accepted prompt: uncertain admission test must fail.
11. Admit a fork/global form/foreign project by ID alone: ownership exclusion test must fail.
12. Drop cursor scope or revisit every historical page: pagination/head refresh test must fail.
13. Let a comment heartbeat create a turn or fail to refresh silence: keepalive test must fail.
14. Record transport password or model headers: redaction assertions must fail.
15. Keep the engine's send queued after native admission: daemon admission transfer test must fail.
16. Reject concurrent admissions instead of serializing them: concurrent steer/queue test must fail.
17. Settle a newer execution from an old idle outcome: stale idle recovery test must fail.
18. Acknowledge the oldest intent instead of its correlated command: late recovered admission regression must fail.
19. Drop uncertain input solely because it is absent from inbox snapshots: uncertain empty-inbox test must fail.
20. Discard correlation in the account session wrapper, or stop it after refusing idle closure: account lifecycle test must fail.
21. Ignore injected discovery probes or their abort signals: standalone cancellation test must fail.
22. Omit isolated account processes from adapter shutdown: account shutdown test must fail.
23. Require cancellation events to echo feedback: IDs-only dismissal assertions must fail.
24. Observe unredacted projected metadata or expose SDK error bodies: secret-boundary tests must fail.
25. Truncate oversized projected content before validating it: incomplete projection recovery test must fail.
26. Remove the canonical uncertain-admission task: prior-completed-run empty recovery regression must fail.
27. Use metadata.background instead of submitted input.background: source-shaped child waiting regression must fail.
28. Permanently suppress completed child IDs: repeated continuation regression must fail.
29. Skip every buffered delta: post-snapshot suffix and other-ordinal recovery regressions must fail.
30. Replay snapshot-covered deltas: exact recovered text regression must fail.
31. Suppress positive running snapshots on any newer session event: running snapshot plus late delta regression must fail.
32. Require a session ID on location.shutdown: owned permissions/forms expiration regression must fail.
33. Admit foreign or moved-away directory shutdown: exclusion regressions must fail.
34. Omit external consumer closure: attached recovery waiter/interaction closure regression must fail.
35. Start a new server per account session, or let one abort stop the shared server: account reuse/peer regression must fail.
36. Double-count admission-pending inputs in the provider queue: concurrent-admission canonical queue assertions must fail.
37. Treat a partially covered delta as complete: partial-boundary recovery failure regression must fail.

The review's 22 mutation rows remain mapped to these authored public behavior tests. No survival/kill result is claimed: every case is **not executed (tests run at merge)**.

## Performance artifacts

`bench/native-deltas.ts` measures incremental native delta translation; `bench/recovery.ts` measures initial versus changed-head recovery at increasing history sizes. `bench/event-fanout.ts` measures observed SSE dispatch with 1/16/64 sessions. `bench/tree-recovery.ts` varies verified tree size at 1/16/128/1,024 nodes and records initial versus repeat recovery plus child pages. `bench/recovery-deltas.ts` varies buffered text coverage at 128/1,024/4,096 deltas. `bench/account-reuse.ts` measures same-account session admission at 1/16/64 sessions. The new programs share the fake executable boundary. These programs report elapsed time/throughput and peak RSS. **Numbers unavailable: benchmarks were not run under the owner's rule. Needs run at merge.** Existing `benchmarks/` programs explicitly use the historical v1 implementation.

## To record after approval

No v2 fixture directory has been created. Every run requires separate explicit approval and a quota/time cap. Use OpenCode `opencode-go/muse-spark-1.3-contributor`.

| Candidate           | Evidence to collect                                                                    |
| ------------------- | -------------------------------------------------------------------------------------- |
| tool-read           | native execution/tool order and projected history                                      |
| approval-edit       | action/resources/source and once reply                                                 |
| question            | keyed single/multiple answers and dismissal                                            |
| subagent            | parent edge, transcript and child approval                                             |
| subagent-background | parent terminal while child works, synthetic wake, continuation                        |
| background-shell    | native background shell, ownership and completion wake                                 |
| interrupt           | acknowledgement, cleanup and terminal ordering                                         |
| retry-overloaded    | controlled structured retry, without repeated real overload attempts                   |
| plan-review         | only after discovering a configured v2 agent/form flow; otherwise unsupported metadata |

Recorder drafts live in `tools/recorder/src/providers/opencode-v2-scenarios.ts`. Existing common scenarios are adapted for native background shell and multi-select forms. Plan review is skipped. Controlled retry/dismissal and the additional candidates (always/reject persistence, cascade children/shells, steer/queue/cancel, resume, server restart with pending work) need a separately approved recording setup. The driver marks time-cap captures incomplete and refuses to certify a disconnected recording through an empty resync.

Execution order, synthetic wake/cascade behavior and any plan support remain a release gate requiring approved live evidence. Fake-server tests are deterministic verification artifacts; they are not live fixture certification.

Two additive shared contracts are required: `input.admitted` transfers queue ownership in core/protocol/daemon, with optional command correlation supplied through `ProviderSession.send`, and optional question `feedback` preserves v2 cancellation messages through commands and canonical interaction events. Protocol changes are schemas only. No provider-specific daemon route or client logic was added. External attachment uses a caller-supplied, pre-discovered transport; managed-service discovery/restart is not automated. A changed PID requires explicit reattachment.

## Review follow-up

`origin/main` was fetched and merged without rebasing; it was already an ancestor of the branch. The seven blockers and both performance/lifecycle follow-ups from the owner's review are statically addressed. The recorder declares its direct Zod dependency and implements the server's explicit consumer closure contract. The public engine API and canonical schemas are unchanged by these fixes.

No test failure or subsequent pass was measured: regression cases were authored before the fixes, and execution remains reserved for merge. The earlier `done` expectations without an execution are corrected to `new`. No comment titled “Integration rehearsal: findings for this PR” was present during this follow-up.
