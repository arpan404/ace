# 0098: Work a restart cut short continues by itself

Date: 2026-10-22. Status: accepted. Amends [0053](0053-queue-and-recovery.md), which said ace
never continues interrupted work by itself.

## Context

Restarting ace (an update, a crash, a reboot, quitting the app) killed every provider process.
Each thread that was mid-turn got an "Interrupted by a restart" notice and waited on its queue
for someone to press Continue or send a message. With many agents running, someone had to visit
every thread. Delegated children were worse off: a held child read as `waiting`, so its parent
showed it as running ("Last seen") and it kept one of the parent's concurrency slots, so children
queued behind it never started. The owner's report: "the agent died when I restarted".

The earlier rule (0053, 2026-10-13) came from a stuck OpenCode turn that looked like ace starting
work by itself. That bug is fixed separately; the rule went further than the bug needed.

## Decision

At startup, a thread whose provider work was live when ace stopped carries on by itself, once,
through the same resume path as the person's Continue. Everything that was not running, or that
needs a person, stays as it was. The rule is one pure function (`restartDecision` in
`apps/daemon/src/engine/restart-resume.ts`); startup recovery (`restart.ts`) gathers its facts.

**What counts as running.** The shutdown or startup pass captured a restart continuation for the
thread: it had a run and an active turn, a provider-side queue, a wake window, a running
background task or provider subagent, or an open request (`lostWorkLines`). Graceful shutdown
captures it before closing providers; a crash leaves the live state for startup to read. A thread
whose queue was already held before the restart (Stop, pause, usage limit, an earlier
provider-exit hold, uncertain input, a resume already in flight) is not running in this sense and
is left alone. Settled and archived threads are never resumed. Cursor SDK work keeps its own
checkpoint reconciliation and is not resumed by this rule.

**How it continues.** Startup records an engine `thread.resume` for the thread. The provider
reopens the same native session and receives one synthetic input with origin and run trigger
`restart`:

> ace restarted while you were working, so your turn was cut short. Background shell commands,
> monitors and subagents you started have stopped, and any request you were waiting on has
> expired. Check the state of your work (files, git status, delegated agents, anything you were
> waiting on), rerun what was cut short instead of assuming it finished, then continue the task.

followed by the list of background work that died (at most 64 lines). No provider ace supports
resumes an interrupted turn on its own when its session is reopened (Codex `thread/resume`,
Claude `--resume`, OpenCode, Pi and ACP `session/load` all restore history and wait for input), so
the continuation input is always needed. Messages queued behind the interrupted turn keep their
order and are delivered after the continuation. The transcript notice reads "Interrupted by a
restart. Continuing."

**What waits for the person instead**, held with reason `restart` and a notice that says why:

| Case                                            | Notice                                                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| The turn was waiting on the person's answer     | Interrupted by a restart while waiting for your answer to "…". Continue and the agent asks again.          |
| A message's delivery was uncertain              | Interrupted by a restart while a message was being sent. Review it, then continue.                         |
| No native session, or the provider can't resume | Interrupted by a restart. This agent can't pick its session back up by itself; send a message to carry on. |
| Interrupted by three restarts in a row          | Interrupted by a restart 3 times in a row, so ace stopped continuing it by itself. Continue when ready.    |

A request the agent was waiting on expires with its provider process; it cannot be answered
after a restart. Naming it in the notice re-presents it, and Continue lets the agent ask again.
The person's Continue or next message works exactly as before in every held case: one action.

**Loop guard.** A small table (`engine_restart_resumes`) counts automatic restart continuations
per thread. A completed root turn, any new input to the thread, or the person's own Resume clears
it. After three automatic continuations in a row the next restart holds instead. This stops a turn
that crashes ace from restarting it forever.

**Provider exits are unchanged.** A provider process that dies while ace keeps running still holds
its turn for the person with "The agent stopped unexpectedly". That is a provider failure, not a
restart, and repeating it automatically could loop without a restart in between.

## Delegation

- **No false settle.** A resuming child reads `waiting` on `queue` until its continuation starts a
  run, then `working`. A child's result goes to its parent only when the child thread is `done` or
  `failed`, so a parent never receives a completed or settled result for a child that was merely
  interrupted; `wait` and `agents_status` see interrupted-and-resuming as working.
- **Dead children free their slots.** A child held after a restart or a provider exit, with no
  live session and no resume in flight (`heldInterrupted`), runs nothing, so it no longer counts
  against its parent's concurrency. The next queued child starts. If the held child is resumed
  later it counts again, even past the limit, like any revived child. It never reads as done: its
  thread waits on the person and its parent keeps showing it unfinished.
- The parent's own interrupted turn resumes by the same rule, and its continuation tells it to
  check its delegated agents.

## Consequences

- A restart no longer needs a visit to every thread; nothing runs that was not running.
- Agents get an explicit message that background work died, instead of a bare "continue".
- Tests: `apps/daemon/src/engine/restart-resume.process.test.ts` (resume after crash and graceful
  restart, queued order, not-running, waiting-on-person, stopped, provider without resume, loop
  guard) and `apps/daemon/src/agent-control/recovery.process.test.ts` (child resumes without its
  parent seeing it settle, dead children free slots after a provider exit and after a restart).
