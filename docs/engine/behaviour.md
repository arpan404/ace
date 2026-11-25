# The engine and provider adapters: observable behaviour and invariants

This is the contract any implementation of the daemon's engine and provider adapters must keep,
whichever language runs it. It covers `apps/daemon/src/engine/` (the `Engine` class and the
modules it wires), the adapter interface in `@ace/engine-api`, the fact reducer in `@ace/core`,
the process and stream layer in `@ace/provider-kit` that the adapters run on, and the six provider
adapters (`packages/adapter-claude`, `-codex`, `-cursor`, `-opencode`, `-acp`, `-pi`), as of
`ace/rust-store` b359519ad3 (2026-11-23). Each rule cites the code that holds it today. The last
section says which tests guard it and which must pass unchanged on a second implementation.

The event store's own contract is [docs/store/behaviour.md](../store/behaviour.md); this document
uses its terms. "Committed" means the store's `COMMIT` returned; "published" means the store handed
the events to its subscribers.

Terms:

- **Frame**: one unit of provider I/O as the adapter saw it (`Frame`, `engine-api/src/index.ts:31`):
  `seq`, `t`, `dir` (`send`, `recv`, `stderr`, `note`), `channel`, `data`, an optional admitted
  `payload` and the account that produced it.
- **Fact**: what a translator says a frame means, in adapter-owned native keys (`Fact`,
  `core/src/facts.ts:74`). Facts never carry ace ids.
- **Event**: what the core fold emits (`EventPayload` in `@ace/protocol`): ace ids, persisted by the
  store, published to clients.
- **Intent**: a durable row for a command the engine accepted and has yet to carry out
  (`intents` table, `engine/intents.ts:52`).
- **Generation**: a counter on each thread's actor, bumped whenever its provider session is
  replaced or lost. Work for an older generation is ignored (`engine/actor.ts:58`).
- **Tree**: a thread, its agents (root, provider subagents) and every delegated child thread on
  this machine (`threadTree`, `engine/thread-liveness.ts:13`).

## 1. Layers and their public surfaces

| Layer             | Public surface                                                                                                                                                                                                                                             | Who calls it                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Adapter interface | `ProviderAdapter`, `Translator`, `SessionContext`, `ProviderSession`, `InputRejected`, `SteerTargetLost`, `assertSteerTarget`, `adapterWarning` (`engine-api/src/index.ts:45`–`:332`)                                                                      | the engine; adapter tests                                                                                                   |
| Reducer           | `apply`, `FactBatch`, `createThreadState`, `deriveAgentStatus`, `deriveThreadStatus`, `isSettled`, `nextDeadline`, `DeadlineIndex` and pure helpers (`core/src/index.ts`)                                                                                  | the engine; adapter translator tests; `fake-daemon` (46 files); `ui-core` and iOS scripts use the helpers                   |
| Engine            | `Engine` (`engine/index.ts:80`), its `handler` and `internalHandler` (`CommandHandler`, `commands.ts:44`), `AdapterRegistry`, `EngineOptions` (`engine/engine-options.ts:14`)                                                                              | `services/engine.ts`, the socket server, agent-control, machines, marketplace, Spade host threads: 33 non-test daemon files |
| Adapters          | each package's `index.ts`: a `ProviderAdapter` (`adapter`, `createCursorAdapter`, …), its translator factory (`createCodexTranslator`, `createAcpTranslator`, `createPiTranslator`, `OpenCodeTranslator`, …) and sub-exports listed in each `package.json` | `engine/adapters.ts` (discovery), daemon services (sign-in, usage reads, model discovery)                                   |
| Process layer     | `@ace/provider-kit/process` (`spawnSupervised`, `spawnRawSupervised`, `spawnTextSupervised`, `probeOutput`, `ProcessLease`), `/jsonrpc` (`JsonRpcPeer`), `/streams`, `/jsonl`, `/flow-control`, `/payload`, `/tree-stop`, `/process-*`                     | adapters, terminal, shells, probes, workspace scripts                                                                       |

The `Engine` has about ninety public methods. They fall into five kinds; a second implementation
must keep each kind's timing:

1. **Command admission** (`handler.handle`, `internalHandler.handle`, `admitCreation`,
   `prepareCommand`): synchronous, inside the store's receipt transaction (section 3).
2. **Synchronous reads of live state** (`queue`, `queuePage`, `inputFate`, `messageFacts`,
   `liveWork`, `hasSession`, `hasState`, `treeActive`, `rootAgent`, `activeRun`, `access`,
   `capabilities`, `supportsSteering`, `workload`, `providerProcesses`, `sessionMetadata`,
   `commandFailure`, `commandExecution`, `resuming`, `endedOnLimit`, `heldInterrupted`,
   `limitsMatter`, `liveThreadIds`, `retainsAttachment`, `creationPending`, `withinAgent`,
   `aceCaller`, …): return at once, never await, read only bounded active state.
3. **Synchronous mutations that commit** (`attachChild`, `updateChild`, `machineChild`,
   `delegationStarted`, `delegationSettled`, `openHostApproval`, `resolveHostApproval`,
   `closeHostGate`, `hostNotice`, `hostError`, `discardRecovery`, `cancelRecovery`,
   `cancelDelegatedInputs`, `setSilenceMs`, `forgetPurged`, `prepareDeletion`, `transferHold`,
   `externalHold`, `adoptMachineHandoff`, `accountRecovered`, `admissionReopened`, …): their rows
   and events commit before they return.
4. **Asynchronous work** (`ready`, `flush`, `close`, `ensureProvider`, `changeWorkspace`,
   `reconcileThread`, `reconcileOwn`, `stopForDeletion`, `stopForCancellation`, `cleanupSession`,
   `retrySettled`, `spawn`, `continueImported`): promises that settle when the work has committed.
5. **Bindings** (`bindOwnershipFence`, `bindCommandPolicy`, `bindDeletionPolicy`,
   `bindHostInteractions`, `bindExternalTaskStop`, `onLimitPolicy`): callers install policy
   callbacks the engine consults synchronously.

`engine.flush()` is called 1,491 times across the tests and `engine.queue()` 411 times: both are
part of the contract, not test helpers.

## 2. Construction, readiness and shutdown

- `new Engine(store, options)` takes the store and ports for everything it cannot control
  (`EngineOptions`, `engine/engine-options.ts:14`): `clock` (`now`, `setTimer`), `batchScheduler`,
  `ids`, `threadId`, `commandId`, `registry`, `limits`, `idleMs`, `silenceMs`/`resolveSilenceMs`,
  `transitions`, `recovery`, `prepareInput`, `prepareWorkspace`, `beforeSend`, `models`,
  `permissionSettings`, `providerEnabled`, `selectInstance`, `mcp`, `sessionContext`,
  `onError`, `onSessionOpenFailure`, `onProviderDiagnostic`, `onNamingPrompt`, `onCommandEvent`
  and more. Tests replace every one of them at this boundary (`ManualClock`,
  `engine/test-support.ts:24`; scripted adapters, `@ace/adapter-testkit`).
- `ready()` settles after providers are activated, silence thresholds and recovery preferences
  are read, and the restart pass (section 13) has run (`engine/index.ts:460`). Until then every
  command is refused with `engine_starting`; while closing, with `daemon_shutting_down`
  (`engine/index.ts:410`).
- `close()` (`engine/index.ts:1428`–`:1466`) runs in this order: stop admission; stop the idle
  sweep and reconciles; wait for settles in flight and workspace changes; then, per thread, flush
  the actor and **capture restart evidence before any provider is closed** (`captureRestart`,
  `engine/recovery.ts:293`–`:303`: in one transaction, the continuation naming the work that will
  die, and the request the agent was waiting on the person to answer, `restart-captures.ts`);
  only then stop the workers and close every session with reason `shutdown`; flush and stop the
  actors. The order matters: closing a provider expires its open requests, so after the close
  nothing in the store would show the agent was waiting on the person. Startup reads the capture
  to decide whether to continue, hold for the person, or drop a capture the provider finished
  while closing (`recovery.ts:320`, `dropStaleCapture`). Guarded by
  `restart-resume.process.test.ts:345`, `:357`, `:384` and `thread-liveness.process.test.ts:91`.
  It never reports a thread done that still has work.

## 3. Commands and intents

- **One synchronous receipt transaction.** `internalHandler.handle(command, context)` runs the
  ownership fence, host interactions, the command policy and `engineHandler` inside one
  `store.atomic` and returns a `CommandResult` (`engine/index.ts:410`–`:427`). No network or
  provider I/O runs inside it (`commands.ts:41`). Either the receipt, the intent row, the queue
  change and the events it appends all commit, or none do.
- **Refusals are results, not throws**: guest and host refusals (`guest-admission.ts`,
  `host-threads.ts`), `engine_capacity_exceeded` when no slot can be reserved
  (`engine/handler.ts:506`), `already_resolved`, `task_not_found`, `invalid_resolution`,
  transition guards, model-selection errors. A refusal commits nothing.
- **Wake after commit.** The handler schedules the thread's workers with `queueMicrotask`, which
  runs only after the receipt transaction committed (`engine/handler.ts:545`). Workers never see
  an intent whose receipt rolled back.
