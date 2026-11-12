# 0129: Spade's bots act on their own: routines and a heartbeat

Status: accepted. Date: 2026-11-12. Decided by: the owner (2026-11-12: make Spade complete, with
bots that act on their own, not only when the person writes). Builds on
[ADR 0126](0126-spade-agents.md) and [ADR 0127](0127-spade-main-bot-and-chat.md); the service
it runs in is [ADR 0123](0123-spade-runs-as-its-own-service.md).

## Context

A Spade bot is one long conversation that wakes only when the person, another bot or a finished
background job writes to it. Work a person hands to an assistant is often standing work: a
briefing every weekday morning, a look at what changed when an agent thread finishes, a check
every half hour that something still holds. Today the person has to come back and ask each time.

ace has scheduled automations ([ADR 0015](0015-automations.md)), but they start provider threads
in a workspace; they don't wake a Spade bot inside its own conversation, where it keeps what it
knows. Spade runs as its own service and keeps working while the daemon is away, so the clock
that wakes its bots has to live in Spade.

## Options considered

- **Use ace's automations to message the bot.** Ties Spade's schedule to the daemon being up,
  and splits one bot's standing work across two products' settings.
- **A separate conversation per routine run.** Each run would start without what the bot knows
  and its results would be scattered; the messenger shows one conversation per bot.
- **Chosen:** routines owned by Spade: standing work a bot does in its own conversation, fired
  by Spade's own timer, by ace's thread events, or by a local webhook.

## Decision

1. **A routine is a name, an instruction and a trigger, owned by one bot.** The trigger is one
   of:
   - a **schedule**, written as a short phrase (`daily at 9:00`, `weekdays at 9:00`,
     `mondays and thursdays at 18:30`, `every 2 hours`, `every 30 minutes`) or a five-field cron
     expression, evaluated in the routine's IANA time zone (the person's, sent by the app when
     the routine is made; the machine's when absent). Calendar times follow the zone's rules: a
     time that doesn't exist on a spring-forward day runs at the first instant after the gap, so
     no day is lost; a time that repeats in the autumn runs once, at its first instant. "Every N
     minutes or hours" counts real time, so a clock change never stretches or shortens it;
   - an **ace event**: an agent thread finished, failed or needs the person;
   - a **webhook**: `POST /v1/routines/{id}/run` on Spade's loopback API with the routine's own
     secret as the bearer. Reaching it from outside the machine (through the relay) is not part
     of this decision.

   The person can also run any routine now.

2. **A firing is a message in the bot's conversation.** The instruction is delivered as a
   message marked `from_routine {id, name, run, label}`, which wakes the bot exactly as a message
   from the person does: it starts a turn, or steers the open one. Every run's outcome is
   therefore in the conversation: the routine's message, then the bot's reply. The app shows the
   routine's message as a small muted label (`Daily briefing · 9:00`), never as the person.

3. **Once per slot, across restarts.** Each scheduled routine stores its next slot. Firing
   claims the slot and records the run in one SQLite transaction before the message is
   delivered; a run claimed but not yet delivered when Spade stopped is delivered on start,
   unless its message is already in the conversation. A slot is never run twice.

4. **Missed slots catch up once.** When Spade was down or the machine slept through one or more
   slots, the routine runs once on start or wake, labelled as caught up, and its next slot is the
   first one after now. Never a burst.

5. **Never two runs of one routine at once.** A run is open from its message until the reply
   that answered it ends. A firing while the previous run is open is skipped and recorded as
   skipped, so the list shows it.

6. **Heartbeat.** Each bot may have one heartbeat: a checklist it checks every N minutes (default
   off; 30 minutes when turned on), outside optional quiet hours. A beat is delivered only while
   the bot is idle, and the bot answers `[quiet]` when nothing needs the person; that exchange is
   shown as nothing at all, no bubble and no roster preview. Anything else it says is an ordinary
   reply. A heartbeat is stored as a routine of its own kind, so it shares the timer, the
   once-per-slot rule and the catch-up rule.

7. **Bots manage their own routines.** Every bot has `routines_list`, `routine_save` (create or
   change one of its own routines, pause or resume it) and `routine_delete`. Saving and deleting
   are writes, so the person approves them unless they allowed that tool always. A bot never
   sees or changes another bot's routines. The person manages them in the app (bot menu →
   Routines), with the heartbeat setting on the same page.

8. **ace events come from the daemon's thread list.** ace offers MCP clients no event feed, but
   its WebSocket already serves the threads subscription the app uses, whose entries carry the
   whole-tree status (`done`, `failed`, `needs_you`) the daemon computes. Spade subscribes to it
   with the local daemon token it already holds for skills, keeps the last status it saw per
   thread, and fires on a change into one of those states. The first list after connecting is
   the baseline, so a reconnect never replays history. Threads an agent delegated (with
   `delegatedBy`) are left out: a bot's own delegations finishing would otherwise wake it in a
   loop, and the person cares about the threads they started. No daemon change is needed. Pull
   request and automation events have no such feed yet; they need a daemon addition and are
   left for later.

9. **Spending and admission still apply.** A firing over today's spending cap is skipped and
   recorded. While admission is closed for an update, a routine's message is stored and answered
   once Spade opens again, like any message.

## Consequences

- Bots do standing work without the person returning; the person sees each run where the bot's
  work already is.
- A heartbeat costs one model call per beat even when it stays quiet; it is off by default, and
  its quiet hours and interval are the person's to set.
- Quiet heartbeat exchanges stay in the conversation's events and its model context until
  compaction folds them; leaving them out of later prompts is a follow-up.
- Event triggers depend on the daemon being reachable; while it is away they don't fire, and
  what happened meanwhile is not replayed.
- Spade's database gains `routines` and `routine_runs` (schema 3). Deleting a bot deletes its
  routines and their runs.

## Tests

- A schedule fires once per slot, also across a restart, with a fake clock and real SQLite.
- Missed slots catch up with exactly one run.
- A daily routine across a DST change runs at the same wall time on both sides.
- A firing while the previous run is open is skipped and recorded.
- A heartbeat with nothing to report leaves no visible message.
- An ace thread finishing wakes the bot (fake daemon WebSocket).
- The webhook refuses a wrong secret and runs with the right one.
- Routine messages carry `from_routine` and show in the app as a label, not as the person.
