# Workers

Date: 2026-11-15. As built for [ADR 0161](../../docs/adr/0161-spade-orchestration-trees.md).
Extends [helpers.md](helpers.md), [agents.md](agents.md), [autonomy.md](autonomy.md),
[oversight.md](oversight.md) and [harness.md](harness.md) (wakes). The pure rules are
`spade_core::tree`; the engine side is `engine/workers/` (`create`, `report`, `spend`,
`coordinate`, `lifecycle`, `view`), with hooks in `engine/mod.rs` (storing events, the roster's
activity, deliveries), `engine/ledger.rs` (what each call cost), `engine/park.rs`,
`engine/control.rs` (Stop), `engine/helpers.rs` (tools), `engine/autonomy.rs` (access),
`engine/agents.rs` (delete, roster fields) and `tools/ace.rs` (delegate). Storage is the event log;
`spade_store::workers` reads the links once at start and sums a subtree's spend.

## A tree

A bot's workers are:

- **bots it made** with `bot_create`. Each is a bot of the person's, with its own conversation,
  workspace, goal and plan, named by its maker (so no title call), listed in `GET /v1/agents`
  with `parent`;
- **ace children** of its `delegate` calls, noted from ace's first answer;
- **its helpers** ([helpers.md](helpers.md)), unchanged.
- **its task lanes** (below): the bot's own conversations for the person's tasks.

Each worker bot's conversation starts with `worker_of`, which names its parent: the tree is that
link per conversation. It is folded once when Spade starts (`Store::worker_links`, one pass over
the events of those types) and kept in memory as events are stored. Every store of an event
goes through `append_as`, which updates the link and marks the worker to be checked.

## The tools

All offered deferred (found with `tool_search`), so a bot that never orchestrates is sent
nothing more.

| Tool             | Risk  | Arguments                                                               |
| ---------------- | ----- | ----------------------------------------------------------------------- |
| `bot_create`     | write | `name`, `task`, `brief?`, `model?`, `tools?`, `connectors?`, `plugins?` |
| `worker_message` | write | `worker`, `text`                                                        |
| `worker_status`  | read  | `worker?`                                                               |
| `worker_result`  | read  | `worker` (untrusted output)                                             |
| `worker_stop`    | read  | `worker`                                                                |

`worker` is an id or a name: a worker bot anywhere under the caller, one of its ace children (by
thread id or role), or one of its helpers (by job). `wait_for` takes
`{condition: {kind: "worker", worker?}}`.

- **`bot_create`** answers at once: `{"worker", "name", "state": "working" | "queued",
"next"}`. A run of the same call (after a restart) finds the bot it made by the
  call's key (`worker_of.call`). A helper can't make bots. Refused with the reason:
  - a name or task that doesn't fit an agent's rules;
  - an unknown model;
  - a tree 16 deep;
  - tools, connectors or plugins the maker lacks.