- **Three lanes per thread**: sends, controls and steering, each an `IntentWorkers` that coalesces
  wakes and always runs one more pass if woken mid-run (`engine/workers.ts:4`;
  `engine/index.ts:1256`). A wake is dropped while the thread is being deleted, is a read-only
  continuation, or is fenced to another machine; it is deferred while history is being written
  (`engine/index.ts:1256`–`:1276`).
- **Intent states**: `pending`, `queued`, `running`, `done`, `failed`, with flags `awaiting`,
  `uncertain`, `acknowledged` and the generation it was submitted on (`engine/intents.ts:14`,
  `:30`). Dispatch order is `(position, id)`; recoveries before deliveries; switch before merge
  (`engine/intents.ts:192`–`:310`).
- **Queue state** per thread (`QueueStore`, `engine/queue-store.ts:52`): `paused`, `reason`
  (`stopped`, `restart`, `model_unavailable`, …), `limited`, `resetAt`, `resumeAt`,
  `timerAction`, `holdToken`, at most 256 messages (`maxMessages`, `:30`). `holdToken` increments
  on every hold change, so a continuation that read an older token does nothing.
- **A thread Stop** (`thread.interrupt` of the root, with or without a run id) cancels what waits
  to be sent, pauses the queue as `stopped` and clears rate-limit holds, in the same receipt
  (`engine/handler.ts:510`–`:534`). A stop of one non-root agent stops that agent alone
  (`stop-scope.ts:10`).
- **A new `thread.send` releases holds**: it retires uncertain inputs, releases a stopped or
  restart hold (not a limit, an uncertain send, a recovering continuation, or an unreconciled
  Cursor SDK checkpoint) and the limit hold, so it never queues behind a Stop
  (`engine/handler.ts:500`, `releaseInterruptedHold` at `:562`).
- **Capacity**: at most `maxActiveThreads` (64) threads hold slots; a warm idle session's slot is
  reclaimed for new work before refusing (`reclaimIdleSlot`, `engine/slot-reclaim.ts:24`). Limits:
  `maxPendingInputs` 32, `maxInputBytes` 256 KiB, `maxFrameBytes` 4 MiB, `maxQueuedFrames` 16,384,
  `maxQueuedBytes` 16 MiB (`engine/limits.ts:10`).

## 4. Frames: from a session to the store

The actor (`ThreadActor`, `engine/actor.ts:52`) is the only path from a provider's output to the
store. One mailbox per thread orders frames, ticks and engine operations.

1. **Generation check.** A frame of an older generation, or for a stopped actor, is acknowledged
   and dropped (`actor.ts:303`). A poisoned actor rejects (`"Provider frame failed to commit"`).
2. **Envelope check in place.** `frameEnvelopeError` (`frame-envelope.ts:12`) checks `seq`, `t`,
   `dir`, `channel`, `payload`, `usageAccount` without copying. A bad envelope is an adapter bug:
   it fails the session visibly, never silently (`actor.ts:307`).
3. **Byte accounting.** An `sdk` frame must carry an admitted `ProviderPayload` whose `data` is the
   frame's data; its size is the payload's bytes plus 512; other frames are measured as bounded
   JSON. Over `maxFrameBytes` the session fails with "Provider frame capacity exceeded"
   (`actor.ts:315`–`:334`).
4. **Batching.** Frames collect for at most 1 ms (`batchScheduler`), 256 frames or 256 KiB,
   whichever comes first, or at once while the daemon drains (`actor.ts:336`–`:349`).
5. **Translation once.** A sealed batch is translated exactly once; a retry after a rollback
   reuses the facts (translators keep state) and rewrites only the Cursor frame records that
   rolled back (`actor.ts:358`–`:366`, `translateBatch` at `:448`). Usage facts gain the frame's
   account; attachment echoes are resolved (`translateFrame`, `actor.ts:492`). The native engine
   caches the translator's output _before_ the echoes: the TypeScript caches the batch only once
   the echoes succeed, so a retryable attachment-lookup failure translates a frame twice, which a
   native translator with state or a consumed JavaScript frame handle cannot survive. The native
   engine retries only the enrichment, and the facts it commits are the same.
6. **Stream or commit.** A batch of only `item.delta` and `signal` facts on an established item,
   at most 256 facts and 512 KiB, with no deadline due and no process exit, goes to the store's
   live buffer without a transaction of its own (`EngineRepository.stream`,
   `engine/repository.ts:363`). Everything else is folded and committed in one `store.atomic`
   (`EngineRepository.apply`, `repository.ts:413`; `save`, `:294`): the events, the thread's
   state header (`thread_state`), the changed engine records (`engine_state_records`) and
   execution provenance commit together.
7. **SDK and Cursor batches** commit their control facts and the queue sync together; a Cursor SDK
   batch also commits its raw frame records in the same transaction (`actor.ts:398`–`:416`).
8. **Acknowledgement after commit.** `onFrame` returns a promise that resolves only after the
   batch committed (or was buffered as established deltas) and rejects if it did not
   (`actor.ts:419`–`:430`; `SessionContext.onFrame`, `engine-api/src/index.ts:265`).
9. **Backpressure.** Intake pauses at 256 frames or a quarter of the byte limit and resumes at 64
   frames and a sixteenth (`updatePressure`, `actor.ts:92`); `outputFlow.paused()` also says yes
   while history is written or live writes are blocked (`actor.ts:84`). Every transport reads only
   while `outputFlow` has room (`provider-kit/src/flow-control.ts:2`).
10. **Overflow ends the session, never drops facts.** Past `maxQueuedFrames` or `maxQueuedBytes`
    the accepted prefix commits, then the session is aborted with a `process.exited` fact, a zero
    provider queue and an error notice "Provider mailbox capacity exceeded; resume the thread to
    recover" (`actor.ts:198`–`:236`).
11. **Store busy retries; anything else poisons.** A busy admission retries every 100 ms and never
    fails the session (`runWhenWritable`, `actor.ts:254`); any other failure poisons the actor,
    evicts its state, aborts the session, reports, and appends an error notice
    (`fail`, `actor.ts:271`). A store quarantine of the thread's live output does the same
    (`quarantine`, `actor.ts:268`).
12. **Wake on control.** A batch that changed the thread status, crossed a tool boundary with a
    foreground command, or carried `turn.started`, `input.admitted`, `turn.ended`,
    `process.exited`, `queue.changed`, `limit.cleared`, `interaction.closed`, `background.ended`
    or `retry` syncs the engine queue fact and wakes the workers (`actor.ts:376`–`:395`).
13. **Inputs leased to runs.** Input leases attach to the next root run and release when that run
    ends, or when the process exits (`observeInputs`, `actor.ts:171`).

## 5. Facts and the core fold

- **Adapters translate, core allocates.** Translators are pure and synchronous and never throw on
  provider data (`Translator.translate`, `engine-api/src/index.ts:110`). Only core allocates ace
  ids (`IdSource`, `core/src/state.ts:29`); facts carry native keys, namespaced per provider
  process because providers restart counters on resume (`core/src/facts.ts:61`–`:72`).
- **Turn bracketing.** Every agent's work is bracketed by `turn.started`/`turn.ended`, synthesized
  where the provider has no child turns (Claude, Cursor). A surviving tool must be reported as
  `background.started` before its owning turn ends (`facts.ts:61`).
- **Partial upserts merge**; a first upsert must validate as a full item; a delta before any
  upsert creates a minimal streaming item that later upserts enrich (`facts.ts:70`).
  `item.reconciled` is idempotent: it keeps completion, the first raw input and output prefixes.
- **Invalid facts are rejected, never fatal.** `validateFact` (`core/src/validate.ts:513`) checks
  each fact against state; a rejected fact becomes a notice item carrying a
  `core.rejected_fact` raw payload (`rejectFact`, `core/src/diagnostics.ts:64`, `:72`) and the
  fold goes on.
- **`apply(state, fact, ctx)`** folds one fact and recomputes statuses (`core/src/reduce.ts:45`).
  `ctx.now` must be a non-negative safe integer and `ctx.ids.next` a function, else it throws
  (`reduce.ts:111`). **`FactBatch`** folds a provider frame's facts with one status derivation for
  consecutive batchable facts (signals, item-less interactions, complete messages and notices)
  while every turn or control boundary still sees all preceding facts (`reduce.ts:52`).
- Adjacent deltas to the same field merge before folding; no non-delta boundary is crossed
  (`coalesceFacts`, `engine/delta-batch.ts:4`). Raw payloads in facts are capped the same way as
  store events, including blob references (`capFact`, `engine/raw.ts:8`).

## 6. Status rules (priority 1)

An agent's status is derived from its records; the thread's from all agents. Derivation is
bottom-up, memoized per fold, and a malformed tree reads `starting`, never settled
(`statusResolver`, `core/src/status.ts:143`).

**Agent status, first rule that matches** (`derive`, `status.ts:183`):

1. External status of a delegated child thread.
2. `limited` → blocked on `rate_limit`.
3. Process exited with this agent unsettled → `interrupted` (deliberate) or `failed`
   (`process_exit`); exited and already settled → unchanged; exited otherwise → as for unsettled.
4. A blocking interaction → blocked on `human`.
5. Disconnected → `unresponsive`. A pending retry → blocked on its reason.
6. An active run: waits on subagents → blocked on `subagents` (the live awaited children);
   otherwise its newest own running tool → `working`/`tool`; a live foreground child → blocked on
   `subagents`; silent past `silenceMs` (unless a wait suppresses it) → `unresponsive`; else
   `working` with its activity.
