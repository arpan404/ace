# 0162: A Spade bot uses a model per role, within the person's endpoints

Status: accepted. Date: 2026-11-15. Decided by: the owner (2026-11-15, Spade capability work
wave B: "model routing for long runs: bots use cheaper or faster models for sub-work and strong
ones for decisions, within the person's endpoints"). Builds on
[ADR 0126](0126-spade-agents.md) (endpoints and models), [ADR 0133](0133-spade-cli-brains.md)
(CLI brains), [ADR 0135](0135-spade-research-and-oversight.md) (review model, caps),
[ADR 0152](0152-spade-helpers.md) (helpers), [ADR 0158](0158-spade-no-fixed-step-or-time-limits.md)
(caps park, never end) and [ADR 0159](0159-spade-goals-plans-and-verification.md) (the verifier).

## Context

A bot on a frontier model spends that model's price on everything: its own decisions, but also
each helper's reading and searching, every compaction summary, titles, reviews and checks of
"done". On multi-day work that spends the caps fast, and it is the cheapest lever there is:
published harnesses run checks, classifiers and readers on small fast models and keep the
strong model for decisions. Spade already has pieces of this (the person's fast model, the review
model, a model per plugin helper profile, the goal's verifier model), but each picks its model
its own way and no bot can choose.

## Decision

1. **Each bot has a model per role.** The roles:
   - `main`: the bot's own turns. It is the bot's model, set as today (`PATCH /v1/agents/{id}`);
     routing never changes it.
   - `helper`: helpers (ADR 0152). Default: the person's fast model, else the bot's.
   - `verify`: the check of "done" (ADR 0159). Default: the strongest model the person already
     uses (other bots' models, the review, fast and new-bot models) that lists at least the
     bot's own price and is not the bot's model; else the bot's.
   - `review`: the model review (ADR 0135). Default: the person's review model, else the fast
     model, else the bot's (unchanged).
   - `compact`: compaction summaries. Default: the fast model, else the bot's.
   - `title`: conversation titles. Default: the fast model, else the bot's.

   "Fast model" is the one `GET /v1/models` shows as `fast_model`. "Strength" is the listed
   price (input plus output per million tokens); an unpriced model (a flat plan, a local server)
   is never picked as stronger or cheaper by a default.
2. **The person overrides, per bot and globally.** A role's model is the bot's override, else the
   global one, else the default. An override names a model of the person's endpoints; one whose
   endpoint or model is gone is skipped, never an error at call time. Roles other than `main`
   take endpoint models only: CLI brains (ADR 0133) run whole sessions and can't answer a
   one-shot summary or check. The global `review` override is the existing oversight
   `review_model`, one setting in one place.
3. **The bot chooses per call, from what the person allows.**
   `helper {task, profile?, model?, escalate?}`: `model` is a role name (`helper`, `main`,
   `verify`, `review`, `compact`, `title`) or `endpoint/model`. The model is the call's, else
   the profile's, else the `helper` role's. A named model must be one the person configured:
   listed on one of their endpoints and, when the person narrowed the bot to an allowed list
   (`allowed`), on that list. Anything else is refused with the roles and the allowed models,
   so the bot can choose again. The bot never reaches a model the person hasn't set up.
   Workers (ADR 0161) use the same choice.
4. **Escalation, once.** With `escalate` on (the call's, else the bot's setting, else off),
   helper-level work that fails on a model other than the bot's own runs once more on the bot's
   own model: a helper that failed (its reply failed, or it finished without an answer) restarts
   as a second helper for the same job, stored as `<job>~2`, so a restart finds it rather than
   starting a third. A Stop never escalates. The pure rule also takes a "not yet" verdict, for
   work that is verified (workers, ADR 0161); a helper's result has no verdict of its own.
5. **The bot sees its spend; nothing stops on it.** Each step Spade starts on its own (ADR 0144)
   ends its note with a `<budget>`: spent today and this month, the caps and what is left,
   today's spend by role, and the model each role uses. It is information, so the bot can choose
   cheaper roles; caps still park the task (ADR 0158), and nothing else ends work.
6. **Cost per role.** The ledger records each call's role. `GET /v1/agents/{id}/models` and the
   activity log answer what each role spent today and this month, and each activity entry that
   carries a cost names its role.
7. **The cache holds.** A role's model applies from its next request that is already a new
   request: a bot's model from its next reply (as today), a helper's when it starts (stored with
   it), the others on each one-shot call. Nothing rewrites a past prompt. Compaction is the one
   step that reuses the conversation's prompt, as cache reads on the bot's model: on another
   model it runs only when that model's context holds the prompt, and, unless the person chose
   the compact model, only when its estimated cost, read cold, is below the bot's model's,
   read from the cache.

## API

- `GET /v1/models/roles`: `{roles: {helper, verify, review, compact, title}, escalate}`, the
  global overrides (`null` for none).
- `PUT /v1/models/roles`: `{roles?: {<role>: "endpoint/model" | null}, escalate?: bool | null}`.
- `GET /v1/agents/{id}/models`: `{roles: [{role, model, source}], overrides: {roles, allowed,
  escalate}, escalate, spend: {today: {<role>: micros}, month: {<role>: micros}}}`; `source` is
  `bot`, `global`, `default` or `own` (the bot's model, for `main` and every fallback).
- `PUT /v1/agents/{id}/models`: `{roles?: {<role>: "endpoint/model" | null}, allowed?:
  ["endpoint/model"] | null, escalate?: bool | null}`.
- `GET /v1/agents/{id}/activity` adds `spend_by_role {today, month}`; entries with a cost add
  `role`.

## Options considered

- **A learned router** picking per request. Promising on single-turn benchmarks, unproven for
  multi-step work, and a model of its own to run; deferred.
- **Rewriting a conversation onto a cheaper model mid-reply.** Saves more, but every switch
  misses the cache for the whole prompt and changes what the bot reads mid-thought.
- **Hard per-task budgets** that stop a cheaper route. Contrary to ADR 0158: spend is shown,
  caps park.
- **An `advise` tool** to consult a stronger model. Useful, but it is a second loop with its own
  context and taint; a later wave can build it on these roles.

## Consequences

- With a fast model set, helpers, titles and compaction run on it with no action from the person.
- A bot can spend its strong model only where it decides to, and the person sees where money went.
- The ledger gains a column; older rows count as `main`.

## Tests

`spade_core::routing` by tables: each role's default, overrides and their order, gone models
skipped, CLI models refused for one-shot roles, the per-call choice (role names, allowed models,
refusals), the escalation rule, the budget note's text. Engine tests with scripted model fakes:
a helper runs on the fast model by default and on a named role or model when asked; a model the
person hasn't configured is refused; a failed helper with `escalate` reruns once on the bot's
model and never twice; the verifier and review use their roles; a continued step's note carries
the budget; spend per role adds up in the API.

## UI (a later wave)

Settings › Spade › Models needs a role table (role, model picker from the person's endpoints,
"default: …" hint) and the escalate switch; each bot's profile needs the same table with
"follow Settings" per role, the allowed-models list and spend by role (today, month). The
activity log tags each cost line with its role.
