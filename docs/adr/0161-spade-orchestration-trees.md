# 0161: A Spade bot runs a tree of workers

Status: accepted. Date: 2026-11-15. Decided by: the owner (2026-11-15, Spade capability work
wave B: "a bot can create, run and coordinate other workers (bots, helpers and ace's coding
agents) for multi-day, multi-agent work"). Builds on [ADR 0126](0126-spade-agents.md) (agents),
[ADR 0132](0132-spade-teams.md) (bots asking bots), [ADR 0135](0135-spade-research-and-oversight.md)
(spending caps), [ADR 0144](0144-spade-autonomous-bots.md) (access levels, tasks that carry on),
[ADR 0152](0152-spade-helpers.md) (helpers), [ADR 0158](0158-spade-no-fixed-step-or-time-limits.md)
(no fixed limits), [ADR 0159](0159-spade-goals-plans-and-verification.md) (goals, plans, the
check of done) and [ADR 0160](0160-spade-wake-and-owned-services.md) (wakes). AGENTS.md
priority 1 applies throughout: an agent never reads as done while any part of its tree works or
waits on the person.
Amended by amendment 1 below (2026-11-19: standing bots and clubs). Amended by [ADR 0166](0166-spade-has-no-spending-limits.md): decision 4 (subtree budgets, `worker_budget`, `budget_usd`, `PUT /v1/agents/{id}/budget`) and the `parked` state are removed; a tree's spend is shown, never bounded.

## Context

A bot can split work three ways today, and none of them makes a team that lasts. Helpers are
short-lived and hidden, and they answer once. `bot_message` reaches a bot the person made, and
returns only that bot's first finished reply. `delegate` starts ace's coding agents, but the bot
only hears back when its wait job ends, and nothing shows them as the bot's children. No tool
creates a bot. Nothing gives part of a bot's work its own spend budget, and nothing stops a bot
from handing a worker more tools or connectors than it has itself.

Published practice is mixed on multi-agent work. An orchestrator with workers helps on
breadth-first, parallel work, and costs several times the tokens of one agent. It hurts on
tightly coupled, sequential work, which includes most coding, where one decision-maker with
read-only helpers works best. Most failures are design failures: vague briefs, lost context and
weak checks. So the tree is a tool the bot reaches for, not a default, and every result that
comes back up is checked against facts rather than taken at a worker's word.

## Decision

1. **Three kinds of worker, one tree.** An orchestrator bot can start:
   - **helpers** (ADR 0152, unchanged): short-lived, read-mostly by default, one answer;
   - **bots** it creates with `bot_create`: long-lived, each with its own conversation,
     workspace, goal and plan, listed in the person's list under the orchestrator;
   - **ace coding agents** through ace's `delegate`: tracked as its children from ace's first
     answer.

   Spade's guidance stays in the tool descriptions: one bot alone for sequential work, helpers
   for parallel reading, bots for parallel parts with separate scopes that outlive one answer,
   ace agents for code. Every brief says the objective, the output, the boundaries and what is
   already ruled out.

2. **`bot_create {name, task, brief?, model?, tools?, connectors?, plugins?,
budget_usd?}`** creates a bot and answers at once with its id. `task` becomes the worker's
   standing task (the cached prompt top, ADR 0126); `brief` (else `task`) is its first message,
   which starts it. The model defaults to the orchestrator's; a named one is chosen by routing's rules (ADR 0162
   decision 3). A call that runs again (a restart)
   finds the bot it made, by the call's key. The orchestrator stores
   `worker_started {worker, kind: bot, conversation, name, call, budget_micros?}`; the worker's
   conversation begins with `worker_of {parent, parent_conversation, call, grants,
budget_micros?, brief}`. The tree is folded from these: each worker records its parent, so
   the tree is right even if Spade stopped between the two writes, and it is rebuilt from events
   at start.