7. A wake window still open → `working`/`starting_turn`. A process-settled status.
8. No run yet: the root before its first turn → `starting`; others silent too long →
   `unresponsive`, else `starting`.
9. Live background tasks or children that hold completion → blocked on `background_task`.
10. Last run interrupted → `interrupted`; failed → `failed`; else `idle`.

In `transport` liveness mode an unsettled agent whose transport has been silent past `silenceMs`
reads `unresponsive` (`status.ts:170`).

**Thread status, first rule that matches** (`liveThreadStatus`, `status.ts:333`):

1. Any actionable pending interaction, a child thread needing the person, or ace's own task
   waiting on the person → `needs_you` with the count.
2. Any agent `working`, `starting` (once the thread has run, or not the root), or blocked on
   subagents with no live refs → `working`.
3. Rate limit → `limited` (with the latest reset when every limit has one); network or upstream →
   `waiting` on it.
4. A running task that holds the thread → `waiting` on `background_task`.
5. A disconnected or externally unresponsive agent → `unresponsive`.
6. Blocked on background tasks or subagents → `waiting` on `background_task`.
7. Queue held on a failed send with nothing provider-queued → `failed`.
8. Engine queue non-empty and not resting after a Stop, or a child waiting on its queue →
   `waiting` on `queue`.
9. An unresponsive agent that holds completion → `unresponsive`.
10. Root failed, or any agent failed after the root's last success → `failed`.
11. Never run → `new` (or `done`/`failed` after a process exit); else `done`.

A thread whose work moved to another machine reads `moved` only once nothing runs here
(`deriveThreadStatus`, `status.ts:324`). `recomputeStatuses` emits `agent.status` for each agent
whose status or completion relevance changed, re-announces a branch that went from settled to
live, then `thread.updated` if the thread status changed (`status.ts:444`).

**The invariant**: nothing in this list lets a thread read `done` while any agent in its tree is
working, waiting on a human, holding a background task, or has queued input that will send by
itself. Every implementation keeps this order exactly; the status tests (section 19) pin it.

## 7. Time, deadlines and ticks

- All time comes from the injected clock; nothing reads the wall clock in logic
  (`EngineClock`, `actor.ts:31`). Ids come from the injected `IdSource` or `timeOrderedIds`
  (`apps/daemon/src/time-ordered-id.ts:11`).
- After each fold the actor arms one timer for the earliest of the core's next deadline
  (silence, wake expiry, retry, limit reset; `nextDeadline`, `core/src/deadlines.ts:67`), the
  translator's own `nextDeadline`, and the idle release (`schedule`, `actor.ts:534`). An armed
  timer for the same deadline is kept, re-armed at least once a second, and re-armed after a clock
  step backwards (`keepsTimer`, `actor.ts:22`).
- A firing timer enqueues `translator.tick(now)` facts and a `tick` fact into the mailbox, so
  deadlines fold in order with frames (`actor.ts:561`–`:574`).
- A deadline pass that cannot commit (store busy) runs again with a doubling back-off from one
  second (`deadlineDeferral`, `engine/recovery.ts:51`).

## 8. Sessions

- **One session per thread at a time**, opened by the delivery that needs it
  (`Sessions.open`, `engine/sessions.ts:330`). Opening waits for the store to be writable,
  refuses a thread being deleted, closing or fenced, waits for the provider's activation,
  syncs silence, resolves access (section 11) and the instance, then bumps the generation and
  creates a fresh `AbortController` lifetime (`sessions.ts:341`–`:413`).
- Every callback a session makes (`onFrame`, `onExit`, `onSessionIdentity`,
  `onSessionConfirmed`, `onInputMessage`, `onCapabilities`, `onPermissionMode`, …) checks that
  its generation is current and its lifetime not aborted before acting (`sessions.ts:523`–`:711`).
- **Identity before echo.** The adapter persists its selection before host admission and its
  native identity before publishing its open frame (`onSessionIdentity`), and each host
  command/native message correlation before the input can be echoed or replayed
  (`onInputMessage`) (`engine-api/src/index.ts:199`–`:210`).
- **Exit**: `onExit` aborts the lifetime and retires the generation (or bumps it if still
  opening); the next delivery opens a new session (`sessions.ts:702`–`:711`). The exit is
  enqueued on the actor behind every frame already handed to `onFrame` (`enqueue` seals pending
  frames first, `actor.ts:191`–`:194`), so a session's final frames commit before its exit folds;
  an exit that overtook them would retire the generation and drop them (`actor.ts:304`). Every
  transport must hand over frames, callbacks and the exit in the order it produced them.
- **Acknowledgement**: `onFrame` resolves once the actor's operation for its batch has run: the
  batch's transaction committed, or its established deltas were accepted into the live buffer, not
  when that buffer later flushes (`actor.ts:389`–`:394`, `:430`–`:441`). Sessions don't wait for
  each acknowledgement before reading on; they read while `outputFlow` has room, which is what lets
  the actor batch. A consumer that does await one must stop intake when it rejects
  (`sessions.ts:684`–`:699`).
- **Unconfirmed close**: when `session.close` fails or isn't confirmed, the old process still owns
  the session and `Sessions.close` gives it back to the actor (`sessions.ts:1064`–`:1069`); frames
  arriving during a close are delivered and committed while the generation is current (flushes
  before and after, `:1062`–`:1072`).
- **Idle release**: a done thread keeps its provider warm for `idleMs` (5 minutes,
  `provider-release.ts:4`), unless it has work left running after the turn (ADR 0109); settling
  or archiving asks for release at once (`releaseRequest`, `provider-release.ts:10`;
  `actor.ts:534`–`:551`, `releaseAt` at `:579`).
- **Close** (`Sessions.close`, `sessions.ts:1053`) with reason `idle`, `user` or `shutdown`
  aborts the lifetime, retires the generation and releases the slot. A dormant actor with no
  backlog is dropped and its state evicted (`releaseDormant`, `engine/index.ts:1225`).

## 9. Delivery

`IntentDelivery.run` (`engine/intent-delivery.ts:38`) carries out one intent:

1. In one transaction: claim it, mark the queue, decide once whether a send steers into the
   active root run, record the send's acknowledgement target, and admit the input item into the
   transcript (bound to the run it steers into) (`intent-delivery.ts:63`–`:80`).
2. Execute: resumes and limit continuations; switch and merge transitions; everything else through
   `executeIntent` (`engine/delivery.ts`), which opens the session if needed and calls
   `session.send`, `interrupt`, `resolve`, `stopTask`, `configure`, `setModel`, `setMode`,
   `setGoal`.
3. Flush the actor, then mark the intent `done` (`intent-delivery.ts:113`–`:118`).
4. On failure: an acknowledged send or continuation is done (admission transferred ownership even
   if the reply was lost); an unacknowledged send that was deferred, or never submitted while the
   queue is stopped, goes back to the queue; an `InputRejected` send (the provider proved it never
   ran it) can be sent again; otherwise the send becomes `uncertain` and the queue holds it for
   the person (Try again, Edit, Remove) (`intent-delivery.ts:120`–`:140`).

- `inputFate` reports each accepted input as `waiting`, `sending`, `delivered` (with its run),
  `uncertain`, `replaced`, `removed` or `failed` (`engine/input-fate.ts:3`, `:43`).
- Echo correlation is durable and indexed; transcript history is never scanned on a frame
  (`InputJournal`, `engine/input-journal.ts:67`).

## 10. Steering and queueing

- `delivery: "queue"` waits for the run to end; `"steer"` joins the running turn
  (`ProviderSession.send`, `engine-api/src/index.ts:313`).
- **Who may preempt.** Input from `ace` (child results, notices) or another `agent` never cuts
  into a turn: it waits for the running tool and never aborts the reply. Only the person's steer
  (no `origin`) may preempt (`InputSource`, `engine-api/src/index.ts:80`;
  `isPersonSteer`, `engine/steer-yield.ts:24`).
- **Fenced steer.** A steer aimed at a run joins only that run; if the run has ended or another
  began, it queues instead (`fenceSteer`, `engine/steer-selection.ts:20`). The adapter checks the
  fence synchronously after its last await, right before writing; a lost target throws
  `SteerTargetLost`, never retried into another turn (`assertSteerTarget`,
  `engine-api/src/index.ts:106`).
- **Check and admission are one step.** The final fence check and the write's admission into the
  session's ordered outbound queue happen in one synchronous step, with no await between them:
  Pi checks, then `rpc.request` enqueues into `RpcWriter`'s FIFO in the same turn
  (`adapter-pi/src/session.ts:404`–`:410`, `rpc.ts:80`–`:88`, `provider-kit/src/rpc-writer.ts:33`
  –`:60`); Codex also compares `fence.turn` with the running turn and maps the provider's own
  refusal to `SteerTargetLost` (`adapter-codex/src/session-commands.ts:92`–`:95`, `:133`); ACP,
  Claude, Cursor and OpenCode check the same way (`adapter-acp/src/session.ts:645`,
  `adapter-claude/src/session.ts:407`, `adapter-cursor/src/session.ts:248`,
  `adapter-opencode/src/prompts.ts:57`). Preparation comes first and may await (OpenCode's
  admission lock and session barrier, `prompts.ts:52`–`:56`; Claude's listing settle,
  `adapter-claude/src/session.ts:401`–`:406`); the check is after the last await, immediately
  before the enqueue. A Stop or turn change decided after admission is queued behind the steer; one
  decided before it refuses the steer unread.
