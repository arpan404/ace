# Routines and the heartbeat

Date: 2026-11-12. Bots act on their own ([ADR 0129](../../docs/adr/0129-spade-routines.md)). A
routine is standing work one bot does in its own conversation: a name, an instruction and a
trigger. A heartbeat is a checklist a bot goes through every N minutes. Both are kept in Spade's
database (`routines`, `routine_runs`, schema 4) and deleted with their bot.

## How a firing works

- **The message.** A firing stores the instruction in the bot's conversation as a `user_message`
  with `from_routine: {id, name, run, label, heartbeat?, event?}`. It starts a turn, or steers the
  open one, like the person's message. The model reads it framed as
  `<routine name="…" id="…" fired="…">…</routine>` (`<heartbeat …>` for a heartbeat). `label` is
  fixed when it fires: `9:00`, `caught up from 9:00`, `Tue 9:00` (another day), `thread finished:
Fix login`, `webhook`, `run now`.
- **Once per slot.** A scheduled routine stores its next slot. The timer claims a due slot and
  records the run (`pending`) in one transaction, moving the next slot past now, then delivers the
  message and marks the run `delivered` with its seq. A run still `pending` after a restart is
  delivered on the next tick unless its message is already stored.
- **Caught up.** However many slots passed while Spade was down or the machine slept, one run
  goes, for the latest slot, with cause `caught_up`. A slot more than two minutes late counts as
  caught up too. The timer wakes for the earliest slot and at least once a minute, so a wake
  from sleep is noticed within a minute.
- **No overlap.** A run is open from its message until a reply ends after it (finished, stopped,
  failed or interrupted). A firing while the routine's last run is open is recorded as skipped
  (`The last run was still going.`). Over today's spending cap, it is skipped too.
- **Time zones.** A schedule is read in the routine's `time_zone` (IANA); the app sends the
  person's, and the machine's is the default. A time a spring-forward skips runs just after the
  gap; a time an autumn change repeats runs once, at its first instant. Intervals count real
  time from the Unix epoch, so `every 2 hours` runs at even UTC hours.
- **Paused** routines don't fire; resuming starts from the next slot after now (nothing catches
  up). Changing a schedule or zone does the same.

## Triggers

`trigger` in the API is one of:

| `kind`     | Fields                                                      | Fires                                         |
| ---------- | ----------------------------------------------------------- | --------------------------------------------- |
| `schedule` | `schedule`: a phrase or five-field cron                     | At each slot                                  |
| `event`    | `event`: `thread_done`, `thread_failed`, `thread_needs_you` | When an ace thread the person started changes |
| `webhook`  |                                                             | `POST /v1/routines/{id}/run` with its secret  |

Schedule phrases (any case): `daily at 9:00`, `every day at 9am`, `at 7:00 and 19:00`,
`weekdays at 9:00`, `weekends at 10:30`, `mondays and thursdays at 6:30pm`, `mon, wed, fri at
noon`, `every 30 minutes`, `every 2 hours`, `every hour`. Cron: five numeric fields with lists,
ranges and steps; Sunday is 0 or 7; when both day fields are restricted either may match. Several
times in one phrase must share their hour or their minute. `words` gives the trigger back in a
few words (`Weekdays at 9:00`, `Every 2 hours`, `When an agent thread finishes`, `Cron 0 */2 * *
*`).

**ace events** come from the daemon's WebSocket: Spade subscribes to its thread list (the 20 most
recently changed threads) with the local daemon token it holds for skills, and fires on a
thread's status changing into `done`, `failed` or `needs_you`. The first list after Spade starts
is the baseline; after a reconnect, a thread that changed meanwhile fires once. Threads an agent
delegated (`delegatedBy`, `delegatedFrom`) and daemon-held threads never fire. A routine fired by
an event carries the thread's title in `from_routine.event`; a turn it starts or steers counts as
untrusted, so every write in it asks.

**Webhooks**: a webhook routine has a `secret` (64 hex characters). `POST
/v1/routines/{id}/run` with `Authorization: Bearer <secret>` runs it (`202`); a wrong or missing
secret answers `401`, a paused routine `409`. The secret opens nothing else. Only the loopback
API listens; reaching it from another machine is not built.

## Heartbeat

One per bot, off by default. While on, every `every_minutes` (5 to 1,440; 30 by default) outside
quiet hours, it delivers the checklist with instructions to answer exactly `[quiet]` when nothing
needs the person. It is delivered only while the bot is idle (no open reply, no background job);
otherwise that beat is skipped. Beats in quiet hours pass without a run. A heartbeat message is
never shown, and neither is a reply that answered only heartbeats with `[quiet]` (case and a
trailing full stop ignored): no bubble, no roster preview. Anything else the bot says is an
ordinary reply.

## Bot tools

- `routines_list` (read): the calling bot's routines.
- `routine_save` (write): creates a routine (`name`, `instruction`, and exactly one of `schedule`,
  `event`, `webhook: true`; optional `time_zone`, `paused`) or changes one of the bot's own by
  `id`, including pausing it.
- `routine_delete` (write): deletes one of the bot's own by `id`.

Writes go through the approval gate: the person approves unless they allowed the tool always. A
bot can't see or change another bot's routines.

## API

Under `/v1` with Spade's token; JSON; problems are `{"error"}`. Times are milliseconds since the
epoch.

**Routine** = `{"id", "agent", "name", "instruction", "trigger", "words", "time_zone", "paused",
"next_run", "last_run", "webhook": {"path", "secret"} | null, "created_by": "person"|"agent",
"created_at", "updated_at"}`

**Run** (`last_run`) = `{"id", "at", "cause": "schedule"|"caught_up"|"event"|"webhook"|"manual",
"result": "running"|"answered"|"quiet"|"failed"|"stopped"|"interrupted"|"skipped", "detail"}`.
`detail` is the label, or why it failed or was skipped.

| Method and path              | Body                                                                 | Answer                                    |
| ---------------------------- | -------------------------------------------------------------------- | ----------------------------------------- |
| `GET /agents/{id}/routines`  |                                                                      | `{"routines":[Routine]}`, oldest first    |
| `POST /agents/{id}/routines` | `{name, instruction, trigger, time_zone?, paused?}`                  | `201 {"routine"}`                         |
| `GET /routines/{id}`         |                                                                      | `{"routine"}`                             |
| `PATCH /routines/{id}`       | any of the above                                                     | `200 {"routine"}`                         |
| `DELETE /routines/{id}`      |                                                                      | `204`                                     |
| `POST /routines/{id}/run`    | none; Spade's token, or the routine's webhook secret                 | `202 {"run"}`; `409` paused or no webhook |
| `GET /agents/{id}/heartbeat` |                                                                      | `{"heartbeat"}`                           |
| `PUT /agents/{id}/heartbeat` | any of `enabled`, `every_minutes`, `checklist`, `quiet`, `time_zone` | `200 {"heartbeat"}`                       |

**Heartbeat** = `{"enabled", "every_minutes", "checklist", "quiet": {"start": "22:00", "end":
"07:00"} | null, "time_zone", "next_run", "last_run"}`. Quiet hours run from `start` up to `end`,
past midnight when `start` is later. A heartbeat can't be turned on without a checklist.

Errors: `400` for a body that doesn't fit (an unreadable schedule says why, in words the person
can act on), `404` for an unknown agent or routine, at most 50 routines per bot.

## Events

| Type           | Fields                                                         | Meaning                      |
| -------------- | -------------------------------------------------------------- | ---------------------------- |
| `user_message` | `…, from_routine?: {id, name, run, label, heartbeat?, event?}` | A routine or heartbeat fired |
