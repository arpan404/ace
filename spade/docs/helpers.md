# Helpers

Date: 2026-11-14. As built for [ADR 0152](../../docs/adr/0152-spade-helpers.md). Extends
[harness.md](harness.md) (turns, background jobs), [autonomy.md](autonomy.md) (the gate),
[oversight.md](oversight.md) (caps). The pure rules are `spade_core::helper`; the engine side is
`engine/helpers.rs`, with hooks in `engine/turn.rs`, `engine/calls.rs`, `engine/jobs.rs` and
`engine/control.rs`; storage is `spade_store::helpers`.

## The tool

`helper {task, profile?}` is a background tool (harness.md), offered to every bot on an
endpoint model. Risk read: starting one asks nothing, and each call the helper makes goes
through the gate itself. Its output is not marked untrusted as a tool; each result says itself
whether it is (below).

- The call answers at once (`job_started`); the helper's final message arrives as the job's
  `<job_result>`, cut to 20,000 characters like any result.
- `task` is 1 to 20,000 characters. `profile` defaults to `general`; an unknown one is refused
  with the list of profiles.
- Bots on CLI brains (ADR 0133) are not offered `helper` (`brain_tools` leaves it out), and a
  call that reaches it anyway is refused: their CLI splits work its own way.

## A helper's conversation

Each helper is a hidden conversation of its own, stored with a `helpers` row: its bot's
conversation, the job (the `helper` call's id), the bot's reply that started it, the profile
as it was then (name, standing instructions, reads-only, tool list) and the model. Kept whole, so
its prompt rebuilds to the same bytes after a restart even if a plugin's profile changed.

- It starts with one `user_message`, the task, and nothing of the bot's conversation. Its system
  prompt is `helper::RULES` and the profile's instructions; no skill index, no notes index, no
  title, no cowork notes.
- It is driven by the same turn worker and `next_step` as any reply: it streams, retries a step
  that failed before anything streamed, compacts, pauses for updates and Stop
  (`turn_paused`), and resumes from its events when Spade starts. A helper cut off mid-step by a
  crash is not closed as `reply_interrupted`: its next step is asked for again, and a tool cut off
  mid-run gets "unknown outcome" as in any turn. Only a helper Stop was pressed on is closed (as
  stopped) at start.
- Anything that asks which bot a conversation belongs to (`agent_for_conversation`) gets the
  helper's bot: its workspace, terminal, connectors, settings and caps are the bot's.
- `GET /v1/conversations` leaves helpers out. Posting a message to one answers `409`. Its events
  and live stream are read like any conversation's.

## Slots

At most 4 helpers of a bot have a reply open at once (`helper::MOST_RUNNING`). A fifth is stored
queued (its task and no reply) and starts, oldest first, when a running one ends. Nothing starts
while Spade is closing for an update; when admission reopens, queued helpers start and running
ones without a worker carry on.

## The job

The `helper` job starts the helper (once: a second run of the same job finds it) and waits for
its conversation to end, then delivers the result as `job_finished`. The job has no 30-minute
limit; the helper's own limits bound it.

- **Exactly once.** A job's result is delivered only if none is stored for that job yet (checked
  under the delivery lock, for every job). After a restart each helper job still open is run
  again rather than reported lost; it finds its helper and waits for it, or delivers at once if
  the helper ended just before the restart.
- **Working.** While a helper job is open the bot's `jobs` count holds and its state is
  `working`, so the bot never reads as idle or done while a helper runs, also after the reply
  that started it has ended.
- **Stop.** Stop on the bot's conversation stops the helpers of the reply it names and of the
  jobs it names (every running job): a running helper is stopped like any reply
  (`stop_requested`, then `reply_stopped`), a queued one gets a `stop_requested` with no reply and
  never starts. The job ends "Stopped by the person…", which opens no reply. A helper is stored
  under the lock Stop stores its marker under, and not at all once a stored stop names its job
  or reply, so Stop either finds it or it is never made. After a restart, a helper job a stored
  stop names is not run again: its helper is closed as stopped and the job ends stopped.

What the result says, from `helper::ended`:

| The helper's reply         | `content`                                               | `is_error` |
| -------------------------- | ------------------------------------------------------- | ---------- |
| finished with text         | its final text                                          | false      |
| finished with none         | "The helper finished without an answer."                | true       |
| failed (a limit, an error) | "The helper stopped early: _reason_." and what it wrote | true       |
| stopped                    | "Stopped by the person before it finished…"             | true       |
| stopped before it began    | "Stopped before it began; nothing was done."            | true       |

## Profiles

| Profile   | Instructions                                                  | Tools                       |
| --------- | ------------------------------------------------------------- | --------------------------- |
| `explore` | find and read what the task needs; report it with its sources | risk `read` only            |
| `general` | do the task; report what it did and found                     | the bot's, less those below |