- **The steering lane** (`SteerLane`, `engine/steer-lane.ts:26`): a steer goes in as soon as the
  provider allows. Where the provider's steer waits for the running command, the person's steer
  also gets the command out of the way: `backgroundTools()` where the session can (Claude), else
  the engine interrupts the turn and delivers once it ends (`steerViaCancel` for providers that
  must cancel first). The message stays an unclaimed intent until it goes in, so a restart keeps it
  once.
- **Yielded turns.** A turn the engine interrupted for a steer ends with `endedBy: "steer"`, unless
  the person's Stop arrived in the same stretch (`markYieldedEnd`, `steer-yield.ts:105`;
  `actor.ts:476`–`:487`). A refused interrupt is not retried; the steer falls back to the tool
  boundary.

## 11. Access, approvals and questions

- **Access** is durable per thread as ace modes; native selectors exist only at the adapter edge
  (`Permissions`, `engine/permissions.ts:80`, ADR 0075). A child's ceiling follows its ancestry; a
  live session running broader than its ancestry now allows, and that can't be narrowed in place,
  is stopped (`sessions.ts:225`–`:289`). A change reaches the live session after its command
  commits, serialized per thread (`accessChanged`, `sessions.ts:197`).
- **Interactions.** `interaction.opened` with `blocking` makes the agent blocked on `human` and the
  thread `needs_you` (section 6). Native request ownership is durable, independent of transcript
  paging and translator lifetime (`InteractionLedger`, `engine/interaction-ledger.ts:7`).
- **Resolution.** `interaction.resolve` is admitted in the receipt (already-resolved and kind
  mismatches refused, `commands.ts:48`), becomes an intent, and is delivered with
  `session.resolve(key, resolution)`; if the session is gone the interaction is closed as
  unavailable (`InteractionUnavailable`, `engine/delivery.ts:20`). Pending interactions are
  replay-safe; re-opening a terminal key creates a new entity (`facts.ts:68`).
- **ace's own approvals**: an approval that belongs to the agent's in-flight call to ace's MCP
  server reads on that call's row (`liveAceCall`, `engine/ace-approvals.ts:9`); host approvals
  (Spade, ADR 0121) go through `openHostApproval`/`resolveHostApproval`. Agents never answer
  approvals.

## 12. Stop, settle and deletion

- **Stop plan** for a local process: the provider's interrupt, 3 s; SIGTERM, 3 s; SIGKILL, 2 s
  (`PROCESS_STOP`, `apps/daemon/src/liveness/stop.ts:17`–`:29`). An interrupt that doesn't answer
  in its grace fails as unanswered and the stop closes the session (`sessions.ts:940`–`:1001`).
  A close that fails or doesn't answer still ends the session: the thread reads stopped, saying the
  provider didn't confirm, and a late exit of the old process changes nothing
  (`process.exited` with `unconfirmed`, `facts.ts:231`).
- **What a whole-thread Stop reaches** (`engine/stop-scope.ts`): running provider tasks it can
  stop; tasks it can't stop that hold prompts get the interrupt's grace, then end with the session
  (`closeAfter`, `sessions.ts:1014`); tasks that only end with the session close it at once.
- **Settle** stops the whole tree, children first: sessions, background tasks, open questions,
  inputs that need a live session. Queued messages and child results stay, held, and start no turn
  by themselves; an unsettle or a send fences off what is left of the stop
  (`SettledTrees`, `engine/settled-trees.ts:37`; `settledHold`, `:120`).
- **Deletion** stops the tree (`stopForDeletion`), discards held inputs, and forgets purged state
  (`retireThreadIntents`, `thread-liveness.ts:280`; `forgetPurged`). Live work is read only from
  bounded active state, never transcript history (`ThreadLiveness`, `thread-liveness.ts:62`).
- **A child on another machine that loses contact keeps its parent's hold.** The parent holds a
  task `ace-machine:<child>` for each delegated remote child (`machineChild`,
  `engine/delegation-facts.ts:57`–`:65`). Lost contact never ends that hold: not knowing whether a
  child ended is not knowing it did (`:53`–`:56`, ADR 0153). The child reads `needs_you`, with the
  person's question about it on its agent (`:83`–`:87`, `remoteChildStatus`), so the parent can't read done and the person is asked. A report from the machine closes the question by itself; stopping tracking settles the child cancelled and releases the parent; rebuilding the children ledger while contact is lost keeps the one question (`:98`–`:105`, on the same engine). Guarded by
  `machines/remote-child-lost-contact.process.test.ts:23`–`:116`.

## 13. Restarts and resume

- **Cold pass at startup** (`recoverEngine`, `engine/restart.ts:15`): prune transition guards and
  incomplete blobs; then, per thread, each in its own transaction and isolated so one unreadable
  thread is skipped (reported) rather than failing startup: replay legacy limits, repair untracked
  queue counts, settle work a dead provider left (`reconcileStoppedThread`,
  `thread-liveness.ts:236`), write one interruption notice per interruption ("Interrupted by a
  restart" or an unexpected stop, saying whether ace continues; `interruptedNotice`, `:310`),
  hold the queue for the person unless the provider can continue natively
  (`continuesNatively`, `restart-eligibility.ts:11`), and mark sends whose delivery is unknown as
  uncertain.
- **Native continuation** reopens the saved session with `resume`; the daemon passes the runs the
  open turn started and never saw end, from its own committed frames (ADR 0043,
  `SessionContext.resume.unsettled`, `engine-api/src/index.ts:180`). Cursor turns a restart cut
  short are reconciled with Cursor's store once ready (`CursorReconciles`,
  `engine/cursor-reconcile.ts:233`).
- A saved session that can never be opened again moves the thread to the next provider store
  generation and hands off, keeping earlier generations (ADR 0211,
  `engine/provider-recovery.ts:33`).
- Stored engine state carries `engineSchemaVersion` (9, `engine/schema-version.ts:6`); a thread
  whose stored state is from another version or fails to decode is quarantined at startup, never
  the daemon (`startup-quarantine.process.test.ts`).
- Windows: when the previous run's processes can't be proven gone, restart recovery does not
  report that run's provider work as stopped (`previousProcessesUnverified`).
- **Pre-existing defect (ADR 0170).** The threads to recover are found by `recoveryStates`
  (`repository.ts:255`–`:282`): pages of 64, but each page's union filters `threads` on
  `json_extract(status,'$.state')` and `intents` on `awaiting=1 OR uncertain=1`, which no index
  serves, so each page scans tables that grow with history. Readiness walks the set once
  (`engine/index.ts:464`) and `recoverEngine` twice more in one synchronous run
  (`restart.ts:40`, `:342`). What is recovered, and that commands wait with `engine_starting` until
  it is done, is the contract; the unbounded synchronous scan is not, and the Rust pass does it in
  bounded, yielding slices (ADR 0223 §5).

## 14. Partial streams and lenient decoding

- **Translators never throw on provider data.** An exception inside a translator's handler becomes
  one `malformed` diagnostic note with the frame's data (Codex: `adapter-codex/src/translator.ts:594`
  –`:608`; OpenCode `translator.ts:30`; Cursor `translator.ts:131`). Unknown methods and fields are
  kept as raw payloads in diagnostics (`takeDiagnostics`) and produce a `signal` fact, never an
  error (`translator.ts:78`–`:93`). The adapter's own bookkeeping hitting a limit is an
  `adapter.warning` in the daemon log, never the transcript (`engine-api/src/index.ts:65`).
- **Partial output**: a delta before an upsert creates a streaming item; open text, reasoning and
  tool output stay open until completed or until the turn or process ends, when cleanup settles
  them (`exitProcess`, `core/src/cleanup.ts:101`; `endTurn`, `core/src/runs.ts:79`).
- **Lines**: transports frame stdout by lines with a bounded maximum (16 MiB for Claude,
  `adapter-claude/src/sdk-process.ts:50`); an over-long line is dropped with a note, never fatal;
  stderr floods become at most one note a second (`droppedLineNotes`).
- **Binary output** is elided into blobs within the payload budget (`binary-elision.ts`,
  `maxProviderPayloadBytes` 1 MiB, `provider-kit/src/payload.ts:4`).
- **Raw is post-redaction; the wire is not.** The provider receives the original bytes; only the
  capture is redacted. Pi sends the original `line` and builds the `send` frame from
  `this.redact(line)` after the write (`adapter-pi/src/rpc.ts:70`–`:78`). Every adapter redacts a
  frame's encoding before it becomes a `ProviderPayload`, sent and received alike: the ace MCP bearer (Codex
  `adapter-codex/src/session.ts:129`, Claude `adapter-claude/src/session.ts:87`, through
  `redactMcpCredential`, `mcp-server/src/injection.ts:212`), the session's MCP secrets and leases
  (ACP `adapter-acp/src/session.ts:361`–`:372`, `frame-redaction.ts:106`), the server's own
  credentials (OpenCode `adapter-opencode/src/session.ts:325`, `server.ts:112`), and every RPC
  line both ways and stderr (Pi `adapter-pi/src/rpc.ts:50`, `:75`, `session.ts:263`). What the
  engine stores, translates and shows, raw payloads and diagnostics included, is the redacted
  encoding; cleartext never leaves the session.

