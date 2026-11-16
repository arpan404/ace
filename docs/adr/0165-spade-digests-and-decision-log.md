# 0165: Spade sends digests, keeps a decision log and marks how loud each event is

Status: accepted. Date: 2026-11-15. Decided by: the owner (2026-11-15, Spade capability work
wave C: "async oversight for multi-day work"; the same day: no needs-you inbox, what waits on the
person keeps showing where it already does). Builds on [ADR 0154](0154-spade-questions-and-answering-later.md)
(questions that wait), [ADR 0158](0158-spade-no-fixed-step-or-time-limits.md) (caps park),
[ADR 0159](0159-spade-goals-plans-and-verification.md) (goals, plans, the check of done),
[ADR 0160](0160-spade-wake-and-owned-services.md) (wakes), [ADR 0161](0161-spade-orchestration-trees.md)
(worker trees), [ADR 0162](0162-spade-model-routing.md) (spend by role) and
[ADR 0163](0163-spade-auto-review-only.md) (the person is asked only on a retried refusal or a
review that can't decide).

## Context

A bot that works for days is mostly not watched. Published practice on overseeing long-running
agents points the same way: people move from approving each step to watching and stepping in
when needed. For that they need to see the work and steer it, they need a stop that reaches the
whole tree, and they need escalation instead of a bot that stalls or guesses. Spade has the
activity log, Stop on the tree (ADR 0161), questions that wait (ADR 0154) and a check of done
that doesn't take the bot's word (ADR 0159). Three things are missing:

- **A summary the person can read in a minute.** Seeing what a tree of workers did since
  yesterday means opening every conversation.
- **The choices a bot made for the person.** A bot picks between approaches on its own, which
  is what it should do instead of asking, but the choice and its reason end up only in the
  transcript. The person can't reverse it without reading back.
- **How loudly to tell the person.** Every event that reaches them reads the same, so a client
  or the phone can't tell "for your information" from "everything has stopped".

No source measured what makes a digest work; the format and cadence below are product choices.

## Decision

1. **Escalation levels.** Each event that reaches the person has one of four levels, from quiet
   to loud:

   | Level    | Meaning                                                                   |
   | -------- | ------------------------------------------------------------------------- |
   | `inform` | Nothing waits on the person; it goes in the digest.                       |
   | `ask`    | The bot wants the person's answer and keeps working meanwhile.            |
   | `block`  | One thing waits on the person (a call, a question); other work can go on. |
   | `stop`   | The bot's work has stopped until the person, a reset or a budget acts.    |

   The existing waits keep their behaviour. They are mapped to levels, and no new wait is added:

   | Event                                                                            | Level    |
   | -------------------------------------------------------------------------------- | -------- |
   | `decision_made` (3)                                                              | `inform` |
   | `goal_set` drafted by the bot (its criteria, for the person to edit)             | `inform` |
   | `task_verified` (done, not yet, or unchecked)                                    | `inform` |
   | `worker_reported` done or finished                                               | `inform` |
   | `question_asked` with `wait: false` (ADR 0154 decision 4)                        | `ask`    |
   | `question_asked` that waits                                                      | `block`  |
   | `approval_requested` (a retried refusal or a review that can't decide, ADR 0163) | `block`  |
   | `task_paused` (no progress)                                                      | `stop`   |
   | `cap_reached`                                                                    | `stop`   |
   | `wake_set` that parks on a cap, or waits for more budget (ADR 0158, 0161)        | `stop`   |
   | `reply_failed` (only permanent failures close a reply, ADR 0160)                 | `stop`   |

   Everything else has no level: the person's own actions, an outage the bot waits out, a check
   parked on its model's outage (transient, retried quietly). A worker's `needs_you`, `parked`
   and `failed` reports have no level either: the worker's own event carries it, so the person
   is told once. The level is derived from the event when it is served, never stored, so no
   stored event changes. `question_asked` stores `later: true` when asked with `wait: false`, so
   the event says on its own which level it has. A person's **Answer later** doesn't change the
   asked event's level; the question was already in front of them.

2. **Where levels show.** Every stored event served by `GET /v1/conversations/{id}/events` and
   `/live` carries `"level"` beside `seq`, `at` and `event` when it has one. Spade's notice
   stream (6) carries the same level. What waits on the person keeps showing where it already
   does: the cards in the conversation and the bot's row in the list. There is no separate
   inbox.

3. **The decision log.** `decision_log {choice, reason, options?, item?}` records a choice the
   bot made on the person's behalf: what it chose, why, the options it set aside (up to five)
   and the plan item it belongs to. Spade numbers decisions per conversation (`d1`, `d2`, …)
   and stores `decision_made {decision, call_id, choice, reason, options, item?}`. The call is
   answered with the decision's id and nothing waits. The tool description says when to use
   it: when the bot picks between real alternatives the person might have chosen differently,
   rather than stopping to ask. Decisions are `inform`. They show in the digest and in the
   activity log. A person who disagrees tells the bot; reversing a decision is ordinary work.
   Helpers can't record decisions (their bot does); workers record their own, and the tree's
   digest shows them under the worker.

4. **Digests, per task and per tree.** A digest is built from events with no model call. It is
   a pure fold in `spade_core::digest` over a window `[from, to)` (an event stored in the
   millisecond a digest is made falls in the next one), using the whole history for
   where things stand. It has:
   - **progress**: the goal's title and state, items total, closed by the bot (claimed) and
     verified (ADR 0159 decision 5), and how many closed and how many were verified in the
     window;
   - **changed**: plan items added, split, closed (with "verified" or "claimed") and blocked;
     goals set or ended; verdicts; workers started and reported; failed replies; pauses and
     caps. Up to 40 lines, then "and N more";
   - **decisions** made in the window (3);
   - **spend** in the window by role (ADR 0162), and its total;
   - **next**: the items being worked on, then the next open ones (up to five), and an open
     sleep or wait with its reason;
   - **waiting**: what stands open on the person now, each with its level and since when:
     approvals, waiting and deferred questions, a pause, a cap or budget park, a failed last
     reply. Blocked plan items are listed separately with the bot's reason.

   A **tree digest** is the bot's own digest with one digest per bot worker under it, nested
   (ADR 0161), and `subtree_spend` adds the workers'. Helpers' spend is already the bot's, and
   ace children are not priced.

   A digest is stored as JSON with a plain text rendering. Rendering is pure and has no
   Markdown, so it reads the same in a notification, the app and a message.

5. **When.** Digests are made on a schedule: every day by default (`every: "1d"`). The person
   sets `every` (a duration from `1h` to `30d`, or `off`) and `polish` globally
   (`PUT /v1/digests/settings`) and per bot (`PUT /v1/agents/{id}/digest`, `null` to inherit).
   A digest is due when `every` has passed since the end of the bot's last digest, or since the
   bot was made if it has none. A digest whose window holds nothing new (no event other than
   Spade's own bookkeeping) is not stored or sent; the next one covers the time since the last
   stored digest. A window is `[from, to)` with `to` the one clock reading the timer took, and a
   quiet window moves the schedule to exactly that `to`, never a later reading, so an event
   stored at or after the cutoff is always in the next window. Top-level bots get tree digests. A worker gets digests of its own only if the
   person set `every` on that worker itself; otherwise it appears in its root's. The timer is
   the same kind as the wakes' timer: it sleeps until the soonest due digest, at most a minute
   at a time, and runs again when a setting changes. A digest can also be made at any time with
   `POST /v1/agents/{id}/digests`. It covers the time since the last digest, is stored even
   when quiet, and does not move the schedule.

6. **Delivery.** Each stored digest is listed at `GET /v1/digests` and is sent on Spade's
   notice stream, `GET /v1/notices/live` (server-sent events). That stream is the hook ace's
   daemon subscribes to and pushes to the phone as end-to-end encrypted alerts (ADR 0106). Each notice is one of:
   - `{kind: "event", agent, name, conversation, seq, at, level, type, text}` for each stored
     event that has a level, where `text` is one plain sentence ("Builder asks: which database
     should I use?");
   - `{kind: "digest", agent, name, digest, level: "inform", text}` for each digest, with the
     text's first line.

   Notices are not stored: the stream sends what happens while it is open, and a client that
   reconnects reads digests from `GET /v1/digests?after=` and events from the conversations. The
   phone gets the level and a sentence, never tool arguments.

7. **Polish, optional.** With `polish: true`, the plain text is rewritten once into short
   sentences by the `title` role's model (ADR 0162). That is the cheapest writer the person
   already uses, and its spend counts as `title`. The model sees only the rendered digest,
   quoted as data, and is told to keep every fact and add none. A polish that fails, meets a
   cap or times out (30 s) leaves the plain text. The stored digest keeps both. Off by default.

## Options considered

- **A needs-you inbox across all bots.** Built into the first draft of this decision and
  dropped by the owner: what waits on the person already shows as cards in its conversation and
  in its row in the list, and a second place to answer the same thing is a second truth to keep
  in step.
- **A digest written by the bot's model.** Reads well, but it is the bot grading its own work
  again (ADR 0159), and it costs a call per bot per day. The fold reads only Spade's own events,
  which are trusted. Polish (7) rewrites the fold's words and adds no facts.
- **Storing the level on each event.** It would freeze today's mapping into every row. Derived
  when served, it can change with no migration.
- **A digest as a message in the bot's conversation.** The bot would read its own digest on its
  next turn, and the prompt would grow with every digest. It is stored beside the
  conversation, not in it.
- **Digests at a fixed time of day.** Wanted for "every morning", but it needs the person's
  zone and a calendar rule; a period from the last digest covers the need for now.

## Consequences

- The person can follow days of work in one short text per tree, and their phone can choose to
  buzz only for `block` and `stop`.
- A bot's choices on the person's behalf can be read and reversed without the transcript.
- One new table (`digests`), two settings keys, one event (`decision_made`), one optional field
  on `question_asked`, one tool and one notice stream. No existing wait changes.
- Not built here: the web and iOS views, ace's daemon pushing notices to the phone, digests at
  a time of day, and forecasting spend.

## Tests

`spade_core::escalation` and `spade_core::digest` are tested by tables: every mapped event's
level, and the unmapped ones; a window's changes, decisions and progress, claimed against
verified; what waits; quiet windows; tree rollup of spend and waiting; the due rule; rendering.
Engine tests through the API with scripted model fakes and a manual clock:

- a decision is recorded and shows in the digest;
- events served with their level;
- a digest made on demand;
- the schedule making one digest per period and none for a quiet one;
- a tree digest holding its worker's;
- a polish that is used, and one that fails and falls back;
- a notice for each levelled event and each digest.

## For the UI and the phone (a later wave)

- **Digest view:** the list from `GET /v1/digests` (per bot and all), each digest as its
  sections, with a tree's workers nested and collapsible. Progress reads "3 of 5 closed, 2
  verified". Each decision is a line that opens its call in the activity log.
- **Settings:** a digest row in Settings (every, polish) and in each bot's profile (inherit,
  every, off).
- **Levels:** quiet styling for `inform`; a normal notice for `ask`; a strong one for `block`;
  the strongest for `stop`. The phone pushes `block` and `stop` by default, `ask` as a quiet
  notification, `inform` never; digests as one notification each.
- **Decisions in the conversation:** a quiet line per `decision_made` ("Chose X: reason").
- **ace's daemon:** subscribe to `/v1/notices/live` through the Spade link and turn notices into
  pushes with their level: encrypted alerts (ADR 0106) carrying the sentence and the level, never tool arguments. Live Activities stay counts only (ADR 0145).
