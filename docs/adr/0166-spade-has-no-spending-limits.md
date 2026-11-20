# 0166: Spade has no spending limits

Status: accepted. Date: 2026-11-15. Decided by: the owner (2026-11-15: Spade has no budgets or
spending limits of any kind; "it makes no sense for our product"). Amends
[ADR 0135](0135-spade-research-and-oversight.md) (decision 2, the per-bot caps, and research's
spend budget), [ADR 0158](0158-spade-no-fixed-step-or-time-limits.md) (caps park a task, the
service cap), [ADR 0160](0160-spade-wake-and-owned-services.md) (the `park` wake with reason
`cap`), [ADR 0161](0161-spade-orchestration-trees.md) (decision 4, subtree budgets),
[ADR 0162](0162-spade-model-routing.md) (decision 5, the `<budget>` note) and
[ADR 0165](0165-spade-digests-and-decision-log.md) (the escalation levels of caps and budget
parks). The contract is in [spade/docs/oversight.md](../../spade/docs/oversight.md).
Amended by [ADR 0195](0195-spade-reaches-the-person.md): an alert (never a stop) when a bot's spend rate is unusual, once per episode, which the person can tune or turn off; spend in the app reads live.

## Context

ADR 0135 gave each bot optional daily and monthly caps beside a service-wide daily cap. Later
decisions built on them: a task stopped by a cap parked until the reset (0158, 0160), a worker's
subtree had a budget it waited on (0161), each step Spade started on its own carried a
`<budget>` note (0162), and a cap or budget park was a `stop` in the digests (0165). Each one
added a way for a bot to stop mid-task for reasons unrelated to the work, plus settings, routes
and states the person had to understand. The owner decided Spade has no spending limits at all.
The person pays their own endpoints, and Stop is the control that ends work.

## Decision

1. **Nothing stops, waits or is refused for spend.** No model call is refused or held back for
   cost: not a turn's step, compaction, a title, a review, a check of done, research, a digest's
   polish, an image or a transcription. Messages, bot-to-bot messages, group asks, remote asks
   and routines are never refused or skipped for spend. The removed pieces:
   - each bot's daily and monthly caps, and the service's daily cap (`SPADE_DAILY_CAP_USD` is
     no longer read; a value left set is ignored);
   - research's spend budget per depth (its question, page and time budgets stay);
   - subtree budgets: `budget_usd` on `bot_create`, the `worker_budget` tool and
     `PUT /v1/agents/{id}/budget` (now `404`);
   - the cap and budget parks (`wake_set {purpose: {kind: park, reason: cap}}` and
     `wait_for {condition: budget}`), their resume at a reset or a raise, the worker report
     state `parked`, and the roster's "At its daily cap" and "Waiting for more budget";
   - the `<budget>` note at the end of a continued step's nudge;
   - `cap_reached` and its activity kind (`cap`), chat bubble and escalation level, and the
     `402` answers.
2. **Spend stays, as information.** Every model call is still paid for in the ledger, by
   conversation and role (ADR 0162): the bot's spend today and this month (in its profile, the
   roster and `GET /v1/agents/{id}/oversight`), every bot's total (Settings › Spade), spend by
   role (`GET /v1/agents/{id}/models`, the activity log), the cost of each turn in the activity
   log, a worker tree's `cost_micros` and `subtree_cost_micros`, and spend in digests.
3. **Old data still reads.** Nothing about it is fatal:
   - A forward migration removes `daily_cap_micros` and `monthly_cap_micros` from each bot's
     stored settings, and drops a row left empty. The review switch stays.
   - A cap or budget park found open when Spade opens is cancelled (`wake_cancelled {by:
spade}`) and its task carries on, as if the park had fired.
   - A stored `cap_reached` or `worker_budget` is read as raw data and folds to nothing. A
     `budget_micros` on a stored `worker_of` or `worker_started` is ignored. A stored worker
     report of state `parked` reads as `other`. A reply an older build failed with kind `cap`
     counts as finished for its task, which carries on, has no escalation level, and in the
     app reads as any failure that can be tried again.
   - An older app's `PUT /v1/agents/{id}/oversight` with caps saves only its review switch.

## Options considered

- **Keep caps, off by default.** Leaves every park, refusal and setting in the code paths and
  the person's head for a feature the product doesn't want.
- **A warning at a spend level instead of a stop.** Possible later as a notification; it would
  be information like the spend already shown, never a stop.
- **Drop old cap and budget events on migration.** Rewriting history is riskier than reading it
  leniently, and every fold already ignores what it doesn't know.

## Consequences

- A bot works until its task is done, the person presses Stop, or something outside Spade (a
  refused key, a used-up quota) fails its calls. A runaway bot is bounded only by Stop and the
  person's own endpoint limits.
- The ledger no longer reserves estimated costs for calls in flight: admission is a plain
  record of what each call cost.
- Tests that asserted caps and budgets are gone. New ones check that nothing parks for spend,
  that an old cap or budget park is cancelled on start and the task continues, that spend is
  still recorded, and that the removed route answers `404`.