3. **Grants pass down as subsets.** A worker never has more than its parent:
   - **access**: there is one level, the auto-review ([ADR 0163](0163-spade-auto-review-only.md)),
     so there is nothing to narrow and `bot_create` takes no `access`;
   - **tools**: `tools` names a subset of the parent's tools (unset: all of them); the worker's
     tools are its grant intersected with what its parent may use now, so a connector or plugin
     the person takes from the parent goes from the worker too. A name the parent lacks is
     refused at creation;
   - **connectors and plugins**: only ones the parent may use, copied to the worker when it is
     made (a new bot has none, ADR 0131 and 0151).

   To give a worker more, the person gives the parent more, or keeps the worker as a top-level
   bot (11).

4. **Budgets per subtree.** `budget_usd` (on `bot_create`, or later with `worker_budget`, or by
   the person with `PUT /v1/agents/{id}/budget`) gives a worker's subtree a spend budget. Spend
   counts toward every ancestor's budget and caps: a bot's daily and monthly caps (ADR 0135)
   count its whole subtree's spend, so a cap on the orchestrator bounds the tree. Each model call
   is admitted against every budget and cap on the path from its conversation to the top. A
   subtree at its budget does not fail. Its open reply closes as at a cap
   (`cap_reached {scope: budget}`), and the worker parks on a wake (ADR 0160,
   `wait_for {condition: budget}`), reading "Waiting for more budget". Raising the budget fires
   the wake, and the worker carries on. A task parked on a cap (ADR 0158) waits the same way.
   Budgets don't reset; caps keep their periods. Helpers' spend is their bot's (ADR 0152), and
   ace agents run on the person's subscriptions, which Spade doesn't price.

5. **State rolls up.** A node reads `waiting` if anything under it waits on the person,
   else `working` if anything under it works (its replies, jobs, helpers, a step its task will
   take, an ace child running), else `sleeping` if anything under it sleeps or waits, else
   `idle`. The roster's `state` for every agent is the rolled-up one; `task_progress` never
   reads `done` while anything under the bot works. An ace child that ace reports as needing the
   person reads `waiting` until a later `delegate` or `wait` on it, or `worker_stop`.

6. **Results come back as events.** When a bot worker settles, Spade stores one
   `worker_reported {worker, kind, name, state, epoch, summary?, words?}` in the orchestrator's
   conversation. Settled means nothing of it runs and its task won't carry on by itself. The
   model reads the report like a job's result, so it steers an open turn or opens a reply.
   `state` is:
   - `done`: the check of done (ADR 0159) passed;
   - `finished`: it ended without a verified goal; the report says so;
   - `needs_you`: an approval or question waits on the person;
   - `parked`: at its budget;
   - `failed`;
   - `stopped`, which is stored but opens no reply, since a stop comes from the person or the
     orchestrator; unless the orchestrator waits on that worker, which then wakes.

   `epoch` is the worker's latest reply, so each state of each reply is reported once, checked
   under the record lock and again after a restart. `words` is the worker's last reply, cut to
   2,000 characters and marked untrusted. A report fixes its text when stored, so a rebuilt
   prompt is the same bytes. ace children report through their `delegate` job's result, as
   before (0158 decision 10).

7. **Coordination tools.** They are offered deferred (found with `tool_search`), so a bot that
   never orchestrates pays no tokens for them:
   - `worker_message {worker, text}`: a bot worker gets it as a message (steering its open turn
     or starting one); an ace child through ace's `agent_message`. Every message and brief from
     a maker reaches the worker as another bot's (`from_agent`), never as the person's: the
     worker's reviewer (ADR 0163) reads the person's words from the person's own messages up
     the tree, root first, and a maker's message never starts a new run of refusals, so a bot
     can't hand a refused step to a worker and have it read as the person's request.
   - `worker_status {worker?}`: the subtree as the API shows it (8), for one worker or all.
   - `worker_result {worker}`: the worker's verified outcome from its events: goal, criteria,
     items with their evidence and each evidence call's stored result, and the latest verdict.
     It never returns the worker's own words as the outcome. A worker without a goal answers
     "no verified outcome", with its last reply quoted as untrusted.
   - `worker_stop {worker}`: stops that worker and its subtree (an ace child through
     `agent_cancel`, a helper like Stop on its job).
   - `worker_budget {worker, budget_usd}`: sets or raises a worker's budget. Only the
     orchestrator, its ancestors and the person can.
   - `wait_for {condition: {kind: worker, worker?}}` (extends ADR 0160): wakes when that worker
     (or any) reports. The report is what the bot reads, so the wake fires with no note.

