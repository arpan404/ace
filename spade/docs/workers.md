# Workers

Date: 2026-11-15. As built for [ADR 0161](../../docs/adr/0161-spade-orchestration-trees.md).
Extends [helpers.md](helpers.md), [agents.md](agents.md), [autonomy.md](autonomy.md),
[oversight.md](oversight.md) and [harness.md](harness.md) (wakes). The pure rules are
`spade_core::tree`; the engine side is `engine/workers/` (`create`, `report`, `budget`,
`coordinate`, `lifecycle`, `view`), with hooks in `engine/mod.rs` (storing events, the roster's
activity, deliveries), `engine/oversight.rs` and `engine/ledger.rs` (caps), `engine/park.rs`,
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

Each worker bot's conversation starts with `worker_of`, which names its parent: the tree is that
link per conversation. It is folded once when Spade starts (`Store::worker_links`, one pass over
the events of those types) and kept in memory as events are stored. Every store of an event
goes through `append_as`, which updates the link and marks the worker to be checked.

## The tools

All offered deferred (found with `tool_search`), so a bot that never orchestrates is sent
nothing more.

| Tool             | Risk  | Arguments                                                                                         |
| ---------------- | ----- | ------------------------------------------------------------------------------------------------- |
| `bot_create`     | write | `name`, `task`, `brief?`, `model?`, `access?`, `tools?`, `connectors?`, `plugins?`, `budget_usd?` |
| `worker_message` | write | `worker`, `text`                                                                                  |
| `worker_status`  | read  | `worker?`                                                                                         |
| `worker_result`  | read  | `worker` (untrusted output)                                                                       |
| `worker_stop`    | read  | `worker`                                                                                          |
| `worker_budget`  | write | `worker`, `budget_usd`                                                                            |

`worker` is an id or a name: a worker bot anywhere under the caller, one of its ace children (by
thread id or role), or one of its helpers (by job). `wait_for` takes
`{condition: {kind: "worker", worker?}}`.

- **`bot_create`** answers at once: `{"worker", "name", "state": "working" | "queued",
  "budget_usd", "next"}`. A run of the same call (after a restart) finds the bot it made by the
  call's key (`worker_of.call`). A helper can't make bots. Refused with the reason:
  - a name or task that doesn't fit an agent's rules;
  - an unknown model;
  - a tree 16 deep;
  - tools, connectors or plugins the maker lacks;
  - a budget that isn't a positive amount.
- **Grants.**
  - Access is the lower of `access` and the maker's level. It is read again for each call
    against the maker's level now, and the roster's `access` for a worker is that level.
  - Tools are the grant (`tools`, all of the maker's when unset) intersected with what the maker
    may use now. `tool_search` and `call_tool` are always kept.
  - Connectors and plugins named are copied from the maker's at creation; a new bot has none of
    either otherwise.
  - The tool list offered to the model is the same for every bot. A tool outside the grant
    answers "There is no tool named …", as for helpers.
- **The brief** (else the task) is the worker's first message. It carries Spade's context line
  naming its maker, and is marked another bot's message (`from_agent`, untrusted) when the maker
  had untrusted content in view. `worker_message` follows the same rule. A queued worker can't be
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
  - A `stopped` report is stored and opens no reply. Deleting a worker stores a quiet `stopped`
    report with epoch `deleted`.

  | `state`     | When                                                      | `epoch`          |
  | ----------- | --------------------------------------------------------- | ---------------- |
  | `done`      | its reply finished and its goal's check passed (ADR 0159) | the reply        |
  | `finished`  | its reply finished, goal not checked done                 | the reply        |
  | `needs_you` | an approval or question waits (its own, or under it)      | `<reply>#ask<n>` |
  | `parked`    | it waits for budget, or on a cap                          | the wake         |
  | `failed`    | its reply failed or a restart cut it off                  | the reply        |
  | `stopped`   | it was stopped                                            | the reply        |

  The model reads `<worker_report worker kind state from="spade">`: Spade's words and what to do
  next, then `<worker_words untrusted="true">` with its last reply (2,000 characters) as JSON.

## Budgets and caps

- Each model call is admitted against every budget and cap on its path to the top of its tree
  (`Engine::tree_cap`, hooked into `bot_cap` and the ledger's admission):
  - each worker's budget against its whole subtree's spend, all time;
  - each bot's daily and monthly caps against its whole subtree's spend in that period.
- A budget reached closes the open reply as at a cap (`cap_reached {scope: "budget"}`, said once
  per budget). The worker then waits on `wake_set {purpose: {kind: wait}, condition: {kind:
  budget}}` ("Waiting for more budget"), unless a task park (ADR 0158) holds it already.
- `worker_budget`, or the person's `PUT /v1/agents/{id}/budget`, stores `worker_budget` in the
  worker's conversation. Every waiting conversation of that subtree that may spend again then
  wakes. Raising a bot's caps does the same for its subtree.

## Concurrency

At most `SPADE_WORKERS_AT_ONCE` (default 32) of one maker's worker bots work at once. One made
past that is stored with its brief held (`worker_of.brief`, no message yet) and starts, oldest
first, as others settle. Stopping a queued worker stores a stop, so it never starts.

## Lifecycle

- Stop on a bot first stops its workers and their subtrees. Queued ones get a stop marker, and
  ace children still running get `agent_cancel` and a quiet `stopped` report.
- `DELETE /v1/agents/{id}` answers `409 {"error", "workers": n}` while the bot has workers.
  `?workers=stop` stops them first; `?workers=keep` leaves them working. Either way each stores
  `worker_detached {by: "person"}` and becomes a top-level bot: no parent, no budget, grants no
  longer capped.

## API added

- `GET /v1/agents/{id}/tree` → `{"tree": Node}`.
  - A bot node is `{kind: "bot", id, name, conversation, state, own_state, status, needs_you,
    waiting_for, progress, cost_micros, subtree_cost_micros, budget_micros, parked, queued,
    children}`.
  - A helper node is `{kind: "helper", id (its job), name (its profile), conversation, task,
    state, needs_you, cost_micros, children: []}`.
  - An ace node is `{kind: "ace", id (thread), name (role), state, needs_you, job,
    cost_micros: null, children: []}`. Its `state` is one of `working`, `done`, `failed`,
    `needs_you`, `limited`, `stopped` or `ended`.
- `PUT /v1/agents/{id}/budget` with `{"budget_usd": number | null}` answers the worker's tree.
  It answers `409` for a bot that is no worker and `400` for a budget that isn't positive.
- Every agent in `GET /v1/agents` adds `parent` (`{id, name}` or `null`) and `workers` (its
  worker bots that have not settled).

## Not built yet

- Per-helper budgets.
- A worker's questions routed to its maker; they go to the person.
- Workers on other machines.
- ace children's state between ace's waits; delegated threads are not in ace's event stream.
- The UI ([ADR 0161](../../docs/adr/0161-spade-orchestration-trees.md), UI).
