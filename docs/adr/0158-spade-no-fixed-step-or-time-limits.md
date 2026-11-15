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
   not the whole history. What a turn keeps in memory is bounded too (64 MiB of stored events):
   a turn that outgrows it lets them go and reads them from the database for the rest of the
   turn, so its memory stays bounded at the price of a whole read per step.

Kept, because they bound one call or one exchange rather than the bot's work: single tool results
cut to 20,000 characters (head and tail since decision 7), the model-step retry policy (an outage
past it now waits, decision 9), the 60 s auto-review (it escalates to the person), research depth
budgets, and transport timeouts (ace's tools, media endpoints). The chain, `Stop` hook, helper
and parallel-call counts first kept here are relaxed by decision 11.

### Amended 2026-11-15: week-long and multi-agent work

Decided by the owner (2026-11-15: make Spade fully capable for multi-day, multi-agent work now;
the OS sandbox, egress proxy and grants come later, so no approval ask or taint gate changes
here). From the harness audit's wave 0.

6. **Compaction's "already carried out" list is bounded.** It lists the writes since the previous
   compaction and carries the previous summary's list forward (stored as `carried` on
   `context_compacted`), one line per write with long text cut to 80 characters plus its length,
   lists cut to 8 items and the line under 400 characters. Writes since the previous summary and
   jobs still running are always listed; past 16,000 characters the oldest carried lines fold
   into a count that points at `history_search`. The walk is one pass. Before, every compaction
   re-listed every write since the conversation began with full arguments, so over weeks the
   summary outgrew the context.
7. **A long result keeps its start and its end**, 10,000 characters each, with a note of what was
   left out between them; before, only the head was kept and the tail, where errors and summaries
   sit, was lost.
8. **The skill index and plugin rules follow the bot.** They are stored again after each
   compaction (the one point the prompt's top changes anyway), and the plugin rules also before
   the next model call after the person changes the bot's plugins, which is stored as
   `plugins_changed` so prompts rebuild from events. Before, both were frozen at the bot's first
   model call, and with one conversation per bot later skills and plugins never applied.
9. **Work waits instead of ending.** A working task stopped by a spending cap is parked
   (`task_parked {reason: cap, until_ms, why}`): the bot reads as waiting with the reason, and the
   task carries on at the cap's reset, when the person raises the cap, or when Spade reopens. A
   turn whose endpoint is down past the quick tries is parked (`turn_parked`) and sends its step
   again after 1 minute, doubling to an hour a round (or the endpoint's longer `retry-after`), as
   long as it takes; the reply stays open, Stop ends the wait and a restart resumes it. A refused
   key and a `429` that says the quota or credit is used up still fail at once: the person has to
   act. The service-wide daily cap (`SPADE_DAILY_CAP_USD`) is unset by default instead of $5 for
   every bot together; the person's caps per bot are the money boundary.
10. **A bot never reads idle while its ace children work** (AGENTS.md priority 1). A background
    `delegate` or `wait` calls ace's `wait` again each time ace's ten-minute wait runs out, until
    the children are done, need the person, or are held at a usage limit. After a restart such a
    job runs again once ace's tools are back and reattaches to the same children (`delegate`'s
    request ids come from the call key).
11. **Leftover counts are relaxed.** A group run takes any number of asks (it was 8); a group
    ask back to a bot already waiting up the asker's chain is refused as a cycle, and chains past
    16 deep (it was 3) are refused as a runaway guard. Bot-to-bot messages may go 16 hops (it was
    3). A plugin's `Stop` hook extends a reply as long as it asks, until it gives the same reason
    three times in a row with nothing changed in between (it was at most three times). 16 helpers
    and 16 tool calls of one step run at once by default (both were 4; `SPADE_HELPERS_AT_ONCE`,
    `SPADE_PARALLEL_TOOLS`). Compaction's budget is the model's own window (200,000 tokens for a
    model that doesn't say), capped only by `SPADE_CONTEXT_TOKENS`; before, it was never above
    200,000. A bot's terminal runs commands in sessions, the bot's own and one per helper, each
    with its own folder and variables; different sessions run at once (it was one command at a
    time for the bot and all its helpers).

## Consequences

- A bot can work for hours; only Stop and the person's caps end it. The caps, not a turn limit,
  bound what a runaway bot spends.
- A long command no longer fails at 110 s; it shows up as a running job and the bot reads as
  working until its result is in.
- Tests: a turn past 100 steps finishes; a helper past 30 steps answers; a shell command that
  outlives the foreground window moves to the background and delivers its result once; a long
  turn paused for an update resumes from its events; the daily cap still stops new model calls;
  compaction keeps cutting further into one turn round after round.
- Amendment tests: 400 compactions of 50 KB writes keep the list under 18,000 characters with every
  recent write listed; a skill added and a plugin rule changed reach the instructions at the next
  compaction, a plugin turned on or off at the next model call; a capped task waits through a
  restart and carries on at the reset or when the cap is raised; an outage parks the turn, which
  survives a restart and answers once the endpoint is back, and Stop ends the wait; a delegate job
  stays open while ace's waits time out and reattaches after a restart; twelve reads of one step
  run at once; a group ask back up the chain is refused; a `Stop` hook whose reason moves on
  extends a reply five times; a helper's command runs while the bot's build does.