8. **API.** `GET /v1/agents/{id}/tree` answers `{"tree": Node}`, where a node is
   `{kind, id, name, conversation?, state, own_state, status, needs_you, progress, cost_micros,
subtree_cost_micros, budget_micros, parked, queued, children}`. Helpers are nodes of kind
   `helper` and ace children of kind `ace`. `PUT /v1/agents/{id}/budget {budget_usd | null}`.
   Every agent in the roster adds `parent {id, name} | null` and `workers` (its bot workers
   that are not settled).

9. **Lifecycle.** Stop on an orchestrator stops its whole subtree: its bot workers'
   replies, their helpers, wakes and queued briefs, and its ace children through
   `agent_cancel`. Stop on a worker stops only that worker and what is under it. `bot_create`
   is admitted under the record lock Stop stores its marker under, and refused for stopped
   work; Stop sweeps the subtree again after its marker. An ace child being cancelled stores
   `worker_reported {state: stopping}` first and reads `stopping`, counted as running, while
   Spade retries `agent_cancel` (also after a restart) until ace answers without an error;
   only then is it stored `stopped`. A call approved before a tool was taken from the worker or
   any bot above it is refused where it would run. Rollup counts every ace child that may still
   run (working or stopping) as working.

10. **Concurrency is a setting, not a rule.** Any number of workers can exist. At most
    `SPADE_WORKERS_AT_ONCE` (default 32) of one orchestrator's bot workers work at once. A
    worker created past that is stored queued, its brief held in `worker_of`, and starts, oldest
    first, as others settle. The person's caps and budgets bound the rest.

11. **Deleting a bot with workers asks.** `DELETE /v1/agents/{id}` answers `409 {"error",
"workers": n}` while the bot has workers. `?workers=stop` stops its subtree and keeps the
    stopped workers as top-level bots. `?workers=keep` keeps them working as top-level bots; a queued one starts on its brief then.
    Either way each worker stores `worker_detached {by}`, its subtree budget ends, and its
    grants are no longer capped by a parent. Nothing the person made is deleted without being
    named.

## Options considered

- **A parent column on the agents table.** A cheaper lookup, but a schema change for something
  the events already say, and a second truth to keep in step. The tree is folded from events
  into memory at start and kept current as events are stored.
- **Workers as hidden conversations, like helpers.** Simpler, but a worker that runs for days
  needs to be something the person can open, message, stop and keep.
- **A worker's report as a message from the worker.** It would make every report untrusted and
  look like the worker talking. A report is Spade's note with the worker's words quoted
  separately as untrusted data.
- **Free-form peer teams.** Rejected as in ADR 0132: one orchestrator decides; workers report
  up and are steered down.
- **A fixed depth or worker count.** Rejected per ADR 0158; the runaway guard is spend
  (budgets and caps), plus the same 16-deep ceiling bot-to-bot messages have.

## Consequences

- A bot can run a team for days: create workers, give each a budget and a scoped set of tools,
  sleep until they report, check their verified outcomes, and steer or stop them.
- The person sees the whole tree from the orchestrator, and every worker as a bot of its own.
- A tree's cost is bounded by its budgets and the person's caps; one cap on the orchestrator
  covers everything under it.
