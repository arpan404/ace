# 0158: Spade has no fixed step or time limit on a bot's work

Status: accepted. Date: 2026-11-15. Decided by: the owner (2026-11-15, after a bot's long
cleanup failed with "the turn reached its limit of 30 steps": "we must not have such weird and
unwanted guardrails that make no sense for a true agentic system. Nowadays many agents will do
millions of steps."). Amends [spade/docs/harness.md](../../spade/docs/harness.md) (limits, tool
and job timeouts), [ADR 0144](0144-spade-autonomous-bots.md) decision 6 (the task's step budget)
and [ADR 0152](0152-spade-helpers.md) decision 7 (a helper's steps and spend).

## Context

Spade ended a bot's work at fixed points that had nothing to do with the task: 30 model steps
or $2 per turn, 30 steps or $1 per helper, 25 continued steps per task, 110 s per shell command
under a 120 s limit on every tool call, and 30 minutes per background job. A long refactor, a
migration or a test-fix loop hits these as a matter of course, and the bot stops with the work
half done. The person already has the controls that matter: Stop, and the daily and monthly
spending caps they set (ADR 0135).

## Decision

1. **No step count, turn cost or duration ends a bot's work.** A turn, a helper and a task that
   carries itself on take as many steps and as long as the work needs. The person's controls are
   Stop (everything ends at once) and their own spending caps: at a cap no model call starts and
   the bot says so once. Approvals, access levels, auto-review and the untrusted-content rules are
   unchanged.
2. **A call holds the turn for a foreground window (30 s), then moves to the background.** No tool
   call is timed out by the engine. One still running after the window carries on as a background
   job with the same run (nothing is restarted): the call answers with its job id, the turn goes
   on, and the result arrives once as a `<job_result>`. Jobs have no time limit; Stop ends them,
   and a restart reports them as "unknown outcome" as before.
3. **The shell keeps a default deadline (60 s) the model can raise without limit** with
   `timeout_s`. The deadline still kills the whole process group when it passes.
4. **A task pauses only when it stops making progress**: three continued steps in a row with no
   effect (`no_progress`). There is no step budget; `task_paused {reason: budget}` stored by
   earlier versions still reads and still holds until the person writes.
5. **A turn of any length stays bounded.** Compaction may cut inside a turn that is too long to
   keep whole, at a step that began once every earlier call had its result and whose prompt had
   seen everything stored before it. While a turn runs its events are kept in memory and each
   read takes only what was stored since, so a step costs what it adds and what its prompt holds,
   not the whole history.

Kept, because they bound one call or one exchange rather than the bot's work: single tool results
cut to 20,000 characters, the model-step retry policy, the 60 s auto-review (it escalates to the
person), research depth budgets, transport timeouts (ace's tools, media endpoints), bot-to-bot
and group chain limits (a refused message, not a stopped bot), plugin `Stop` hooks extending a
reply at most three times, and at most four helpers running at once (a queue).

## Consequences

- A bot can work for hours; only Stop and the person's caps end it. The caps, not a turn limit,
  bound what a runaway bot spends.
- A long command no longer fails at 110 s; it shows up as a running job and the bot reads as
  working until its result is in.
- Tests: a turn past 100 steps finishes; a helper past 30 steps answers; a shell command that
  outlives the foreground window moves to the background and delivers its result once; a long
  turn paused for an update resumes from its events; the daily cap still stops new model calls;
  compaction keeps cutting further into one turn round after round.
