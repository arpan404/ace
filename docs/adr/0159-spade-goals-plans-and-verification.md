# 0159: A Spade task has a goal, a plan and a separate check of "done"

Status: accepted. Date: 2026-11-15. Decided by: the owner (2026-11-15, Spade capability work
wave A: "durable goals, plans, verification and honest progress, for multi-day and multi-week
work"). Extends [ADR 0144](0144-spade-autonomous-bots.md) decision 6 (the task and
`task_status`) and builds on [ADR 0158](0158-spade-no-fixed-step-or-time-limits.md) (no fixed
limits), [ADR 0135](0135-spade-research-and-oversight.md) (the review model) and
[spade/docs/harness.md](../../spade/docs/harness.md) (events, compaction).

## Context

A bot's only durable task state is its latest `task_status {status, note}` and the latest `todo`
list. Both are the bot's own words. The goal lives in the conversation and, after a compaction,
in a summary the model rewrites each time, so after weeks and dozens of compactions "what am I
doing and why" depends on prose that drifts. The task ends when the bot says `done`: the worker
grades itself, and published practice is consistent that agents over-rate their own work, mark
items done after shallow checks, and declare the whole job finished because some of it is.

## Decision

1. **A task has a goal.** The bot drafts it with `task_goal {title, criteria}` when it starts
   a task of several steps. The goal's text is the person's own words (their latest message, or
   the bot's task when a routine or another bot started the work); the criteria are the bot's
   draft of what "done" means, each one checkable. Once a goal is open the bot can't change or
   replace it: `task_goal` is refused. Only the person can, with
   `PUT /v1/agents/{id}/task/goal` (text, criteria, optionally the verifier's model), or end it
   with `DELETE`. A goal closes when the check (4) says done or the person ends it; then the bot
   may draft the next one. Stored as `goal_set {goal, title, text, criteria, by, verifier?}`
   and `goal_cleared {goal}`.
2. **A task has a plan,** a list of items stored as events, changed only by
   `task_plan {op, …}`:
   - `add {text, parent?}`, `split {item, into: [text]}` (the item becomes the parent of the
     new ones), `start {item}`, `done {item, evidence}`, `blocked {item, reason}`.
   - Item ids are given by Spade in order (`1`, `2`, `2.1`), never by the model.
   - **An item closes only with evidence:** `output {call}` (a tool call or background job in
     this conversation: a command, a test run, a fetched page, a check), `file {path}` (a file
     a call in this conversation wrote or read) or `url {url}`. Evidence that names a call this
     conversation doesn't have, or one still running, is refused with the reason.
   - Each change is stored as `plan_changed {goal, change}`. Each closed item also stores
     `plan_checkpoint {goal, item, done, total}`: the point a restart, crash or compaction
     resumes from.
   - `todo` stays for bots without a goal.
3. **The plan rides in the prompt top, refreshed only at compaction.** After each compaction the
   instructions end with the goal, its criteria and the plan as they stood when that compaction
   was stored, folded from the events, never from the summary. Between compactions the top is
   the same bytes (the cache holds); the changes since are in the conversation itself. A step
   Spade starts on its own (ADR 0144) tells the bot to resume from its plan.
4. **"Done" is decided by a separate check.** When a reply ends with the latest `task_status`
   `done` and a goal open, and no background job runs, Spade does not take the bot's word:
   - A verifier makes one fresh model call that sees only the goal, the criteria, the plan's
     items with their status and the evidence. For `output` evidence that is the call's real
     stored result (cut to 4,000 characters), never the bot's paraphrase; never the bot's
     messages, notes or reasoning. Everything is quoted data in tags, `<` and `>` escaped.
   - It uses the review machinery's model choice and admission: the goal's verifier model when
     the person set one, else the person's review model, else the fast model, else the bot's.
     Its cost counts in the bot's caps.
   - It answers per criterion (met or not, why), the items whose evidence doesn't hold, and a
     verdict. The verdict is `done` only when every criterion is met and no item is rejected;
     Spade enforces that, whatever the model says.
   - Stored as `task_verified {goal, claim, verdict, criteria, rejected, missing, model,
     cost_micros}` before anything acts on it; a restart reuses it. `claim` is the id of the
     `task_status` call it judged, so each claim is checked once.
   - `not_yet` sends the bot back to work: its task reads as `working`, the rejected items
     reopen, and the next step's note lists what's missing. A claim with nothing new since the
     last `not_yet` (no plan change) gets `not_yet` again without a model call, so the
     no-progress pause of ADR 0144 still ends a loop.
   - A check that can't run (a cap, an error, a timeout of 60 s) stores `unchecked` with the
     reason: the task is not done, nor sent back; the person sees "says done, not checked".
     The bot's next `done` claim is checked again.
5. **Progress is derived, never said.** A pure fold of the events gives the goal, criteria,
   items, evidence and the latest verdict. An item counts as verified when it is closed with
   evidence and a later verdict didn't reject it. `progress.state` is one of `none`,
   `working`, `checking` (a claim waits for its check, or the check runs), `not_yet`,
   `unchecked` and `done`. `done` needs a `done` verdict on the latest claim and no
   background job still running (ace priority 1).
6. **API.** `GET /v1/agents/{id}/task` answers `{goal, criteria, items, verdict, progress,
   checkpoint}`; every agent in the roster adds `task_progress {state, items_total,
   items_closed, items_verified}`. `task_state` (ADR 0144) stays the bot's own word, so a
   client shows "done" only from `task_progress.state`.

## Options considered

- **The plan inside the compaction summary.** Shorter, but it is the drift this replaces: the
  model rewrites it each time.
- **A plan block rebuilt every step.** Always current, but every plan change would rewrite the
  prompt top and miss the cache for the whole conversation.
- **Self-check by the bot itself.** Cheapest, but it is the worker grading itself, which is
  what fails.
- **The verifier running tools** (re-running the tests). Stronger, but it is a second agent
  with its own gate and taint; deferred. Today the bot must show a result in a call the
  verifier can read.
- **File evidence by hash.** Needs the workspace in the engine; for now a file is backed by the
  calls in this conversation that touched it, and the verifier is told which.

## Consequences

- A bot can't end a task by saying so; it ends when its evidence meets the person's criteria,
  or the person ends it.
- The verifier only judges what is in the evidence. A bot that never shows a result can't pass,
  which is intended; a misleading tool output can still mislead it.
- Each claim of done costs one cheap model call.

## Tests

`spade_core::goal` is tested by tables: the fold, refused changes (the bot editing an open goal,
done without evidence, evidence naming an unknown or running call), the verdict rule, the
plan in the prompt top only after a compaction, progress states. Engine tests with scripted
model fakes: a `done` claim is checked by a call that sees the evidence and not the bot's
words; `not_yet` sends the bot back with what's missing; a verified task shows done; the
person's goal edit holds and the bot's is refused; the plan survives a compaction in the
prompt top.

## UI (a later wave)

The web and iOS views need: the goal with its criteria (editable by the person), the plan as a
tree with each item's status, evidence links (to the call in the activity log, the file, the
URL) and verified mark, the latest verdict with what's missing, `task_progress` in the roster
line ("4 of 7 verified", "Checking", "Not yet: …", "Says done, not checked"), and the
checkpoints on the activity timeline.