Every profile leaves out `helper`, `ask_user`, `memory_save`, `memory_update`, `memory_forget`
(and any tool of risk `memory`), `skill_propose`, `task_status`, `bot_message`, `group_ask`, and
every background tool (`research`, ace's `wait`): a helper's answer is its last message, and a
background result would arrive after it. Deferred tools (ace's, connectors') are narrowed the
same way, so `explore` keeps read-only ace and connector tools. A call to a tool the profile
leaves out is answered with a refusal and never run, checked before anything the turn loop
answers itself (a helper's `ask_user` would wait on a question nobody sees).

**Plugin agents' profiles.** `engine::ProfileSource` is the seam: `fn profiles(&self, agent:
&str) -> Vec<Profile>`, set once with `Engine::set_profile_source`. A `Profile` has a name, a
one-line `about`, its instructions, `reads_only`, an optional tool list (by name: it only
narrows) and an optional model (used when it names a model of the person's endpoints, else the
bot's model). A profile named like a built-in one never replaces it. The person's plugins fill
it (ADR 0151, `plugins/view.rs`): each agent of a plugin the bot may use now is a profile, its
text without frontmatter the instructions, its description the `about`, its frontmatter `tools`
(`a, b`, `[a, b]` or one `- a` a line) the tool list, and its `model` (not `inherit`) the model.
Turned off for the bot or in ace, the plugin's profiles go; a helper already made keeps the
profile it was made with.

## The gate

A helper's calls go through the same gate as its bot's, with the bot's settings:

- the bot's access level (ADR 0144), read for each call;
- "always" answers stored in the bot's conversation, and the helper's own;
- the model review, the auto-review and the credential rules, as for the bot.

A call the gate asks about is stored as `approval_requested` in the helper's conversation, where
its turn waits, and also in the bot's conversation, in the same write:

```json
{
  "type": "approval_requested",
  "reply": "<bot reply that started it>",
  "call_id": "<job>.<helper call id>",
  "name": "send_note",
  "arguments": {},
  "helper": { "job": "<job>", "conversation": "<helper conversation>", "call_id": "<id>" }
}
```

The person answers it in the bot's conversation with
`POST /v1/conversations/{bot}/approvals/{job}.{id}`; Spade stores `approval_answered` in both
conversations and wakes the helper. "Always" lands in the bot's conversation, so it holds for the
bot and its helpers. In the bot's transcript such an approval (`helper_awaiting`) outlives the
reply that started the helper: the bot reads as `waiting` until it is answered or the helper's
job ends. It never makes the bot's own reply wait.

## Trust

A helper's result carries `untrusted: true` on `job_finished` when anything untrusted was in the
helper's view: a web page, an app's output, or a task written while the bot had untrusted
content in view (such a task reaches the helper as the bot's message, `from_agent`, which taints
the helper's turn). The turn that reads that result is untrusted, so its writes ask, exactly as if
the bot had read the page itself.

## Limits and spend

- 30 steps and $1 per helper (`Limits.helper_steps`, `Limits.helper_cost_micros`); the helper
  ends failed with "the helper reached its limit of 30 steps" or "…its spending limit of $1.00".
  The bot's $2 turn limit does not count helpers.
- Every model call a helper makes is admitted and recorded under its bot's conversation, so it
  counts toward the bot's daily and monthly caps and the service's cap. A bot at its cap ends its
  helpers before their next step, saying which cap.
- `job_finished.cost_micros` is what the helper's steps cost; `reply_finished.cost_micros` of the
  turn that read a helper's result includes it.

## Events added

| Type                 | Fields added                            | Meaning                                                  |
| -------------------- | --------------------------------------- | -------------------------------------------------------- |
| `job_finished`       | `untrusted?`, `cost_micros?`            | The result carries untrusted content; what the job spent |
| `approval_requested` | `helper?: {job, conversation, call_id}` | A helper's call, asked in its bot's conversation         |

## API added

`GET /v1/conversations/{id}/helpers` → `{"helpers": [{"job", "conversation", "profile", "task",
"state", "cost_micros"}]}`, oldest first. `state` is `queued`, `working`, `waiting` (on the
person) or `ended`. `404` for an unknown conversation.

## What the person sees (web)

In the bot's conversation each helper is one quiet line where the bot started it, in Spade's
words: "Helper looking into: _task_", "Helper waiting for you: _task_", then "Helper found:
_first line of its answer_", "Helper stopped early" or "Helper stopped". The line opens to the
helper's own steps (its words, and a line per call in the words calls read in elsewhere), read
from its conversation when it opens. A helper's approval waits in the request strip like the
bot's own, as "A helper of _bot_ wants to …". No new panel and no new list.

## Not built yet

- The activity log reads the bot's conversation only: a helper's calls show there as the
  approvals they asked, not call by call.
- The iPhone app draws no helper lines yet, and has not been checked with helpers' approvals.