- **Grants.**
  - There is one access level, the auto-review, so nothing narrows and `bot_create` takes no
    `access`.
  - Tools are the grant (`tools`, all of the maker's when unset) intersected with what the maker
    may use now. `tool_search` and `call_tool` are always kept.
  - Connectors and plugins named are copied from the maker's at creation; a new bot has none of
    either otherwise.
  - The tool list offered to the model is the same for every bot. A tool outside the grant
    answers "There is no tool named …", as for helpers.
- **The brief** (else the task) is the worker's first message. It carries Spade's context line
  naming its maker, and is marked another bot's message (`from_agent`, untrusted) when the maker
  had untrusted content in view as it wrote it (`worker_of.untrusted`, fixed then). `worker_message` follows the same rule. A queued worker can't be
  messaged until it starts.
- **`worker_result`** answers a worker bot's outcome from its events: `verified`, `progress`,
  the goal and criteria, each item with its status, verified mark and evidence (an `output`
  evidence with the call's stored result, cut to 2,000 characters), and the verdict. A worker
  without a goal answers `verified: false` and quotes its last words.
- **`worker_stop`** stops a worker bot and its subtree. For an ace child it asks ace's
  `agent_cancel`; for a helper it is Stop on its job.

## State and reports

- **Roll-up.** `activity()` is the agent's own activity with its workers rolled in: waiting beats
  working beats sleeping beats idle.
  - A worker reads working while its task will take another step by itself.
  - An ace child that ace reports as needing the person or held at a limit reads waiting, until
    a later `delegate` or `wait` names it.
  - A rolled-up `waiting` sets `waiting_for: "worker"` and the status "A worker is waiting for
    you". A bot whose own work is done reads "N workers working".
  - `task_progress.state` never reads `done` while anything under the bot runs.
- **Reports.** The engine checks each changed worker in one background loop.
  - A worker has settled when no reply or job is open, nothing under it works, its task won't
    carry on by itself, no claim of done waits for its check, and no wake of its own is open.
    One `worker_reported` is then delivered to its parent: `{worker, kind, name, state, epoch,
summary, words?}`.
  - The delivery stores a worker's report of a state in an epoch once, checked under the record
    lock. Every worker is checked again when Spade opens, so a report owed from before a restart
    arrives once.
  - A `stopped` report is stored and opens no reply, unless the maker waits on that worker
    (`wait_for` worker), which wakes it. Deleting a worker stores a `stopped` report with epoch
    `deleted`.

  | `state`     | When                                                      | `epoch`          |
  | ----------- | --------------------------------------------------------- | ---------------- |
  | `done`      | its reply finished and its goal's check passed (ADR 0159) | the reply        |
  | `finished`  | its reply finished, goal not checked done                 | the reply        |
  | `needs_you` | an approval or question waits (its own, or under it)      | `<reply>#ask<n>` |
  | `failed`    | its reply failed or a restart cut it off                  | the reply        |
  | `stopped`   | it was stopped                                            | the reply        |

  The model reads `<worker_report worker kind state from="spade">`: Spade's words and what to do
  next, then `<worker_words untrusted="true">` with its last reply (2,000 characters) as JSON.

## Spend

A tree has no budgets ([ADR 0166](../../docs/adr/0166-spade-has-no-spending-limits.md)): each node shows what it spent (`cost_micros`) and what its
whole subtree spent (`subtree_cost_micros`), and nothing stops on either. Builds before it stored
`worker_budget` events and `budget_micros` on `worker_of` and `worker_started`; they are read and
ignored. A worker such a build parked for budget is cancelled out of its wait when Spade opens
and carries on ([autonomy.md](autonomy.md)). A stored report of state `parked` reads as `other`.

## Concurrency

At most `SPADE_WORKERS_AT_ONCE` (default 32) of one maker's worker bots work at once. One made
past that is stored with its brief held (`worker_of.brief`, no message yet) and starts, oldest
first, as others settle. Stopping a queued worker stores a stop, so it never starts.

## Lifecycle

- Stop on a bot first stops its workers and their subtrees. Queued ones get a stop marker, and
  ace children still running get `agent_cancel` and a quiet `stopped` report.
- `DELETE /v1/agents/{id}` answers `409 {"error", "workers": n}` while the bot has workers.
  `?workers=stop` stops them first; `?workers=keep` leaves them working. Either way each stores
  `worker_detached {by: "person"}` and becomes a top-level bot: no parent, grants no longer
  narrowed.

## API added

- `GET /v1/agents/{id}/tree` → `{"tree": Node}`.
  - A bot node is `{kind: "bot", id, name, conversation, state, own_state, status, needs_you,
waiting_for, progress, cost_micros, subtree_cost_micros, queued, children}`.
  - A helper node is `{kind: "helper", id (its job), name (its profile), conversation, task,
state, needs_you, cost_micros, children: []}`.
  - An ace node is `{kind: "ace", id (thread), name (role), state, needs_you, job,
cost_micros: null, children: []}`. Its `state` is one of `working`, `done`, `failed`,
    `needs_you`, `limited`, `stopped` or `ended`.
- `PUT /v1/agents/{id}/budget` is gone ([ADR 0166](../../docs/adr/0166-spade-has-no-spending-limits.md)): it answers `404`.
- Every agent in `GET /v1/agents` adds `parent` (`{id, name}` or `null`) and `workers` (its
  worker bots that have not settled).

## Lanes

As built for [ADR 0217](../../docs/adr/0217-spade-runs-each-task-in-its-own-lane.md). The pure
rules are `spade_core::lane`; the engine side is `engine/lanes/` (`start`, `talk`, `view`), with
hooks in `engine/turn.rs` (the move, a lane's end), `engine/workers/` (roll-up, reports),
`engine/calls.rs` and `engine/helpers.rs` (requests asked in main), `engine/control.rs` (Stop),
`engine/media.rs` (routing a reply) and `engine/routing.rs` (the `task` role).

A lane is one task the person asked for, run by the bot in a hidden conversation of its own. It is
stored as a helper is (a `helpers` row with profile `lane`, so it shares the bot's workspace,
notes, settings and spend, is hidden from `GET /v1/conversations`, and is carried and deleted with
the bot), and it starts with `lane_of`. Unlike a helper it has its own goal, plan, `task_status`,
check of done and asks, takes the person's messages, and reports back to main.

- **Tools** (main's, core, not deferred; a lane's or a helper's call to one is refused):

  | Tool           | Arguments                  | Answers                                     |
  | -------------- | -------------------------- | ------------------------------------------- |
  | `task_start`   | `title`, `brief?`, `asks?` | `{task, title, state}`                      |
  | `task_message` | `task`, `text`, `asks?`    | `{task, state}`                             |
  | `task_stop`    | `task`, `because`          | `{task, state: stopped}`                    |
  | `tasks`        | `task?`                    | each lane's row, its goal, plan, last words |

  `task` is a lane's id or its title. `asks` names main's asks (`m12`) the lane takes; with none,
  `task_start` takes the newest open one. `task_stop` is refused unless `because` names a message
  the person wrote in main since the task last started, reported or was sent a message. A
  `task_start` run again finds its lane by the call's key. `task_message` stores main's words as
  `lane_message {text, untrusted}` (the bot's, never the person's, tainting when main wrote them
  with untrusted content in view); the person's own words for the asks it names go verbatim as
  theirs. It and a routed reply store both sides in one write.

- **First events.** `lane_of {parent_conversation, call, title, asks, untrusted, moved_from?}`,
  then one message from the person quoting their asks verbatim, with Spade's note on the task and
  the brief (`<task_brief from="bot">`) in its context. A brief written with untrusted content in
  view goes as a second message, the bot's (`from_agent`), which taints the lane's turn. Main
  stores `lane_started` in the same write.
- **Prompt.** A lane's system prompt and offered tools are main's byte for byte, so the provider's
  cache serves both; what it is told about its task sits in its first message.
- **Asks.** Asks a lane takes leave main's ledger (`lane_started.asks`, `reply_moved.asks`, an
  `ask_routed` message), so main's stop check skips them; the lane's own messages open its own.
- **Routing a reply.** A person's message to main whose `reply_to` names a lane's line, its report,
  the bot's words in the reply its report opened, or a message already routed there goes to that
  lane with no model call: main stores the person's message and `ask_routed {lane, title,
message}` together and opens no reply; the lane gets the person's words (trusted). Main's prompt
  reads a `<routed>` note there. A message written in a lane's own conversation (`POST
/v1/conversations/{lane}/messages`, `202`) steers it, or opens its next reply once it ended.
- **Main's long work** moves to a lane by itself ([harness.md](harness.md), "Task lanes"); main
  stores `reply_moved {reply, lane, title, asks, jobs, kept_jobs, wakes}` and the app writes
  Spade's plain line for it. The reply's background jobs (a helper's row with them) and its
  wakes move to the lane; ace's `delegate`/`wait` and contract calls stay with main, which reads
  a `<moved>` note asking it to pass their results on. A moved lane is named by the `title` role
  in the background (`lane_titled {lane, title}`), keeping the person's first line on failure.
- **Slots.** At most `SPADE_TASKS_AT_ONCE` (16) lanes of a bot have a reply open. One more is
  stored queued (`lane_started.queued`) and starts, oldest first, when one ends.
- **Requests.** A lane's approval is stored in the lane and in main in the same write
  (`approval_requested.lane {task, conversation, call_id, title}`, call id `<lane>.<call>`) and
  answered in main; the answer reaches the lane, and "always" lands in main. Main reads waiting
  until it is answered or the lane reports something other than `needs_you`. A lane's `ask_user`
  card is asked the same way (`question_asked.lane`, call id `<lane>.<call>`, answered at main's
  `/questions/{call}` and sent on to the lane); answered in the lane, main's copy closes. A
  helper that moved with main's work asks in main as the lane's.
- **Overlaps.** At each step boundary a lane's written files (`workspace_write`,
  `workspace_edit`, a job's kept files) are checked against its bot's other working lanes'. A
  shared path is stored once as `lanes_overlapped {lane, title, path, other, other_title}` in the
  writing lane (read as an `<overlap>` warning) and in main. No lock.
- **State.** `lane::state`: `queued`, `working`, `needs_you`, `done` (its check passed),
  `finished`, `failed`, `stopped`. One fold decides a lane's state, its slot and its report: a
  lane whose reply closed reads working while its own job, a wait, its task's next step or check,
  or a worker under it runs, and needs you while anything under it waits on the person. The bot rolls its lanes up like workers: working while one
  works or is queued, waiting (`waiting_for: "task"`, "A task is waiting for you") while one waits
  on the person, never idle or done meanwhile. The roster adds `tasks` (lanes not ended).
- **Reports.** A lane that settles stores one `worker_reported {kind: lane, worker: <lane>, …}`
  in main per state per epoch, read by main as `<task_report>`; a `stopped` one opens no reply.
  Every lane is checked when Spade opens, so a report owed from before a restart arrives once.
- **Stop.** Stop on a lane (`POST /v1/conversations/{lane}/stop`) stops it alone; a queued one is
  marked and never starts. Stop on the bot stops every lane first, also when main itself runs
  nothing: queued ones are marked in one write, so none takes a slot a stopping lane frees.
- **Restarts.** A lane cut off mid-step carries on from its events, as a helper does. When Spade
  opens, each lane that started and hasn't ended is resumed like any conversation, so a task left
  working after its reply closed takes its next step or its check of done; its lost jobs are
  reported.
- **Trust.** `lane_of.untrusted` is read by the trust fold: a lane started or moved while main had
  untrusted content in view asks where main would.
- **Writes in pairs.** A lane's request and its copy in main, an answer and every copy it closes
  (with its audit entry), a routed reply on both sides: each is one write (`Store::append_across`).
- **What is read.** `lanes_live` lists the lanes that haven't ended (a lane leaves it with its last
  report and comes back when it opens a reply). Slots, roll-up, Stop, the tasks block, the tree,
  resuming and startup read only those, never every lane a bot ran (ADR 0170).
- **Spend.** Each lane's steps are recorded under its bot as the `task` role; a row's
  `cost_micros` is what its steps cost. Nothing stops on it (ADR 0166).

### API added

- `GET /v1/conversations/{id}/tasks` → `{"tasks": [{task, conversation, title, state, needs_you,
progress: {done, total, verified} | null, plan_step, started_ms, ended_ms, cost_micros, asks,
moved, model, report}]}`, ordered needs you, running, ended, queued (oldest first in each).
- A lane's conversation is read with `/events` and `/live`, written to with `/messages`, stopped
  with `/stop` and tried again with `/retry`, like any.
- `GET /v1/conversations/{lane}/task` → the lane's `{task}`, as `GET /v1/agents/{id}/task`
  answers a bot's; `404` for a conversation that is no lane.
- `GET /v1/agents/{id}/tree` lists lanes as nodes `{kind: "lane", id, name, conversation, state,
needs_you, progress, cost_micros, children: []}`.

## Not built yet

- Lanes: a shell command's writes are not part of the overlap note.
- A worker's questions routed to its maker; they go to the person.
- Workers on other machines.
- ace children's state between ace's waits; delegated threads are not in ace's event stream.
- The UI ([ADR 0161](../../docs/adr/0161-spade-orchestration-trees.md), UI).