## 15. Process supervision and containment

Every provider, probe and shell ace starts goes through `@ace/provider-kit/process`
(`spawnSupervised`, `provider-kit/src/process.ts:382`):

- **Ownership marker**: each child carries `ACE_PROCESS_OWNER=<daemon run id>` and inherits it
  down the tree; sweeps match it exactly, never another run's or home's processes
  (`process-marker.ts:13`). Processes meant to outlive ace carry `ACE_PROCESS_KEEP` and no sweep
  signals them (`:82`).
- **Containment**: POSIX children lead their own process group, including grandchildren holding
  the pipes; Windows trees go in a Job Object the kernel kills when the daemon's last handle
  closes, even after a crash (`process-containment.ts`). Linux: the daemon is a child subreaper and
  reaps only adopted zombies it can prove adopted (pid and start time;
  `process-reaper.ts:28`, `:59`).
- **Group signals (the invariant)**: a process group's number is signalled only while ace holds
  its leader unreaped, since the unreaped leader pins the group id and nothing can reuse it.
  The native supervisor (`ACE_SUPERVISOR=native`) enforces this: it reads the leader's exit
  without reaping (`waitid(WNOWAIT)`) and reaps only once two consecutive scans, still held,
  find the group empty. Once the owner has given the group up, at the hold limit it kills the
  still-held group through the daemon's group guard (kept processes and a stop's caller are
  spared, and spared members keep the group held), and again each period after. A group still
  held a period after that kill (a member that never exits, such as one in uninterruptible sleep,
  or a `/proc` that cannot be read) is reported once as a warning and stays held, scanned at a
  low rate, until it empties or the daemon exits. After the reap nothing is signalled by
  group (no member lists, probes or later captures). Group signals need the leader's identity
  (pid and start), never a pid alone. Descendants that left the group (setsid, setpgid) reparent
  to ace, the subreaper, and are stopped one by one by verified identity (pid and start, pidfd
  on Linux). The TypeScript backend can only narrow this (#2711).
- **Inventory and escapees**: owned groups are recorded (pid, kernel start time, owner) in a small
  SQLite journal so the next start or `ace stop` can stop exactly them
  (`ProcessInventory`, `process-inventory.ts:58`; `EscapeeJournal`, `escapee-journal.ts:33`).
  Identity is the strict `ProcessIdentity` (`pid`, `start`, `uid`, `group`,
  `process-identity.ts:197`–`:203`), so a reused pid is never signalled. `start` is encoded per
  platform, and the journal's readers compare it as a string: Linux `<boot_id>:<starttime
ticks>` from `/proc/sys/kernel/random/boot_id` and `/proc/<pid>/stat`, read twice to prove the
  process didn't change (`:244`–`:263`); macOS `<tv_sec>:<tv_usec>` of the kernel start time from
  `proc_pidinfo` (`:265`–`:281`); Windows the creation `FILETIME` and the owner's SID
  (`:285`–`:291`). Rows: `processes(pid, entry)` (`process-inventory.ts:85`) and `escapees`,
  `kept`, `lineage` (`escapee-journal.ts:28`–`:30`).
- **Windows stop**: closing stdin is the graceful stop; the tree is recorded while the leader is
  alive and survivors are ended before the stop resolves (`tree-stop.ts`).
- **Bounded output**: per-process output budget, line framing, and `outputFlow` backpressure on
  every reader (`process.ts`, `line-reader.ts:31`, `flow-control.ts:2`).
- **JSON-RPC** over stdio is one peer per process with bounded pending requests, timers and
  method-not-found replies (`JsonRpcPeer`, `jsonrpc.ts:61`).
- **A channel callback that unwinds poisons its host** (native only, E3-codex.2): a panic in the
  shell's sink is a bug, not a protocol event, so the host catches it once at the drain. The child
  is stopped directly, never through the queue, and a stop decided before the poison counts even
  when its own delivery is what unwound — and never on a child whose pipes have closed: a leader's
  exit alone leaves a tree that still holds them. A stop that unwinds never counts as landed, so
  its owner can ask again.
  A stop in flight is joined by a later retire, a landed one is not repeated, and only a stop the
  shell could not confirm may be asked for again. Every call still pending fails with the host error, and
  every channel gets an exit — one each, since effects already decided keep their place in the
  queue. A write still queued is dropped, never sent to a child that is being stopped: the call its
  line carried has already failed. After the poison each delivery has its own catch: a second panic
  skips that effect, logs it, and the rest still arrives. A stop that did not land leaves the host
  stoppable: its owner's next retire hands the child another stop, since the poison's exits are the
  channels', not the process's. The pool starts a replacement host. TypeScript has no equivalent: a
  throwing JavaScript callback there is an uncaught error, with no defined recovery and no
  replacement host.

## 16. The adapters

| Adapter                    | Transport                                                                                                                                         | Process model                                                                             | Provider library                                                                           | Notes                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Codex                      | JSON-RPC 2.0 over stdio to `codex app-server`                                                                                                     | shared host pool: threads share an app-server process (`host-pool.ts`, `thread-lease.ts`) | none; protocol types generated from `codex app-server generate-ts` (`scripts/generate.ts`) | quotas, review and verifier sessions, background terminals, steer race (`steer-race.process.test.ts`) |
| Claude                     | stream-json over stdio to `claude`, through `@anthropic-ai/claude-agent-sdk` running **in the daemon** with ace's own spawn (`sdk-process.ts:17`) | one CLI process per session                                                               | the Agent SDK (`query`, `forkSession`), also used by the metadata host                     | `backgroundTools`, native queue, injected inputs, compaction                                          |
| Cursor                     | JSON-RPC over stdio to ace's **host child**, which runs `@cursor/sdk` (`host.ts:96`, `host-entry.ts`)                                             | one host child per instance; SDK SQLite store per thread, fenced (`store-fence.ts`)       | `@cursor/sdk` (in the child only)                                                          | frames and records commit in one transaction; checkpoints; restart reconcile                          |
| OpenCode                   | HTTP + SSE to `opencode serve` (`server.ts`, `server-pool.ts`)                                                                                    | pooled servers, spare servers                                                             | `@opencode/client` (HTTP client)                                                           | JS plugins loaded into OpenCode (`agent-env-plugin`, `mcp-ready-plugin`)                              |
| ACP (Antigravity, generic) | ACP JSON-RPC over stdio                                                                                                                           | one agent process per session                                                             | `@agentclientprotocol/sdk`                                                                 | per-agent quirks (`quirks/`), negotiation, mode changes mid-turn                                      |
| Pi                         | JSONL RPC over stdio to `pi --mode rpc` (`rpc.ts`)                                                                                                | one process per session                                                                   | `@modelcontextprotocol/client` for its extension's MCP                                     | a JS extension loaded into Pi (`extension.ts`)                                                        |

## 17. What is atomic with the store

Each line commits in one store transaction, with the events it appends:

- a command receipt, its intent row, queue change and input item (section 3);
- a frame batch's events, thread state header, engine records and provenance; for SDK batches
  also the queue sync; for Cursor SDK batches also the raw frame records (section 4);
- a delivery claim, the queue mark, the steer decision and the admitted input item (section 9);
- each thread's restart pass (section 13);
- each tick's facts with the deadline that fired (section 7).

Established deltas are the one exception: they wait in the store's live buffer (75 ms or 64 KiB,
ADR 0076) and commit in its batch; the snapshot's persist and commit hooks run inside that batch's
transaction (`repository.ts:397`–`:407`). A rolled-back transaction leaves the in-memory state
evicted and re-read (`repository.ts:445`).

## 18. Recorded fixtures and replay

- Recordings live in `fixtures/<provider>/<cli-version>/<scenario>.jsonl` (header
  `ace-recording/v1`, then one frame per line) with a `<scenario>.expect.json` of status
  checkpoints and final counts: Codex 0.159.1 and Claude 2.1.286 (nine scenarios each: approval,
  background shell, interrupt, ace MCP, plan review, question, subagent, background subagent, tool
  read), Cursor SDK 1.0.35 (13), OpenCode 2.0.22 (7), plus `fixtures/acp`, `fixtures/pi`.
- `replayFixture` (`adapter-testkit/src/replay.ts:44`) runs, at each recorded time, the frames in
  order, then `translator.tick`, then core's `tick`, through the adapter's `createTranslator` and
  `@ace/core` `apply`, folds every event into a `ThreadView` with `@ace/projection`, and samples the
  status timeline at each checkpoint. `assertExpectations` compares it with the `.expect.json`.
  No rejected fact may appear (`adapter-codex/src/fixtures.test.ts:24`).
- Fixtures are recorded only by `tools/recorder` on the person's own CLIs, on request. They are
  replayed, never re-recorded, to prove a port.

## 19. The tests that guard this, and which carry over

- **(a)** behaviour through a public interface: `Engine`, `Store` and the server through
  `engine/test-support.ts`, `recovery-test-support.ts` and `transition-test-support.ts`; an
  adapter's `ProviderAdapter`, `openSession` or translator factory with its fake CLI or recorded
  fixture; `@ace/core`'s exports; `@ace/provider-kit`'s process exports. Must pass unchanged on the
  Rust implementation behind its switch.
- **(b)** a test of a TypeScript internal (it imports a module that is not a package export or the
  engine's public class): what it guards, and how that is checked on Rust.
- **(c)** redundant or structural: deletable.
- **—** not part of this move: the code stays TypeScript (it runs inside a provider's JS runtime,
  the Cursor host child, the Claude SDK, or is daemon infrastructure the engine doesn't own) and
  its test runs unchanged.

The 56 test files outside `engine/` that build a real `Engine` (server, agent-control, machines,
services) carry over as (a) the same way and are not listed.

### Engine (`apps/daemon/src/engine/`, 173 files)

| Test files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Class | What they guard                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine.process`, `main-integration.process`, `reliability.process`, `review-regressions.process`, `verification-regressions.process`, `audit-reliability.process`, `status-precedence.process`, `io-lifecycle.process`, `real-thread-state.process`, `interaction-replay.process`, `execution-approval.process`, `resolution.process`, `person-input.process`, `input-origin.process`, `socket-liveness.process`, `streaming-behaviour.process`, `signal-batching.process`, `sdk-burst.process`, `ux-events.process`, `diagnostics-integration.process`, `provider-diagnostics.process`, `provider-goal.process`, `provider-errors.process`, `reactivation.process`                                                                                                                                                                                               | a     | The fold end to end: statuses (section 6), interactions and their resolution, input origin, signal batching, SDK bursts, diagnostics routing, the never-done-while-working invariant.                                                                                                                                                                                                                                           |
| `live-write-buffer.process`, `live-write-quarantine.process`, `storage-behaviour.process`, `long-thread.process`, `records-write-budget.process`, `item-metadata.process`, `maintenance.process`, `schema-compatibility.process`, `startup-quarantine.process`, `cold-state.process`, `resource-limits.process`, `audit-cursor-recovery.process`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | a     | What commits with what (section 17), the live path, record budgets, mailbox limits (section 4), schema version and quarantine (section 13).                                                                                                                                                                                                                                                                                     |
| `submission.process`, `queue-capacity.process`, `queue-context.process`, `queue-recovery.process`, `queue-resend-route.process`, `queue-selection.process`, `queue-transitions.process`, `queued-run-binding.process`, `held-send-release.process`, `input-fate.process`, `input-leases.process`, `late-admission.process`, `overload-delivery.process`, `stale-inputs.process`, `wake-run-inputs.process`, `agent-trigger-admission.process`, `guest-admission.process`, `metadata-commands.process`, `catalog-mentions.process`, `command-catalog.process`, `defaults.process`, `client-model-defaults.process`, `model-selection.process`, `thread-title.process`, `worktree-title.process`, `chat-thread.process`, `organization.process`, `pr-settle-once.process`, `acknowledged-response.process`, `admission-recovery.process`, `switch-admission.process` | a     | Commands, intents, queue and delivery (sections 3 and 9): receipts, refusals, holds, capacity, acknowledgement, uncertainty, input fate. `worktree-title.process` also imports `nameWorktreeBranch` from `worktree-title.ts`: that helper stays TypeScript (git naming is not engine logic).                                                                                                                                    |
| `claude-steering.process`, `claude-steer-boundary.process`, `steer-fallback.process`, `steering-background-tools.process`, `steering-tool-boundary.process`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | a     | Steering (section 10): who preempts, tool boundaries, backgrounding, fallback.                                                                                                                                                                                                                                                                                                                                                  |
| `stop-escalation.process`, `stop-queue.process`, `stop-settles.process`, `settle-closes-hold.process`, `settle-stops-work.process`, `acp-stop-shell.process`, `thread-liveness.process`, `provider-release.process`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | a     | Stop plan, settle, deletion, live work, idle release (sections 8 and 12).                                                                                                                                                                                                                                                                                                                                                       |
| `restart-resume.process`, `restart-origin.process`, `restart-unverified.process`, `recovery-opening-restart.process`, `clock-rollback.process`, `resume-failure.process`, `uncertain-continuation.process`, `open-failure.process`, `git-preparation-failure.process`, `acp-resume-failure.process`, `codex-admission-restart.process`, `migration-recovery.process`, `review-recovery.process`, `context-fallback.process`, `file-attachments.process`, `continuation-attachments.process`                                                                                                                                                                                                                                                                                                                                                                        | a     | Restarts and resume (section 13), open failures, clock steps backwards. `restart-origin.process` recovers an engine from a crash copy and checks the restart continuation is sent once and its echo isn't a second message (`:35`–`:53`).                                                                                                                                                                                       |
| `limit-recovery.process`, `limit-refresh.process`, `codex-usage-limit.process`, `codex-late-ack-quota.process`, `codex-orphan-quota.process`, `cursor-usage-limit.process`, `context-meter.process`, `provider-context-meter.process`, `usage-switch-audit.process`, `usage-switch-recovery.process`, `confirmed-account.process`, `account-switch.process`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | a     | Usage limits, holds and their release, context meters, account switches.                                                                                                                                                                                                                                                                                                                                                        |
| `thread-switch.process`, `provider-switch-matrix.process`, `provider-settings.process`, `transition-acp.process`, `transition-regressions.process`, `context-handoff.process`, `cursor-transitions.process`, `cursor-handoff.process`, `handoff-read.process`, `historical-handoff.process`, `thread-fork.process`, `fork-transcript.process`, `thread-merge-account.process`, `opencode-switch.process`, `delegation-transports.process`, `repository-transfers.process`, `workspace-change.process`                                                                                                                                                                                                                                                                                                                                                              | a     | Transitions: switch, merge, fork, handoff, workspace change. `fork-transcript.process` reads the constant `maxInheritedTextBytes` from `fork-history.ts`; the TS shell keeps exporting it from the binding.                                                                                                                                                                                                                     |
| `permissions.process`, `provider-permissions.process`, `acp-access.process`, `acp-selection.process`, `ace-approvals.process`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | a     | Access and approvals (section 11).                                                                                                                                                                                                                                                                                                                                                                                              |
| `adapter-echo.process`, `attachment-echo.process`, `recorded-ask.process`, `history-replies.process`, `codex-exit-log.process`, `codex-stderr.process`, `adapter-discovery.process`, `pi-discovery.process`, `protocol-noise`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | a     | Real adapters' translators and sessions inside the engine: echoes, attachments, recorded asks, stderr, discovery, unknown protocol noise kept and never fatal.                                                                                                                                                                                                                                                                  |
| `cursor-admission.process`, `cursor-boundary-recovery.process`, `cursor-busy-store.process`, `cursor-disk-full-retry`, `cursor-fresh-session`, `cursor-output.process`, `cursor-queue-integration.process`, `cursor-recovery.process`, `cursor-second-crash.process`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | a     | Cursor SDK admission, records committed with facts, restart reconcile, busy store, disk full, second crash against the real host child.                                                                                                                                                                                                                                                                                         |
| `silence`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | a     | Silence thresholds across new, recovered and live threads. It builds an `EngineRepository` to seed state; on Rust that seeding goes through `Engine` commands in the test's own helper, the only edit allowed, and only if the binding cannot expose the repository.                                                                                                                                                            |
| `ace-approvals`, `actor-timer`, `agent-env`, `edited-context`, `fact-bytes`, `frame-envelope`, `item-metadata`, `permission-ceiling`, `root-run-start`, `settled-hold`, `steer-yield`, `retired-bot-threads`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | b     | Pure engine helpers: the ace call an approval belongs to; timer re-arming (`keepsTimer`); agent environment; edited context; fact byte counts; envelope checks; item metadata; permission ceilings; root run start; settled holds; yielded ends; retired bot threads. On Rust each becomes a `#[cfg(test)]` module beside the ported function with the same cases (the test moves), and the TS file is deleted with its module. |
| `adapters`, `registry`, `cursor-migration.process`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | b     | Adapter discovery and the registry (`discoverAdapters`, `AdapterRegistry`). On Rust: the registry's cases move to `ace-engine` unit tests; discovery keeps running through `adapter-discovery.process` and `pi-discovery.process` (a).                                                                                                                                                                                          |
| `cursor-attempt-record`, `audit-record-cache.process`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | b     | Cursor attempt records (`provider-recovery.ts`) and the engine record cache (`records.ts`). Move to `ace-engine` unit tests of the same records; behaviour also covered by `cursor-recovery.process` and `records-write-budget.process` (a).                                                                                                                                                                                    |
| `open-text-restart.process`, `restart-ledgers.process`, `session-bound-tasks.process`, `snapshot-release.process`, `snapshot-rollback.process`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | b     | Repository-level restart and snapshot rules (open text after restart, ledgers, session-bound tasks, snapshot release and rollback), driven on `EngineRepository` and `createEngineThread` directly. Move to `ace-engine` tests over a temp `ace-store`; the rollback rule is also held by `storage-behaviour.process` (a).                                                                                                      |
| `record-budget.process`, `snapshot-retention.process`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | b     | That the TypeScript record caches release memory (measured in a worker's JS heap). On Rust the cache is a bounded `lru` map; its bound moves to a unit test of `ace-engine::records`, and these two files go with the TS cache.                                                                                                                                                                                                 |

No engine test file was found redundant with confidence; deletion happens through (b) as modules
move.

### Reducer (`packages/core/src/`, 40 files)

| Test files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Class | What they guard                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reducer`, `status`, `thread-status`, `transport-status`, `review-status`, `moved-status`, `delegated-children`, `tree`, `scenarios`, `snapshot`, `event-delivery`, `fixture-edges`, `empty-deltas`, `partial-stream`, `large-output`, `legacy-output`, `reconciled-item`, `background-precedence`, `background-release`, `subagent-wait`, `spawn-repair`, `stable-signals`, `deadline-review`, `audit-deadlines`, `audit-liveness`, `audit-process-exit`, `lifecycle-review`, `validation-review`, `diagnostics`, `interaction-defaults`, `quota-replay`, `usage-metadata`, `acp-lifecycle`, `adapter-contracts`, `storage-retention`, `provider-readiness`, `provider-admission`, `ace-tools`, `package-runtime.process` | a     | Sections 5 to 7: the fold, every status rule, deadlines, rejection of invalid facts, partial streams, client replay equality (`client-view.test-helper.ts` folds every event and checks it matches state). Run through the `@ace/core` facade over the native core; the facade materialises `ThreadState` for tests that read it. |
| `shared-work`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | —     | `SharedWork`, an async helper the daemon uses outside the reducer; stays TypeScript.                                                                                                                                                                                                                                              |

### Adapter test kit (`packages/adapter-testkit/src/`, 5 files)

`replay`, `replay-edges`, `scripted`, `turn-provider`, `cli.process`: **a**. Fixture replay,
scripted adapters (the engine tests' fake providers) and the replay CLI. They run through the
`@ace/core` facade and stay the harness the other tests use.

### Codex (`packages/adapter-codex/src/`, 61 files)

| Test files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Class | What they guard                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fixtures`, `translator`, `answer-echo`, `command-display`, `context-usage`, `history-assembly`, `hydration-identity`, `live-smoke`, `partial-stream`, `provider-title`, `quota-hydration`, `recovery-ordering`, `review-translator`, `stderr`, `streaming`, `subagent-names`, `turn-trigger`, `unseen-history`, `usage`, `verifier-translator`, `goal`, `capabilities`, `minimum-version.process`, `provider-settings.process`                                                                                                                                                                                                                                                                                                                         | a     | The translator through `createCodexTranslator` and core, recorded fixtures, capabilities and version gates.                                                                                                                                                                                             |
| `session.process`, `ace-mcp-approvals.process`, `ace-tool-listing.process`, `admission-retirement.process`, `answer-echo.process`, `catalog-idle.process`, `catalog-input.process`, `cmd-shim-session.process`, `delegation-context.process`, `exit-diagnostics.process`, `fork-selection.process`, `hydration-interactions.process`, `inherited-pipes.process`, `item-invalidated-recovery.process`, `late-ack-quota.process`, `mcp-controls.process`, `missing-ack-quota.process`, `native-tools.process`, `overlapping-recovery.process`, `oversized-lines.process`, `paged-history.process`, `permissions.process`, `review-recovery.process`, `review-session.process`, `shutdown-drain.process`, `steer-race.process`, `verifier-session.process` | a     | Sessions against the fake app-server (`testing/cli.ts`, `shared-cli.ts`, `oversized-cli.ts`) through `adapter.openSession`. They import key helpers (`requestKey`) from `native.ts`, which stays as a TS module of constants until the TS adapter is deleted, then moves into `session.test-helper.ts`. |
| `shared-host.process`, `thread-lease.process`, `host-retire`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | b     | Threads sharing one app-server, leases, host retirement, driven on `HostPool`/`host.ts`. On Rust: the cases move to tests of `ace-adapter-codex::host_pool` against the same fake app-server; `session.process` (a) keeps the shared-host path covered end to end.                                      |
| `dropped-line`, `permission-policy`, `session-lifetime`, `shell-env`, `tool-facts`, `tool-search`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | b     | Pure helpers: dropped-line notes, permission policy mapping, session lifetime, shell environment policy, tool facts, tool search. Move as unit tests beside the ported functions.                                                                                                                       |
| `live`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | a     | Opt-in live check of the installed CLI (`ACE_LIVE_CLI=1`); never run by builders.                                                                                                                                                                                                                       |

### Claude (`packages/adapter-claude/src/`, 50 files)

| Test files                                                                                                                                                                                                                                                                                                                                                                                                                         | Class | What they guard                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fixtures`, `translator`, `audit-lifecycle`, `background-output`, `background-owner`, `compaction`, `consumed-inputs`, `context-usage`, `deferred-budget`, `goal`, `injected-inputs`, `integration`, `late-tools`, `live-smoke`, `ordering`, `resumed-subagent`, `review`, `sdk-gaps`, `settlement`, `steering`, `subagent-names`, `synthetic-notes`, `terminal-history`, `tools`, `unbound-children`, `ux-errors`, `verification` | a     | The translator through the adapter's translator factory and core, recorded fixtures.                                                                                                                                   |
| `session.process`, `attachment-frames.process`, `catalog-input.process`, `child-control.process`, `cmd-shim-session.process`, `fork-selection.process`, `fork.process`, `input-rejected.process`, `minimum-version.process`, `native-tools.process`, `permissions.process`, `sdk-controls.process`, `steer-backgrounding.process`, `tool-search-listing.process`                                                                   | a     | Sessions against the fake `claude` CLI (`testing/cli.ts`) through `adapter.openSession`.                                                                                                                               |
| `metadata-host.process`, `cmd-shim-metadata.process`, `usage-read`                                                                                                                                                                                                                                                                                                                                                                 | —     | The metadata host (model discovery through the SDK) and the usage reader; stay TypeScript.                                                                                                                             |
| `ace-listing`, `cli-versions`, `question-skip`, `sdk-process`, `sdk-stderr.process`                                                                                                                                                                                                                                                                                                                                                | —     | ace tool listing text, CLI version table, skipped questions, the SDK spawn bridge and its stderr: Claude's session stays TypeScript behind the bridge (ADR 0223, decided by the orchestrator), so these run unchanged. |
| `live`                                                                                                                                                                                                                                                                                                                                                                                                                             | a     | Opt-in live check.                                                                                                                                                                                                     |

### Cursor (`packages/adapter-cursor/src/`, 48 files)

| Test files                                                                                                                                                                                                                                                                                                                                               | Class | What they guard                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fixture`, `behavioural-fixtures`, `transcript`, `children`, `diagnostics`, `body-stream`, `recovery-translation`, `audit-exit`, `ace-tool-errors`, `host-evidence`                                                                                                                                                                                      | a     | The translator and core, recorded SDK fixtures. `diagnostics` (and the session files `errors.process`, `host-output.process`, `recovered-seam.process`) build it as `new CursorTranslator(...)`; the switch sits at that exported class (ADR 0223 §8), so they run the native translator unchanged.                                      |
| `session.process`, `admission`, `agent-env.process`, `checkpoint-recovery.process`, `errors.process`, `history.process`, `host-fatal.process`, `host-output.process`, `input-rejected.process`, `model-params.process`, `native-tools`, `permissions`, `recovered-seam.process`, `selection-drain.process`, `skills.process`, `sandbox-lifetime.process` | a     | Sessions through the adapter with the real host child: admission, checkpoints, fatal host errors, output, refusals, recovered seams.                                                                                                                                                                                                     |
| `host-ack.process`, `host-frame-storage.process`, `host-stderr.process`, `host-stop.process`, `host-stray-output.process`, `sdk-admission.process`                                                                                                                                                                                                       | b     | The daemon side of the host wire (`host.ts`) driven directly against the real host child: acknowledgements, frame storage, stderr, stop, stray output, admission. On Rust the daemon side is `ace-adapter-cursor::host`; these cases move to its tests against the same child, and the session (a) tests cover them through the adapter. |
| `frame-batch`, `tool-guidance`                                                                                                                                                                                                                                                                                                                           | b     | Frame batching contract and tool guidance text; move as unit tests.                                                                                                                                                                                                                                                                      |
| `api-key.process`, `auth.process`, `auth-lifecycle.process`, `login`, `host-console.process`, `host-lifecycle.process`, `host-fence.process`, `model-errors.process`, `model-discovery`, `store-fence`, `ripgrep-path`, `sandbox-helper.process`, `user-settings.process`, `user-tools.process`                                                          | —     | Code that runs in the host child or the SDK's credential worker (it imports `@cursor/sdk`), or sign-in; stays TypeScript.                                                                                                                                                                                                                |

### OpenCode (`packages/adapter-opencode/src/`, 41 files)

| Test files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Class | What they guard                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fixture`, `v2`, `history-replies`, `injected-inputs`, `turn-end-text`, `turn-settlement`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | a     | The translator (`OpenCodeTranslator` through `replay.ts`) and recorded fixtures.                                                                              |
| `v2-session.process`, `v2-lifecycle.process`, `v2-review.process`, `v2-scoped-mcp.process`, `v2-transport.process`, `v2-accounts.process`, `agent-env.process`, `ancestry-receipts.process`, `ancestry-recovery.process`, `ancestry-shells.process`, `covered-ancestry.process`, `outstanding-ancestry.process`, `catalog-input.process`, `large-attachments.process`, `location-rebuild.process`, `metadata-errors.process`, `native-commands.process`, `native-tools.process`, `open-failure.process`, `permissions.process`, `prompt-refusal.process`, `server-pool-recovery.process`, `server-stderr.process`, `session-close.process`, `shim-launch.process`, `skills.process`, `spare-servers.process`, `version-upgrade.process`, `provider-settings.process` | a     | Sessions against the fake server (`testing/cli-v2.mjs`, `testing/v2-session.ts`): server pool, SSE transport, ancestry, MCP scoping, spare servers, upgrades. |
| `mcp-locations`, `native-content`, `permission-policy`, `redaction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | b     | Pure helpers: MCP config locations, native content mapping, permission policy, redaction. Move as unit tests.                                                 |
| `contract`, `mcp-readiness`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | —     | The JS plugins OpenCode loads (`agent-env-plugin`, `mcp-ready-plugin`) and their contract; stay TypeScript.                                                   |

### ACP (`packages/adapter-acp/src/`, 35 files)

| Test files                                                                                                                                                                                                                                                                                                                                             | Class | What they guard                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | ---------------------------------------------------------------------------------------------------------------------- |
| `translator`, `approvals`, `approval-ids`, `compatibility`, `frame-order-translator`, `integration-restart`, `partial-input`, `review-translator`, `terminal-updates`, `tool-render`, `tool-updates`, `turn-settlement`, `ux-titles`, `verification-translator`, `child-diagnostics`, `identity-diagnostics`, `negotiation`, `capabilities`            | a     | The translator through `createAcpTranslator` with each agent's quirks, and core.                                       |
| `session.process`, `agent-env.process`, `catalog-input.process`, `frame-order.process`, `guidance.process`, `launch-effort.process`, `negotiation.process`, `permission-selectors.process`, `permissions.process`, `provider-settings.process`, `retention.process`, `shim-session.process`, `update-approval.process`, `verification-session.process` | a     | Sessions against the fake ACP servers (`testing/*-server.ts`): negotiation, frame order, permissions, retention bound. |
| `configuration`, `frame-redaction`                                                                                                                                                                                                                                                                                                                     | b     | Launch configuration and frame redaction; move as unit tests.                                                          |
| `live`                                                                                                                                                                                                                                                                                                                                                 | a     | Opt-in live check.                                                                                                     |

### Pi (`packages/adapter-pi/src/`, 20 files)

| Test files                                                                                                                                                                                                                                                                                            | Class | What they guard                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------- |
| `translator`, `translation-scaling`, `turn-boundary`, `edit-changes`, `history-errors`                                                                                                                                                                                                                | a     | The translator through `createPiTranslator` and core.                                   |
| `session.process`, `catalog-input.process`, `delegation-context.process`, `fork.process`, `history.process`, `input-rejected.process`, `permissions.process`, `shim-session.process`, `skills.process`, `system-prompt.process`, `tool-exposure.process`, `tool-listing.process`, `extension.process` | a     | Sessions against the fake Pi (`testing/fake-pi.ts`, `harness.ts`, `extension-host.ts`). |
| `extension-mcp`, `launch-args`                                                                                                                                                                                                                                                                        | b     | The extension's MCP bridge config and launch arguments; move as unit tests.             |

### Process layer (`packages/provider-kit/src/`, 82 files)

| Test files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Class | What they guard                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `process.process`, `buffering.process`, `output-bounds.process`, `process-stop.process`, `fast-exit.process`, `directory-processes.process`, `process-bytes.process`, `process-owner.process`, `process-containment.process`, `process-identity.process`, `process-inventory.process`, `process-inventory.restart.process`, `process-interactive.process`, `process-interactive.native.process`, `process-env.process`, `tree-stop.process`, `line-backpressure.process`, `pressure-framing.process`, `probe-cancel.process`, `jsonrpc.process`, `jsonrpc-boundary.process`, `jsonrpc-disposal.process`, `jsonrpc-lifetime.process`, `jsonrpc-limits.process`, `jsonrpc-replacement.process`, `sse-parser`, `jsonl`, `live.process` | a     | Section 15 through `@ace/provider-kit`'s process, stream and JSON-RPC exports, run unchanged with the native supervisor behind them.                                                                                                                                                                                                                                                                               |
| `process-containment`, `process-identity`, `process-inventory`, `process-owner`, `process-ownership`, `process-tree`, `process-tree-state`, `process-env`, `inventory-retry`, `output-budget`, `dropped-line-notes`, `binary-elision`, `elision`, `data-url`, `record`                                                                                                                                                                                                                                                                                                                                                                                                                                                              | b     | Pure parts of supervision and output handling with injected fakes (Win32 surface, `ps` output, lineage). They move as unit tests of `ace-supervisor` modules; the TS files go with the TS modules, except where TS code outside the move still uses the module (`elision`, `data-url`, `record` stay with it).                                                                                                     |
| `process-on-node.process`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | a     | On Node (the release runtime), probes and supervised processes stop with their descendants on timeout and abort (`:74`, `:85`), and an owner that exits takes its owned process group with it (`:150`). Kept in `nodeOnlySuites` (`scripts/test-tiers.ts:71`) and run on Node against the native supervisor: the addon is loaded by Node as well as Bun, and this is the file that proves containment holds there. |
| `discovery/*` (13), `probe-resolve`, `probe-runner.process`, `probe-thread.process`, `probe-thread-owner`, `probe-thread-stall`, `idle-window`, `idle-worker.process`, `idle-worker-restart`, `idle-worker-window`, `worker`, `worker-context`, `console-guard.process`, `memory-watchdog`, `resident-memory.process`, `child-priority`, `sqlite-backup.process`, `sqlite-read-only`, `sqlite-read-only.process`, `test-isolation.process`, `access-modes`, `cli-versions`, `open-error`, `shell-command`, `wire-shape`, `bounded-cache`                                                                                                                                                                                            | —     | CLI discovery and probes, worker infrastructure, SQLite wrappers and policy tables the engine move does not touch.                                                                                                                                                                                                                                                                                                 |

Counts: engine 173 (a 149, b 24); core 40 (a 39, — 1); test kit 5 (a 5); Codex 61 (a 52, b 9);
Claude 50 (a 42, — 8); Cursor 48 (a 26, b 8, — 14); OpenCode 41 (a 35, b 4, — 2); ACP 35
(a 33, b 2); Pi 20 (a 18, b 2); process layer 82 (a 29, b 15, — 38). In all 555 files: 428
(a), 64 (b), 0 (c), 63 (—).

## 20. Differences the Rust port records

Behaviour the TypeScript daemon has today that the Rust port does not copy, because the
TypeScript behaviour is a defect (owner decision, 2026-11-24: bugs found in the TypeScript
daemon are fixed in the Rust port only, never on main). Each has a native-only test beside the
Rust that replaces it; when the TypeScript engine is deleted, this section becomes the changelog
of those fixes.

| Area              | TypeScript today                                                                                                                                                                                                  | Rust                                                                                                                                                                                                                                                                           | Test                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Rollback sync     | One global `snapshotGeneration` (`repository.ts:204`): a resident snapshot spared by one sync while a live write is pinned is never checked against a later generation, so a rolled-back state can stay resident. | The generation is kept **per snapshot**. A pinned snapshot keeps its old stamp and is checked again after its own commit (E5.3 step 8, `repository/residency.rs`).                                                                                                             | `repository::save`'s rollback cases.                                                  |
| Quarantine        | A quarantined live write evicts the snapshot only through its actor (`actor.ts:276`), so a thread with no actor keeps the discarded buffer's state resident at the stored `seq`.                                  | The engine's quarantine listener evicts and releases the snapshot whether or not an actor exists, then tells the actor (`repository/residency.rs::quarantined`).                                                                                                               | `persistence.test.ts`, "a quarantined thread with no actor reloads its stored state". |
| Restarted thought | Closing a streaming thought after a restart relies on the core's proxy reads: `state.items[key]` loads the record when `turn.ended` reads the open-text index.                                                    | The enumerated index sections' records are loaded with the index (`snapshot/mod.rs::load_indexes`), so a thought streaming before a restart closes when its turn ends.                                                                                                         | `snapshot::tests::a_thought_still_streaming_at_restart_closes_when_its_turn_ends`.    |
| ACP send refusal  | An input whose mention never resolved throws out of `nativeCommandInputs` **before** `send`'s try (`adapter-acp/src/session.ts:602`), so an input that never ran reaches the engine as an unexpected failure instead of a refusal it may send again. | The Rust admission refuses it as `InputRejected` (`ACE_INPUT_REJECTED`) before anything is queued, so the engine knows the input is unread (`session/input.rs`). | `input::a_command_that_never_resolved_is_refused_as_input`. |
| Record budget     | A state read (`state()`) caches nothing: every section is a lazy proxy, so a reloaded thread's budget is empty until core reads a record.                                                                         | The index sections core enumerates are read at load (they are the live set, never the transcript), so a reloaded snapshot's budget holds those few short rows. The bounded limit (8192 entries / 8 MiB, `records/budget.rs`) and every other section's laziness are unchanged. | `persistence.test.ts`, the rolled-back fold case.                                     |

### Startup retry classification, and the JavaScript message gap

`skippableAtStartup` refuses a store retry: SQLite's primary busy (5), locked (6) and full (13)
codes, masked off the extended code the store reports, are retried, never skipped. The store's own
`"Store is busy"` and a pinned live batch that is retrying arrive as port errors, and are retried
too. A JavaScript error that reaches Rust as a message alone (`ports.rs` keeps only the reason
text) cannot be classified by code: a JavaScript `"database is locked"` is reported and retried as
a damaged thread would be skipped. Recorded here as a gap; closing it needs the port error to
carry SQLite's code.
