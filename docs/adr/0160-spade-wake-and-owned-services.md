# 0160: Spade bots sleep, wait, own services and park retries

Status: accepted. Date: 2026-11-15. Decided by: the owner (Spade capability work, wave A, part
3). Builds on [ADR 0129](0129-spade-routines.md) (routines), [ADR 0144](0144-spade-autonomous-bots.md)
(tasks that carry themselves on) and [ADR 0158](0158-spade-no-fixed-step-or-time-limits.md) (no
fixed limits). Amends [spade/docs/harness.md](../../spade/docs/harness.md) and
[spade/docs/autonomy.md](../../spade/docs/autonomy.md).

## Context

A bot that works for days has to wait: for a build, a deploy, a reply, a date. Today it either
keeps taking steps (each a model call that changes nothing, counted toward `no_progress`) or saves
a routine, which asks the person under untrusted content and outlives the task. It cannot start a
dev server or a watcher: a shell command is killed when its run ends. A rate limit or an outage
after the 20 s retry window ends the reply with `reply_failed`, and the task stops until someone
writes. A background job with no time limit (ADR 0158) can run for hours without the bot ever
looking at it.

## Decision

1. **`sleep_until {at | after, reason}`** ends the bot's turn and wakes it at that time. `at` is
   an RFC 3339 time; `after` a duration (`90s`, `15m`, `2h`, `1d`, `1h30m`) or seconds. The call
   stores `wake_set {wake, purpose: sleep, due_ms, reason}`. When it is due Spade stores
   `wake_fired {wake, cause: time, note}`, which the model reads as a `<wake>` note from Spade
   and which opens a reply like a job's result. A sleep has no upper bound beyond a year.
2. **`wait_for {condition, timeout?, reason}`** wakes on an event, or at the timeout
   (`cause: timeout`). Conditions: `job` (a background job ends), `service_line` (an owned service
   prints a line matching a regex), `service_exit`, `file` (a path in the workspace changes),
   `url` (a loopback URL answers below 500; polled with backoff from 2 s to 60 s, the one
   condition that polls because nothing pushes), `thread` (a delegated ace thread is done, failed
   or needs the person, from ace's thread events), `bot_message` (another bot writes, optionally a
   named one) and `person` (the person writes). Events come from where they already happen: the
   job's end and messages as they are delivered, service output as it is read, ace's event
   stream, and the OS file watcher. A file wait stores the file's stamp (size, modified time)
   when set, so a change made while Spade was down still wakes it.
3. **Wakes are event-sourced and fire exactly once.** The open wakes are a fold of the
   conversation's events (`wake_set` without a later `wake_fired` or `wake_cancelled`). A firing
   is stored under the record lock only while its wake is still open, so a timer, an event and the
   person racing each other, or a restart between them, deliver it once. On start Spade re-arms
   every open wake from that fold; one that came due while it was down fires then, once. The note
   text is fixed when the firing is stored, so a rebuilt prompt is the same bytes. A wake fired
   by the event the model reads anyway (a job's result, a message) is stored with no note.
4. **A sleeping or waiting bot is never idle or done.** The roster state is `sleeping` (old
   clients read `working: true`), with words such as "Sleeping until 14:05: deploy settles" or
   "Waiting for the job to finish". A task with an open wake is not carried on by itself (ADR
   0144); the wake is its next step. The person can wake it early (`cause: person`) or cancel the
   wake (`wake_cancelled {by: person}`). Stop cancels every open wake (`by: stop`) and stops the
   bot's services. The bot can cancel its own with `wake_cancel`.
5. **Owned services.** `service_start {name, command, cwd?, keep?}` runs a long-lived process
   (a dev server, a watcher) through the workspace shell: same built environment carrying none of
   Spade's secrets, same system-only `PATH`, its own process group (a job object on Windows),
   killed with everything it started when it is stopped. It outlives the turn and the call.
   `service_status`, `service_logs {name, lines?, since?}` (the tail of an in-memory ring of its
   output, 256 KiB per service; untrusted output) and `service_stop` manage it. Starting one is
   gated exactly like `shell`: classed by its command, "always" covers that exact command. Events
   `service_started {service, name, command, cwd, keep}` and `service_ended {service, code,
   cause}` record it. After a restart a service marked `keep` is started again; any other is
   recorded `lost`. Services are listed at `GET /v1/agents/{id}/services` and stopped when the
   bot is stopped or deleted. A running service does not make the bot read as working: it is the
   bot's tool, not work in progress.
6. **Parked retries.** The error kind decides. A reply whose model call failed transiently
   (unreachable, `429`, `5xx`, a dropped stream) after the retry window is closed as failed, as
   today, and parked: `wake_set {purpose: retry, attempt}` with a backoff of 1, 2, 4 … minutes up
   to an hour, and no attempt limit (ADR 0158). Its firing opens a reply that carries on. A
   permanent failure (a refused key, a cap, a refused request) is reported and not parked. A
   background job whose tool reports a transient failure is parked the same way (`retry` with
   the job id): it stays running in the record, and the same call runs again when the wake fires.
   A message from the person settles a parked reply retry, since their message opens a reply.
7. **Check-ins on long jobs.** While a background job runs past 15 minutes, the bot gets a
   `<job_progress>` note with the job's latest output tail (from the bot's terminal for shell
   jobs), then at 30, 60, 120 minutes and every 2 hours after. Each is `job_progress {job, check,
   minutes, tail}`, stored once per check under the record lock, and opens a reply so the bot can
   keep waiting or act. The tail is untrusted data.
8. **The person sees and controls it through the API** (the web UI is a later wave):
   `GET /v1/agents/{id}/wakes`, `POST /v1/agents/{id}/wakes/{wake}/wake`,
   `DELETE /v1/agents/{id}/wakes/{wake}`, `GET /v1/agents/{id}/services`,
   `GET /v1/agents/{id}/services/{service}/logs`, `DELETE /v1/agents/{id}/services/{service}`,
   and the agent's `wake` field (the soonest open wake).

## Consequences

- A bot can run multi-day work on its own schedule without model calls while it waits, and a
  task survives an overnight rate limit without waking the person.
- Waits cost nothing while open: timers, the file watcher and event hooks; only the URL condition
  polls.
- What is not built here: restarting a crashed service by policy, per-resource tool parallelism,
  service logs on disk across restarts, and a UI. Waits on a thread that settled before the wait
  began do not fire; the bot checks the thread first.
- Tests: wakes fire once across a restart and against the person waking early; a sleeping bot
  reads `sleeping`; each condition fires from its event; a service outlives its call, matches a
  line, is stopped with its group and is restarted after a restart only with `keep`; a transient
  reply failure parks and retries while a permanent one does not; check-ins arrive once per slot.
