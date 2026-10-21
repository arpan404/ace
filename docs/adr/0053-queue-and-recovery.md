# 0053: Durable queues, continuation and usage-limit recovery

Date: 2026-10-02. Status: proposed, implemented for review.

The engine remains the single owner of provider delivery. Extend its SQLite
intents rather than introduce another queue or let adapters retain follow-ups.
The [Orchestrator V2 release notes](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610)
are a behaviour reference only. No competitor source was read.

## Queue ownership

A queued message is an unclaimed send intent with a stable command ID, input,
attachment/context references and a position. Each thread has a monotonically
increasing queue revision. Edit, remove, move and resume commands compare the
observed revision in the same transaction as their receipt and changes. A stale
device gets `queue_conflict` and rereads. Claimed sends are immutable. Reordering
names one message and its predecessor, avoiding full-list uploads. Queues cap at
256 messages and each message at 256 KiB; attachments remain references.

Follow-up behaviour defaults to queue and resolves before intent admission.
An explicit send delivery overrides the setting. Clients can implement the
opposite-default shortcut without duplicating the server queue. Steers bypass
settled-turn gating only when the adapter advertises steer, the session is live,
and no recovery/limit hold exists. Unsupported steering enters the ordered queue. A person's
steer during a foreground tool goes in now (see the 2026-10-18 amendment "Steer interrupts a
running command"); a delegated result still waits for that tool to finish. Background work
alone does not hold steering. Explicit queue mode still waits for the next turn.
A queued message is not in the transcript; the claim that delivers it creates its user item
and binds its run (ADR 0065, 2026-10-17 amendment).

The commit before provider I/O is the claim boundary. Exactly-once external
delivery cannot be promised across a crash. Unacknowledged claimed messages
become uncertain and stay visible; they are never replayed automatically.
Unclaimed messages keep their order and wait for explicit resume after restart. ace
never continues interrupted work by itself (the former `threads.continueAfterRestart`
setting is gone); the person's Resume, or their next message, carries on. A persisted continuation counts
as queued engine work even when no user messages remain; its thread waits on
queue until resumed. Paginated reads use revision-checked command-ID cursors.
New admissions are bounded; older stored input shapes remain readable.

## Continuation and limits

Capture interrupted foreground work and live background shells, monitors and
children before recording process exit. Persist a bounded recovery notice and
continuation intent. Native resume is capability-gated. The next resumed input
tells the agent which work died, with a `restart` run trigger. Recovery does not
pretend that dead background work completed successfully. Graceful shutdown
records this evidence before closing providers too, so updates and reboots use
the same path. Resume never replays uncertain user delivery.

`limited` is derived from rate-limit facts, with human interaction and live-tree
work retaining precedence under ADR 0004. It survives process exit independently
of retry timers. Usage limits hold sends without failing or removing them.
`thread.limit` offers resume now, resume at reset, snooze until reset and migrate
now. A persisted deadline uses the accounts quota windows' latest active reset;
resetless blockers refuse timed resume. One injected-clock scheduler seeks the
next indexed deadline and drains bounded batches. Snooze expires into a manual
hold rather than sending work. The default limit policy is configurable.

Migration first holds delivery and closes the source provider tree, then calls
the accounts service's existing migration API. Publish the destination instance
and native ID only on a migrated result, then resume. Unsupported or refused
migration leaves the queue held and reports a notice. ADR 0018's independent
writer lease remains mandatory; this feature never bypasses a refusal.

## Context meter and integration

Context occupancy is the latest provider context sample, never lifetime billing
totals. Add explicit context token, epoch and compaction facts. A session change
or compaction invalidates the old sample until a fresh one arrives. Prefer the
reported context window, then the exact account/model catalog entry; missing
data stays unknown. Persist one row per agent and expose bounded thread pages.
Provider stream deltas bypass recovery and context sampling work. Queue counts
use partial indexes over outstanding intents rather than completed history. Changed usage
updates only the affected agent, without reading transcript history.

See the [queue and recovery API](../queue-and-recovery.md). Codex occupancy uses
its [last token usage](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/v2/ThreadTokenUsageUpdatedNotification.json);
Claude occupancy includes the [cache read and cache creation buckets](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

Add schema-only queue/recovery definitions and exports, authenticated service
registry routes and client helpers. No edits to `server.ts`. Settings retain
their existing layered file owner. Behaviour tests use temporary SQLite and
scripted adapter boundaries, with injected clocks and explicit barriers.
Non-gating benchmark definitions report throughput and peak RSS. Under the
owner's current rule, tests, mutations and benchmarks are written but not run;
runtime evidence and numbers need run at merge.

Review refinements: generic retry/activity clearing is independent of quota recovery.
The `limit.cleared` adapter fact requires authoritative quota evidence; explicit
resume emits it through the same core boundary. Native run starts persist an
acknowledgement bit independently of the outstanding acknowledgement latch.
Transport rejection never makes consumed input runnable again. Unknown consumption
stays uncertain even during a usage limit; only a typed preconsumption deferral can
requeue a send. Scheduling reads indexed headers and decodes payloads at claim.
Cold held sends do not occupy active capacity; releases are fenced by live sessions,
native opening operations, running intents and runnable work.

Admission-based adapters may report `input.admitted` before any run. Correlated
admission sets the same durable consumption bit, and subsequent run starts cannot
acknowledge a different input. Send and native continuation pass the command ID
through account binding. A persisted continuation-intent reference retains the
restart/limit-resume trigger until the corresponding run begins, including when
admission and the RPC reply precede that run.

An admitted continuation remains provider-owned if its RPC reply fails. Receipt
failure cannot erase its durable acknowledgement or run trigger. Another resume
is refused, and both queued and steering follow-ups wait until that run starts.
Its eventual start clears the continuation, so completion leaves no phantom work.
Provider exit or daemon restart ends that ownership and captures a fresh restart
notice for native continuation; it never replays the old admitted input. A newer
pause or limit still wins through the existing hold-token fence.

Fork/switch integration retains queue ownership by thread ID. A fork starts with
an empty queue and no inherited quota facts; source messages and holds stay on the
source. An accepted but unclaimed fork waits after restart. Explicit resume may
release that hold without consuming provider input, while the native snapshot
guard remains until the fork executes. Accepted switches can apply at a quiescent
boundary even with held messages, which retain their IDs, content and order.
Cross-provider/account switches clear the old binding's quota facts while keeping
the queue held for explicit continuation. They cancel the old account's reset
deadline so its timer cannot spend quota on the destination. Portable handoff accompanies that
continuation exactly once, including admission followed by RPC rejection.
Cross-provider switches reset the old provider's admission policy; context samples
become unknown after any applied switch. Recovery account migration also updates
the execution selection used by fork provenance and subsequent switches.

The owner permits specific tests of conflicted code during merge resolution.
Those targeted integration runs are recorded in the PR; the full suite, mutation
runs and performance measurements remain deferred until merge.

## Amendment: only a definite limit holds the queue

Date: 2026-10-15. A Codex thread showed "Usage limit reached" with no reset and held its
queue while its account had room. Two guesses caused it: words that mention a limit (a
throttled request Codex retries, a 429 Claude or OpenCode retries, Cursor or OpenCode prose)
were read as a usage limit, and a limit with no reset had nothing that ever let it go.

`limited` now comes only from a definite provider signal: Codex `codexErrorInfo:
usageLimitExceeded` (never `rateLimitExceeded`, which Codex retries), Claude's rejected
`rate_limit_event` or a turn's `rate_limit`/`billing_error` code, Cursor's SDK `rate_limit` code,
or an account reading at 100%. Provider retries are waits (`upstream`/`network`). Prose keeps
an error code for wording (`usage_limit`, `model_quota`) and the turn simply fails.

A limit lets go when the provider says so, and ace still never starts a turn by itself. Under
the default `manual` policy a known reset only clears the limit: the thread and account read
as available and held messages wait for the person's Resume or next message. Only
`resume_at_reset` sends at the reset, as before; snooze still expires into a manual hold. A
fresh account reading below the limit clears the limit the same way (a chosen resume-at-reset
or snooze deadline stays). A completed turn lifts the hold. With no reset, or once the limit
has cleared, the person's next message is the go-ahead: the hold and ace's "continue" are
dropped and the queue sends in order. If the provider refuses again, its signal holds the
thread again.

## Amendment 2026-10-17: the person can always talk to the agent

A thread whose agent had finished its turn but left work running (a subagent, a delegated
child, a child's open request) held every queued message until that work ended, which could be
never. The web composer also refused to steer a queued message unless a root turn was running,
so there was no way to send it. The person could not talk to their own agent.

What a person's message waits for is now one pure rule in core (`acceptsPersonInput`), scoped to
the agent the person talks to, the root:

- **A root turn is running.** A steer goes into that turn now. A queued message waits for the
  turn to end ("queued messages wait for the run to end").
- **The root is between turns.** Any message, queued or steered, starts the next turn now.
  Background commands, monitors, subagents and delegated children keep running, and the thread
  keeps reading working or waiting on them; it never reads done while they run.
- **The provider can't take input yet.** The root is retrying or limited, has lost its
  connection, has announced a turn of its own (a wake, bounded to seconds), waits on the
  person's answer, or still holds earlier input in its own queue. A queued message waits and
  Steer on its row sends it now. A steer never needs a running turn: with none,
  it starts the next turn.

Stop and the other holds (`paused`, `limited`, recovery) are unchanged: a held queue sends on
the person's Resume or next message. A queued message that changes the model or options still
waits for the whole tree, because the switch may reopen the session and end its background work
(a steer that changes them goes in at once; see the 2026-10-18 amendment).
Forks, switches and merges keep the stricter whole-tree readiness.

Each provider takes a new turn with its background work alive:

| Provider | A message between turns                                                                                                                         |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex    | `turn/start` on the thread; background terminals and child threads keep running. A steer with no turn starts one.                               |
| Claude   | The user message goes to the CLI's stdin (`priority: "now"` for a steer) and starts the next turn; backgrounded agents and shells keep running. |
| OpenCode | `session.prompt` with its delivery; the v2 inbox runs it now or as the next execution.                                                          |
| Cursor   | With no SDK operation active, a send starts a new operation.                                                                                    |
| Pi       | `prompt`; `streamingBehavior` only matters while a run streams, so an idle harness starts a run.                                                |
| ACP      | No steer; the queued message is delivered as the next prompt once the previous one has returned.                                                |

## Amendment 2026-10-18: a steer always steers

A steer that also named a model or effort was rewritten to a queued message, so it waited for the
whole tree and the composer greyed Steer out whenever a new selection was picked. A queued
message changed to steer from the tray waited the same way. The person asked to steer and the
agent never heard them until everything finished.

A person's steer now always steers, wherever it comes from (the composer, the queue tray's
Steer, an edit that changes a queued message to steer):

- **Its text goes in at once**, under the same rules as any steer: into the running root turn,
  or as the next turn when the root is between turns. A foreground tool no longer holds it (see
  the next amendment), and the holds above (`paused`, `limited`, recovery) still apply.
- **Its selection waits for the boundary a switch needs.** While the tree works, the model or
  options change is split off as the thread's pending `thread.switch` (ADR 0051), ordered right
  behind the steer: last selection wins, clients see it queued, and it applies at the next
  whole-tree quiescence before the next queued send. Messages queued after the steer wait behind
  it, as they waited behind the selecting message before. The change is never applied mid-run
  and never lost.
- **With nothing running**, the selection belongs to the turn the message starts, so the message
  keeps it and is delivered with it at once, as before.
- **A provider that can't steer** queues the message with its selection, which waits for the
  whole tree as before: that is the provider's limit, not a choice.

The split happens when the steer is admitted (`admitSteer` in the engine), and a pending switch
never blocks a steer into a working tree.

## Amendment 2026-10-18: Steer interrupts a running command

The morning's rule held a steer until a running foreground command finished, and the composer
showed Queue meanwhile. In a Codex thread tailing a log while `bun run check` ran, the person
pressed Steer and the message sat in the queue until the command ended. Steer exists to
interrupt the model, so it must not wait for a command.

A person's steer now reaches the model at once, however long the running command:

- **Providers differ in when a native steer lands.** The Cursor SDK cancels and restarts the
  operation, so its steer reaches the model at once. Codex `turn/steer` waits in the turn's
  pending input for the next model request, after the running command returns; Pi's `steer` and
  OpenCode's busy-session prompt also land at the next step. Claude's `priority: "now"` message
  waits too: Claude Code 2.1.304 holds it in its input queue until the running foreground tool
  returns (#1184; an earlier version of this amendment said it backgrounds the tool, which it
  does not). Adapters say which through the `steerTiming` capability (`after_tool`; omitted
  means immediate).
- **Immediate providers steer natively mid-tool.** The engine sends the steer as before.
- **Claude backgrounds the running tool.** Claude omits `steerTiming` and its session implements
  `backgroundTools`. The steering lane sends the person's steer natively, then asks the session
  to move the running foreground tools to the background (the `background_tasks` control, the
  terminal's Ctrl+B). Each blocking Bash or subagent call returns at once with a "running in the
  background" result, the turn takes the steer at that boundary, and the command keeps running
  as a background task that reports when it ends. Nothing is interrupted or killed. If the
  control fails (background tasks disabled with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`), the
  engine reports the error and never falls back to an interrupt: the steer lands when the tool
  returns. Only the person's own steer backgrounds tools; daemon input never does.
- **`after_tool` providers yield the turn.** The steering lane interrupts the root turn once
  (provider-native, no cascade: background commands and children keep running). The steer stays
  an unclaimed intent until that turn ends, then goes in as the next input. No other steer slips
  into the ending turn. The cut-short run ends `interrupted` with `endedBy: "steer"`, and clients
  show it as finished work, not as Stopped. The thread reads working while the turn winds down
  and waiting on the queue for the instant before delivery, never done.
- **Delegated results never interrupt.** A child's result (`subagent_result`) still waits for
  the running command, then steers natively. The engine keeps the two apart: `isPersonSteer`
  and the `yield` route only ever take the person's own steer.
- **Stop wins.** A Stop in the same stretch pauses the queue: the run reads stopped and the
  steer waits for the person.
- **Restarts.** The steer is never claimed before the turn ends, so a restart in between keeps
  it, once and not uncertain, in the held queue. It goes in when the person resumes, like any
  message after a restart. Nothing starts by itself.
- **If the interrupt fails**, the engine does not retry it; the provider's own steer delivers the
  message when the command returns.

## Amendment 2026-10-18: a Stop always settles

A Stop of a whole thread (a cascading interrupt with no agent or run target) must leave the tree
settled, never working or waiting on work nobody can reach.

- **The provider can't stop it.** When the provider rejects the interrupt (a lost location, work
  it won't interrupt), the engine closes the provider session as the person's Stop. The adapter
  cleans up what it owns, and every agent, tool and background task still marked running ends
  (`interrupted`, or `unknown` for tasks). The Stop is not reported as failed.
- **A Stop is final across restarts.** A stopped thread never captures a restart continuation:
  shutdown capture and a provider-exit hold both skip a queue held by `stopped`, so nothing waits
  for Resume after a Stop. Startup drops a restart continuation that earlier builds saved behind a
  Stop, so such threads (and the delegated children a parent cancelled) settle on the next start.
