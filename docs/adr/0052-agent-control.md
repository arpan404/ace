# 0052: Scoped agent control and durable cross-provider delegation

Date: 2026-10-02. Status: accepted for implementation.

## Context

Agents need to delegate to another local provider while preserving each provider's native history. ADR 0004 requires completion to include the entire tree. ADR 0007 makes the engine the sole owner of provider execution. ADR 0010 binds MCP callers to ephemeral thread and agent credentials. The Orchestrator V2 release notes are a feature reference only. No t3code or legacy source was read.

The first deliverable allocated 0050 above origin/main 0049 and the open PRs at that time. Before delivery, a concurrent Pi PR (#68) also used 0050, and fork/switch PR #69 used 0051. Rechecking main and open PRs reserved 0052 for this feature.

## Decision

Add schema-only agent-control contracts and exports. Delegation policy and result formatting belong to @ace/orchestrator, with injected time and identifiers. The daemon registers its service through ordered composition, without editing server.ts.

A delegated child is an independent engine thread with its own native session. A durable edge records its parent thread and authenticated parent agent, role, requested model/account, options and request receipt; the engine session row persists the scheduler-selected account. The parent tree contains a summary agent pointing to the child thread. That agent derives status from the child's whole thread, including grandchildren, questions, approvals, queues and background work. Parent process exit cannot terminate independently owned child work. Child transcripts remain paged in their own threads.

Admission commits the edge, engine creation intent and parent linkage together. Thread creation supports a caller-owned idempotent identity at the trusted engine boundary. A launch failure is a reported result, never invisible work. Account selection uses the accounts scheduler and persists its assignment before launch. Explicit exhausted or mismatched accounts are rejected. Default local accounts remain usable when no managed instances exist. Launch options are bounded, schema-validated and capability-gated by the adapter; unsupported option keys fail before creating a thread, and provider-specific values are validated before opening a CLI session. Options never carry provider credentials or permission grants.

Per-thread concurrency, root-tree child count, depth, elapsed time, tokens and reported cost have host-owned caps. Child input cannot raise those caps. Admission and completion use indexed rows and counters. Cancellation records durable control intents and visits descendants in depth order. Interrupt acceptance alone does not prove termination. Stopping pending input prevents a cancelled child from launching later. A stopped parent suppresses result wakes, but child outcomes remain readable. Durable subtree stop markers survive settlement and restart. An explicit accepted follow-up can reopen a settled subtree, clearing only that thread's stop marker after checking ancestors and root budgets. Automatic result turns cannot clear stops. Cascade receipt identities include the cancellation request and child generation; retrying an old interruption cannot cancel a new generation.

Completion is based on aggregate thread settlement, not run end. A short injected timer coalesces completions for the same parent. Pending results survive restart. One durable command carries each batch and its stable command id, including each child's result generation. Every accepted engine send to a delegated thread, including UI and MCP follow-ups, reopens a settled edge inside its command receipt and preserve its native thread; retried messages never reopen it a second time. It starts a queued parent turn with trigger subagent_result after the parent's own foreground work settles. Linked children do not prevent that result turn from running. Human approval or background work in the parent's own provider still prevents delivery. Results contain bounded excerpts plus thread/item pointers. Reads and waits do not consume results. An agent may choose to await a child inside the tool call or continue and receive a later wake. Tool timeout only ends the observer; accepted child work survives.

Restart never silently repeats uncertain provider sends. Engine recovery reports uncertain delivery. The delegation journal reconciles existing children, retains pending starts and unconsumed results, and reuses committed command receipts for wakes. Uncertain children report failure with their retained transcript rather than a false success or an extra provider session.

## Authorization and thread tools

MCP authority always comes from the lease, never input attribution. Read and write access are limited to the caller's workspace and delegation family. A child can read its ancestors and siblings but cannot interrupt or mutate them. A parent can control descendants. Independently created threads are registered as owned children before launch. Project operations can only address the caller's registered workspace, and never accept arbitrary paths.

Expose create, launch, message, wait, paged read, search, interrupt, question answer, title updates, PR links, settle, snooze, automation/project management, worktree handoff and preview list/close through typed service ports. Question answering validates both the stored request kind and the answer kind immediately before accepting the existing engine resolution command. No approval, plan-review, elicitation, review approval, arbitrary-command tool is exposed. Even a parent cannot approve a child's permission request.

Fork/merge and queue edits/reordering call their owning service when registered. Missing services return an explicit unsupported capability result, including when an adapter advertises native fork but no fork executor exists. Manual/scheduled automation jobs use the existing automation owner with zero jitter and durable thread ownership. Worktree handoff first reserves durable admission, then uses Git's worktree owner and starts an independent linked child. Reservations count against concurrency, tree totals and the journal cap before filesystem effects. Cancellation owns the Git I/O lifetime and is checked again immediately before accepting the workspace, preparation and launch. Failed or revoked work removes its newly registered worktree and unchanged branch, rolls back workspace creation and releases admission. Startup cleans incomplete handoff intents before new handoffs. Cleanup that encounters changed/dirty user resources or an uncertain orphan branch fails closed and keeps its bounded reservation for recovery. Preview closes share one cleanup promise per registration. Host-registered preview descriptors carry thread ownership and close callbacks; unowned gateway/listener ports remain inaccessible. File/GitHub automation triggers require host integration. Optional feature ports also fail closed when the daemon has no executor. This avoids competing implementations while parallel feature branches land.

Add context items of type thread_ref. The context owner resolves an authorized reference to a bounded summary and paged transcript pointers. Attached content is labelled untrusted data and does not expand write authority. Resolution has an aggregate byte budget and preserves an explicit truncation marker.

## Bounds and verification

No streaming delta scans delegation history. Status/usage events point-read their owning edge and update only changed ancestors, bounded by depth. SQLite owns durable history, indexed active counts, result batches and deadlines. Prepared statements are reused. At most 64 children per tree, 8 levels, 64 observers and one service timer for indexed result/deadline work are retained, with rejection/backpressure at capacity. A transactional singleton counter and insert/delete triggers track receipt capacity; no admission counts historical rows. Delegation receipts reject admission at 10,000, which a host may lower; current children across roots are capped at 64. Paged tools cap both item counts and bytes. Results retain previews, never full output buffers.

Write adapter-testkit behaviour tests for cross-provider wait/wake, batched completion, whole-tree waiting, cascading cancellation, concurrency/depth/budget rejection, question-only authorization and restart reconciliation. Add non-gating benchmarks for delegation admission and change-driven completion propagation. The repo owner's latest rule prohibits local tests, probes, mutation runs and benchmark execution. Run only formatting, lint, type and source-size checks. Document at least eight mutation cases as not executed, tests run at merge. Runtime and performance numbers need run at merge.

## Integration with the current main branch

ACP selections carry the explicit approved agent/installation/instance identity from ADR 0044; they never infer an ACP installation from a provider name or pretend native account scheduling supports ACP. ACP uses its registry-owned HTTP/stdio MCP injection. Claude's daemon controls reuse the engine-owned scoped lease, including after MCP server replacement; Pi registration reuses it too. OpenCode v2's process-wide MCP configuration requires account-and-lease isolation in its bounded server pool, while sessions without scoped MCP retain account sharing. User MCP definitions survive injection. Engine input acknowledgements retain ace's explicit triggers alongside native input-admission correlation, so autonomous turns release queue ownership. Native lease secrets remain ephemeral and are redacted before persistence. Canonical client thread/Forge/automation owners, fork/merge and queue integrations remain typed owner ports until their branches land.

## Amendment: monitoring and bounded waits, 2026-10-13

Agents and people need to wait on several children or threads without polling and without
holding a provider turn indefinitely.

- **One wait primitive.** `wait` takes `threadIds` (1 to 64), `mode` (`all` by default, or
  `any`) and `timeoutSeconds` (default 120, at most 600). It covers delegated children and any
  other thread the caller may read. It returns `status` (`ready`, `needs_you`, `timeout`,
  `interrupted`) and, per thread, `state` (`working`, `needs_you`, `done`, `failed`,
  `cancelled`), its result excerpt once settled, or its current step, last output line and the
  requests waiting on the person. A request for the person returns early in both modes, and a
  thread waiting on the person is never reported done. Settlement uses the existing whole-tree
  aggregate. A timeout ends only the observation; the agent may wait again. Daemon shutdown
  resolves every pending wait as `interrupted`, so a restart never leaves a caller hanging. The
  separate single-thread wait tool was folded into it.
- **Monitoring.** `agents_status` returns a compact snapshot of every delegated descendant:
  state, step, elapsed seconds, request count and first request, last output line, with clipped
  fields so twenty children stay under 8 KB. Given a `threadId`, it returns that child's result
  once settled; it replaced the separate list, status and result tools.
- **One way to start child work.** `delegate` takes a batch only: `{tasks: [...], waitSeconds?,
waitFor?}`, 1 to 64 tasks, each with its own stable `requestId`. The provider defaults to
  the caller's, and the daemon resolves a model to an account or instance. The older `wait`,
  `waitMs`, `await` and `timeoutSeconds` inputs are gone. Tasks are admitted in order through
  the same admission path; a retried batch creates no new threads. The spawn tool is retired,
  and `thread.create`/`thread.launch` are host-internal and no longer advertised over MCP.
  `thread_start` remains for top-level conversations.
- **Parent state.** While an ace wait tool call is live (`wait`, or `delegate` with a
  wait), the engine marks the calling agent as waiting on the named `ace-child:` summary agents
  (`subagents.waiting`), so the parent reads "Waiting on N subagents" and never done.
- **Push.** No supported provider surfaces MCP server notifications to the model, so ace keeps
  its provider-agnostic push: a settled child queues a `subagent_result` turn on the parent.
  A child that needs the person raises the parent thread to needs-you through its summary agent
  and returns early from any wait. Results read inside a wait are recorded once and never wake
  the parent again.
- **CLI.** `ace thread wait` and `ace task wait` take several ids with `--any` or `--all`
  (default) and the global `--timeout`, with the existing exit codes: 0 ok, 1 failed, 2
  needs-human (returned as soon as any thread needs the person), 3 timeout, 5 uncertain.
- Wait and status are `read-only`, so their tool annotations carry `readOnlyHint`.

## Amendment: Stop and proof of life, 2026-11-01

A live case: a thread delegated four Codex children to a paired machine whose sessions never
opened there. Each sat in `needs_you` there for six hours. `agent_cancel` was accepted and the
person pressed Stop, yet the parent kept "Waiting on background task" and listed them as
running. Three faults met:

- the parent's cancel was fire-and-forget: the hold on a remote child ended only when its
  machine reported a settled state;
- on that machine, the cancel's cascading Stop overwrote the "Not sent" hold with `stopped`, and
  a queue paused by Stop with input kept still read as waiting to send, so the child read
  `needs_you` forever;
- nothing anywhere says "no proof of life means not live".

### Rule

1. **Stop is final.** A Stop runs a bounded sequence and then marks the item stopped and stops
   tracking it, whether or not the other side confirmed. When it never confirmed, ace says so
   in words ("Stopped · didn't confirm") and records it. A later report takes the item's real
   final state but never makes it live again.
2. **No proof of life means not live.** Every live state has a lease: an owner that renews it
   with proof, and an expiry. A lapsed lease is **lost contact**: not running, waiting or done,
   and it no longer holds its parent. Proof arriving again resumes it.
3. **Priority 1 holds.** Only stopped and lost items stop counting. A needs-you item keeps its
   parent open while it is reachable; a remote one whose machine stopped reporting goes to lost
   after the lease, and can still be stopped.

### One model, pure core

`apps/daemon/src/liveness/` holds the rules, with the clock injected and no I/O:

- `stop.ts`: a stop plan is a list of attempts, each with a wait. `nextStop(plan, progress,
now)` answers attempt, wait or give up. Progress (`startedAt`, `attempts`, `lastAttemptAt`)
  is kept by the caller, durably where it must survive a restart. The bound runs from the stop
  itself, so a stop read again after a restart past its bound gives up at once.
- `lease.ts`: `contact(lease, now)` is live until `renewedAt + ttlMs`, then lost. A renewal never
  moves a lease backwards; proof stamped ahead of a clock that went back counts for one lease.
- `standing.ts`: one reading per item (live, stopping, stopped unconfirmed, lost, ended) and
  `holdsParent`, which is true only for live work and a stop inside its bound.
- `bounded.ts`: a step that doesn't answer within its bound fails with `StopUnanswered`, so the
  stop moves to its next step.

Constants:

| Name                     | Value                         | Use                                                       |
| ------------------------ | ----------------------------- | --------------------------------------------------------- |
| `INTERRUPT_GRACE_MS`     | 3 s                           | provider interrupt answers, then the session closes       |
| `TERMINATE_GRACE_MS`     | 3 s                           | after SIGTERM, before SIGKILL (command jobs; close bound) |
| `KILL_GRACE_MS`          | 2 s                           | after SIGKILL, before calling it stopped regardless       |
| `PROCESS_STOP`           | interrupt → SIGTERM → SIGKILL | 8 s in all                                                |
| `SIGNAL_STOP`            | SIGTERM → SIGKILL             | a process with no interrupt of its own                    |
| `REMOTE_CANCEL_WAITS_MS` | 3, 6, 12, 24 s                | the cancel to another machine, sent again                 |
| `REMOTE_STOP`            | four cancels                  | 45 s in all                                               |
| `REMOTE_CHILD_LEASE_MS`  | 10 min                        | a remote child with no report is lost contact             |

### What each source does now

- **Remote children** (`machines/child-liveness.ts`, `machine_children` columns `seen_at`,
  `silent_since`, `stop_started_at`, `stop_attempts`, `stop_last_at`, `stopped_unconfirmed`).
  Stop (the person's Stop on the hold, `agent_cancel`, a cascading Stop) starts `REMOTE_STOP`:
  each cancel goes to the machine; a report of its end settles it with its real outcome. After
  the last wait it settles cancelled with `contact: "unconfirmed"`, the hold ends `stopped`, the
  parent gets a result saying the machine never confirmed, and its mirrored requests close.
  Every status reply renews the lease (one write a tenth of a lease at most). A child with no
  reply for `REMOTE_CHILD_LEASE_MS` gets `contact: "lost"`: its hold ends `unknown`, a wait
  reads it as `failed` and returns, and it resumes (a fresh hold) when it reports. A lost child
  can still be stopped. At startup leases count from the daemon's own start, as downtime here
  is not silence there; stops pick up from their saved progress.
- **Remote target** (`machines/target-threads.ts`). A cancel from the parent's machine retires
  the child's queued input there, as a local delegated child's cancel does, so a child held on
  a message that was never sent settles.
- **Queue kept by a Stop** (`core/status.ts`, `queue.changed.stopped`). Input a Stop kept for the
  person's Resume sends nothing by itself: the thread reads at rest, not `waiting{queue}`. Its
  attention still asks for the Resume (superseded: a Stop asks nothing, see the amendment below).
- **Provider sessions** (`engine/delivery.ts`, `engine/sessions.ts`). The provider's interrupt
  has `INTERRUPT_GRACE_MS` to answer. Past it, a whole-thread Stop closes the session, whose
  adapter sends SIGTERM then SIGKILL to the process group. A close that fails or doesn't answer
  within `TERMINATE_GRACE_MS + KILL_GRACE_MS` still ends the session: the thread reads stopped
  with the notice "Stopped · the provider didn't confirm it ended", and the old generation's late
  exit changes nothing.
- **Background command jobs** (`machines/command-process.ts`) stop their tree with SIGTERM, then
  SIGKILL after `TERMINATE_GRACE_MS`.
- **Clients** (`ui-core`). A task ace lost track of (`unknown`) no longer counts as running in
  the agent tree, the Summary or mobile rows; it reads "lost contact". A remote child's row says
  "lost contact · resumes if it reports" or "stopped · didn't confirm" (`remoteContactStep`).

### Protocol

Additive and optional, so older builds ignore it: `AgentMachine.contact`,
`WatchedThread.contact` (and so `MachineThreadView`, `wait` results) and `MonitoredChild.contact`,
each `"lost" | "unconfirmed"`; the core fact `queue.changed` gains `stopped`.

### Audit of live states

| Source                                           | Shows live                                       | Proof of life before                                          | How Stop reaches it                                                                | When it hangs, before → now                                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider turn / session                          | agent `working`/`blocked`, run active            | frames only; 60 s silence reads `unresponsive`, never settles | `thread.interrupt` → `session.interrupt`; close only if interrupt threw            | interrupt with no timeout held Stop and every later control → bounded interrupt, forced close, stopped even unconfirmed                           |
| Provider background shell / monitor              | task `running`                                   | provider frames                                               | `background_task.stop` → `session.stopTask`                                        | stays running until the provider reports → unchanged here (follow-up: bound `stopTask`, fall back to closing a session-bound task's session)      |
| Ace-owned holds (transfers, guests, remote jobs) | `owner:"ace"` task `running`                     | the owning service                                            | `bindExternalTaskStop`, acked before anything stopped                              | stays running if the owner stalls → unchanged except remote children (follow-up: leases for transfers and guests)                                 |
| Remote children (`ace-machine:`)                 | summary agent + `subagent` hold                  | the machine's last report, held in memory only                | fire-and-forget cancel                                                             | held for hours → bounded stop, lease, lost contact, restart-safe                                                                                  |
| Remote command jobs                              | `owner:"ace"` hold                               | polled; deadline per job                                      | stop sent to the machine                                                           | already bounded by its deadline (`remote-jobs.ts`)                                                                                                |
| Terminals                                        | not in thread status                             | process group                                                 | `close(graceMs)` then SIGKILL sweeps                                               | already bounded                                                                                                                                   |
| Background command jobs                          | job record                                       | child process                                                 | SIGTERM then SIGKILL                                                               | already bounded; now the shared grace                                                                                                             |
| MCP `wait` / `delegate` wait                     | `subagents.waiting` → agent `blocked{subagents}` | the tool item is live; daemon timer per wait                  | turn end cancels live tools; shutdown returns `interrupted`                        | bounded by `timeoutSeconds`; a remote child that loses contact now releases it (follow-up: a hung provider mid-wait suppresses silence detection) |
| Queued and steered intents                       | `waiting{queue}`, `needs_you` via held queue     | none: durable rows                                            | Stop keeps queued sends and pauses `stopped`                                       | a kept queue read waiting forever → at rest                                                                                                       |
| Held failed send ("Not sent")                    | `failed`                                         | none                                                          | Stop overwrote it to `stopped`                                                     | read `needs_you` forever on a remote child → the parent's cancel retires it there                                                                 |
| Local delegated children                         | summary agent from the child's thread            | the child thread's status                                     | `cancelDescendants`: phase `cancelling`, cascaded interrupt, queued inputs retired | inherits the provider bound above (follow-up: a deadline on `cancelling`)                                                                         |
| Automation runs                                  | run record follows threads                       | reconcile timer                                               | `reconcileStop` with retries                                                       | non-stoppable work left to end (follow-up: run deadline)                                                                                          |
| Browser / computer use                           | live MCP tool items                              | the tool item                                                 | the turn's interrupt cancels the tool                                              | as provider sessions                                                                                                                              |

Tests: `liveness/liveness.test.ts` (plans, bounds, restart, clock), `machines/remote-child-stop`
(the live case end to end with a real parent engine: unconfirmed stop, confirmed stop, lost and
resumed, late report, restart, a live sibling keeps the parent open, a wait released, a lost child
stopped), `machines/machine-stop` (two real daemons: a held child cancelled from its parent
settles on both), `engine/stop-escalation` (a hung interrupt; a hung interrupt and close),
`machines/command-stop` (a shell ignoring SIGTERM is killed), core `adapter-contracts`.

## Amendment 2026-11-01: the person's Stop is done, and already read

After a Stop the thread read done in core, but every other surface still treated the Stop as
something to act on: an "Agent stopped · Continue" pill over the composer (and the same strip on
iOS), `needs_you` in the phone's Inbox, a held queue that kept the thread out of auto-settle, an
unread Done mark for a turn the person had just ended themselves, and `needs-human` from
`thread wait --tree`. The owner: "if user interrupts, we must not auto continue when restarting, or
even show 'agent paused' / a Continue pill. Interrupted is marked as done, which is already read
by the user."

### Rule

- **Only the person's own Stop is final.** It is the queue hold with reason `stopped` (a Stop of
  the whole thread, `agent_cancel`, kill-all). A restart, a crash or a provider that died hold with
  reason `restart` and keep ADR 0098's recovery: continue by itself when safe, else a Continue pill.
- **Done.** Core already reads a Stop's thread at rest (`status.ts`), with or without messages it
  kept. Unchanged.
- **Asks nothing.** `threadAttention` (projection) no longer returns `stopped`. So the thread is no
  attention anywhere: not `needs_you` in the phone's Inbox, not held out of auto-settle or the
  Settled list, not `needs-human` in a CLI tree or a delegation's work outcome, and a parent's
  `wait` sees a stopped child as done. Automation runs keep their own reading of a Stop (needs the
  person, or failed when their own cancellation made it): `automation-run-rules.ts` reads the
  queue's reason directly.
- **Already read.** `isUnread` (ui-core) answers false while a Stop's hold stands
  (`stoppedByPerson`), on every device's cursor; the person's own Mark unread still wins.
- **No Done alert.** The notifier (`notify/model.ts`) keeps each thread's queue hold and asks the
  same `stoppedByPerson`: a Stop's Done alerts no device (desktop, web or phone push). Failures
  and requests still alert, and the next turn's finish alerts as usual once a message lifts the hold.
- **No Continue.** `stopTitle` names only a restart or a provider exit, so the pill never shows for
  a Stop; `queueNotice` says nothing for a Stop, except, when the Stop kept queued messages, "Queued
  messages wait" with Send now (`queue.resume`) in the queue's strip. The transcript keeps its quiet
  "Interrupted by you" break, and the next message starts a new turn (the 2026-10-18 rule in ADR
  0053).
- **Across restarts.** Unchanged from ADR 0053 ("A Stop is final across restarts"): capture,
  provider-exit holds and startup skip a `stopped` hold, so nothing resumes or re-prompts the turn,
  and the hold, and with it every rule above, survives the restart.

Tests: `engine/restart-resume.process.test.ts` (a stopped turn stays done, asks nothing and sends
nothing after a crash and after a graceful restart; a crash's own interruption still continues),
`cli-attention.process.test.ts`, `engine/io-lifecycle.process.test.ts`, ui-core `thread-card`,
`mobile-inbox` and `queue` tests, web `interrupted-turn.test.tsx`, notify `status.test.ts`.