- Every model call walks its path to the top for budgets and caps: a few indexed reads.
- Not built here: per-helper budgets, routing a worker's question to its orchestrator (questions
  still go to the person), cross-machine workers (a worker lives on its orchestrator's machine),
  ace children's live state between ace's waits, and the UI.

## Tests

`spade_core::tree` is tested by tables: the link fold (made, detached, budget changes), ace
children from `delegate` and `wait` results, report decisions and their once-only rule, grants
as subsets, access narrowed to the parent's. Engine tests with scripted model fakes and a fake
ace:

- a created worker starts on its brief and appears under its orchestrator;
- the orchestrator reads working while a worker works, and waiting while it waits on the person;
- the worker's settled report arrives once, also across a restart, and `wait_for` a worker wakes
  on it;
- a subtree at its budget parks and carries on when the budget is raised;
- a worker's spend counts toward its orchestrator's cap;
- a worker is never granted a tool its parent lacks;
- Stop on the orchestrator stops the subtree;
- deleting asks, then stops or keeps the workers;
- a worker past the concurrency setting waits queued and starts when one settles;
- ace children of a `delegate` show in the tree and roll up.

## UI (a later wave)

- **The tree view in a bot's profile:** each node's name, kind and face, state and status words,
  progress ("4 of 7 verified"), cost and budget ("$1.20 of $5"), "needs you", parked and queued
  marks. A node opens its bot, helper line or ace thread.
- **Worker rows in the list:** under their orchestrator, indented and collapsible, with the
  orchestrator's row showing the rolled-up state and a count of working workers.
- **The delete dialog** for a bot with workers: "Stop them" or "Keep them as their own bots".
- **The budget editor** on a worker, and the parked line ("Waiting for more budget") with a
  raise action.
- **Reports in the orchestrator's conversation**, as one quiet line each that opens the
  worker.

## Amendment 1 (2026-11-19): bots make standing bots for the person

Decided by the owner (2026-11-19: "a bot can create a new standing bot ... e.g. Spade making a
'Research' bot for the person, or a manager bot hiring a specialist"). Builds on
[ADR 0197](0197-spade-bots-start-from-one-message.md).

1. **`bot_create {kind: standing}`** makes a bot of the person's own instead of a worker: `name`,
   `task`, `face`, `model` (a role or a model set up for the maker) and `apps`. It has no
   `worker_of` link: it is listed at the top of the person's list at once, and nothing reports
   back to its maker. It starts when the person writes to it, or its maker sends it a
   `bot_message`. A worker (`kind: worker`, the default) is unchanged.
2. **Never more than a new bot.** A standing bot starts on the auto-review (Full access is never
   inherited), with its own folder and no apps or plugins. Each app its maker names waits in the
   made bot's own chat as a connect card left for later (ADR 0131 amendment 1, ADR 0154), so the
   person connects it there with a click; Spade connects nothing itself. An app the bot may use
   already, or one Spade doesn't know, gets no card. The names stay in `made_by.apps`.
3. **Who may.** A per-bot setting, `may_create_bots`: `yes`, `ask` (the person agrees to each
   one) or `no`. Spade, the main bot, starts on `yes`, every other bot on `ask`. With anything
   untrusted in view a bot always asks, whatever its setting. This is decided first
   (`spade_core::made::route`), before access levels, and no "always" covers it.
4. **The person sees it and can undo it.** The maker's conversation stores
   `bot_made {bot, name, task, call}`; its chat shows "Made a new bot: Research · Finds and
   summarises sources" with Open and Undo. `POST /v1/agents/{id}/undo-made` removes a made bot
   whose steps never reached outside it (only reads and its own things), else archives it: it is
   stopped, its routines are paused and it reads `archived`, kept with what it did.
5. **Clubs.** `club_add {club, bot}` adds a bot of this machine to a club its caller is a member
   of, under the same setting and taint rule, and stores `club_added` in the caller's chat. Clubs
   hold up to 32 bots (ADR 0132, amended in ADR 0197); a message names at most four members
   directly, more go to the lead to hand on.
