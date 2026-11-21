# 0204: Spade measures agent quality on the person's own real work

Status: accepted. Date: 2026-11-20. Decided by: the founder (2026-11-20), taking every
recommendation below. Builds on [ADR 0159](0159-spade-goals-plans-and-verification.md) (goals,
plans with evidence, the separate check of done), [ADR 0200](0200-spade-is-an-agent-operating-system.md)
§9 (scenario tests, the signer's scripted run), [ADR 0203](0203-spade-packages-ship-sandboxed-webassembly.md)
(code `check` exports) and [ADR 0168](0168-ace-marketplace.md) §10 (privacy). Keeps ace's rule
that nothing spends the person's provider quota unless they choose it.

## Context

What Spade proves about a package today is wiring. A scenario test scripts the model's steps and
fakes the tools, then checks the calls, effects, cards and outputs. The signer runs those tests
before it signs. That catches a broken manifest, a schema that doesn't fit and an effect the
package forgot to declare. It says nothing about whether the bot does its job on a real model with
real inputs.

At run time ADR 0159 already checks "done": a fresh model call sees only the goal, the criteria,
the plan and the stored evidence, and Spade refuses `done` unless every criterion is met. That is
per task, for bots that open a goal. A routine's run or a contract's answer gets no check.

Three things are missing:

1. A way for the person to see, on their own work, whether a bot or an update is good, before
   they rely on it.
2. Checks a package can ship, so a result is verified the same way every time, without a model
   where none is needed.
3. Evidence on a listing that is better than "its tests pass on a scripted model", without ace
   running anyone's models or reading anyone's data.

## Options considered

- **Benchmarks run by ace on real models.** Costs ace's or the person's quota, uses made-up tasks,
  and ace would be grading its own store. Rejected.
- **Publishers' self-reported scores on the listing.** Easy to game. ADR 0200 already says a
  publisher's own report proves nothing. Kept only as clearly labelled text.
- **Replays of the person's own recorded work, on their machine, plus package checks, plus opt-in
  outcome counts.** Chosen.

## Decision

### 1. Cases from real work

- **Every run is already stored.** A bot's conversation is event-sourced: its trigger, each model
  step, each tool call with its result, the verdict and the person's actions. A **case** is a
  frozen copy of one run's inputs and what came of it.
- **The person makes cases.** On a finished reply, routine run or contract call, the ⋯ menu has
  "Keep as a test". Two marks: "This was right" and "This was wrong", with an optional line of why.
  The Running page offers "Keep the last 20 runs as tests" per bot. Nothing is kept by itself.
- **What a case holds**, in `spade_core::quality::case`:
  `{id, bot, package {name, version, hash}, trigger, given, tool_results, outcome, mark, why,
  made_at}`. `given` is the message, trigger or contract input. `tool_results` is every outside
  answer in the order the run got it, keyed by tool and arguments. `outcome` is the reply's text,
  cards, contract output, the effects asked for, and ADR 0159's verdict if there was one.
- **Redacted at the moment it is kept**, before it is written: secrets by 0168's key and token
  patterns, the person's own sign-in addresses and names from `about_person` replaced with fixed
  stand-ins, and any value the person marks in a review step shown before saving. The original run
  stays in the conversation, untouched.
- **Local only.** Cases live in Spade's database on the bot's machine, move with the bot (ADR
  0187), and are never sent anywhere. "Export cases" writes a folder of scenario files the person
  can share by hand; it shows every value before it writes.

### 2. Replays

A case runs again in one of two ways.

- **Wiring replay, free.** The case becomes a scenario: the recorded model steps as the scripted
  model, the recorded tool results as fakes. It proves that a new version of the package still
  accepts the same steps, declares the effects they need and fits its schemas. It costs nothing
  and spends no quota. Run on every update review by default.
- **Model replay, opt-in.** The bot's current model (or one the person picks) runs the case for
  real, on the person's endpoint, local model or CLI subscription, at the person's cost. Every tool
  answers from `tool_results`: a call that matches a recorded one by tool and arguments gets that
  answer; any other outside call answers "Not in the recording" and is counted. Nothing outward
  runs: sends, payments, pushes and every `network` effect are answered from the recording or
  refused. Spade's own tools run in a throwaway copy of the bot's workspace.
- **How a replay is judged**, in order, with no model where none is needed:
  1. **The package's checks** (section 3) on the new outcome.
  2. **The outcome's shape:** contract output and cards fit their schemas; no effect outside the
     ceiling was asked for; no call left the recording more than the case allows.
  3. **The recorded mark.** A case marked right passes when the new outcome agrees with the old
     one, read by ADR 0159's verifier with the old outcome as the criteria: one fresh call, quoting
     both, on the person's review model. A case marked wrong passes when the verifier says the new
     outcome doesn't repeat the stated mistake.
  4. A case with no mark only reports the first two.
- **Before an update.** The update review offers "Try it on your last 20 kept runs" with the
  estimated cost from the person's prices ("About $0.12 on your fast model"). The result is a line
  per case and a summary: "18 of 20 the same or better. 2 worse: see why." The person decides as
  before. Nothing applies by itself.
- `ace bot test --cases BOT` runs a bot's kept cases from the terminal, wiring by default,
  `--model ROLE` for a model replay.

### 3. Checks before "done"

A package can declare checks that Spade runs on a result before it counts as done.

```json
"checks": [
  {
    "name": "fare-has-link",
    "on": ["contract:cheapest_fare", "card:fare-drop"],
    "kind": "schema",
    "rule": { "required": ["link"], "properties": { "link": { "pattern": "^https://" } } }
  },
  { "name": "fare-is-current", "on": ["contract:cheapest_fare"], "kind": "code", "code": "code/fares#fare-is-current" },
  {
    "name": "said-why",
    "on": ["goal"],
    "kind": "criterion",
    "text": "Each fare it reports names the route, the date seen and the link."
  }
]
```

| `kind`      | Runs                                                                                                   | Costs           |
| ----------- | ------------------------------------------------------------------------------------------------------ | --------------- |
| `schema`    | A bounded JSON Schema on the result, beyond the contract's or card's own                               | nothing         |
| `code`      | A component's `check` export (ADR 0203) with the result; answers pass or fail with reasons            | compute only    |
| `criterion` | Added to the goal's criteria when the bot opens a goal, judged by ADR 0159's verifier                  | one verifier call, as today |

- **Where they run.** On a contract's output before `contract_return` reaches the caller; on a
  card's data before it is shown; on a goal when the bot claims `done`. A schema or code check that
  fails sends the result back to the bot with the reasons, at most twice, as a contract's schema
  check does; then the call fails, the card isn't shown, or the goal reads `not_yet`.
- **Routines get a goal.** A schedule, event or webhook trigger may say `"verify": true`. Its run
  opens a goal from the trigger's instruction with the package's `goal` criteria, so the run ends
  in ADR 0159's check like a task does. Its cost is shown on the review ("Checks each run with one
  extra call on your review model").
- Checks are the package's words, so they can only add conditions. They never mark anything done
  that Spade's own check refused.

### 4. What a listing says about behaviour

Three kinds of evidence, never mixed, each labelled for what it is:

1. **"Wiring checked"**: the signer ran the package's scenarios and replay-exported cases on the
   scripted model, and they passed. This is today's signer run, renamed so nobody reads it as more.
2. **"Its publisher reports"**: the publisher may attach a `EVIDENCE.md` with their own model
   replays (models used, number of cases, results). Shown as their words, with "ace hasn't
   checked this." Never in the signed manifest, never in ranking.
3. **"From people who use it"**: counts from installs whose owners turned on sharing (section
   5), per version: how many bots ran, runs per week, the share of goals verified done, the share
   of contract calls and checks that passed, how often people stopped a run, rolled the version
   back or uninstalled it. Shown only once at least 20 installs on that version share, rounded to
   whole percent, with the count of installs behind it.

### 5. Sharing outcome counts

- **Off unless the person turns it on**, in Settings › Spade › Help improve packages, once, with
  the exact list of what is sent. Per bot it can be turned off.
- **What is sent**, once a day, to the market (`POST /v1/outcomes`): the package name, version and
  hash, and integers for that day: runs, goals opened, verified done, `not_yet`, `unchecked`,
  contract calls, check failures, Stops, rollbacks, uninstalls. A random install id that changes
  every 30 days, so ace can't follow one install for long. Nothing else: no text, no tool names, no
  hosts, no cases, no account id, no machine id.
- The market stores daily sums per version and drops the install ids after summing. A version's
  numbers are public on its entry page.
- Turning sharing off stops sending from the next day. Nothing already summed can be taken back,
  which the setting says.

### 6. Quota

- Nothing in this ADR runs a model the person didn't choose to run. Wiring replays, schema checks
  and code checks spend nothing. Model replays and verified routines say their cost first and run
  on the person's own models. ace runs no model on anyone's behalf, and the signer stays on the
  scripted model.
- ace tests its own first-party packages the same way, on ace's own cases and models, and
  publishes those results as "its publisher reports", like anyone else.

### 7. Phases

1. **First slice: cases and wiring replays.** "Keep as a test", redaction at keep, cases in
   Spade's database, cases as scenarios, `ace bot test --cases`, the update review's free replay.
   `schema` checks on contracts and cards.
2. **Model replays and verified routines.** The recording-backed tool layer, the verifier's
   comparison, the update review's opt-in replay with cost, `"verify": true` on triggers,
   `criterion` checks.
3. **Evidence on listings.** "Wiring checked", `EVIDENCE.md`, outcome sharing and the entry page's
   counts.
4. **Code checks** once ADR 0203's phase 3 lands.

## Decided

The founder took each recommendation on 2026-11-20.

1. **Cases are kept only when the person asks**, never by themselves.
2. **Outcome sharing is opt-in**, counts only, with a rotating install id and a floor of 20
   installs before anything shows.
3. **Model replays run only on the person's say and their own models.** ace never runs a model
   for this.
4. **Publisher evidence is shown as their words**, never signed and never ranked.

## Consequences

- A person can judge a bot and an update on their own work, not on ace's word or the publisher's.
- Packages get a reason to ship checks, and contracts become safer to rely on.
- The market gains a new write (`/v1/outcomes`) and a privacy promise to keep. It adds a table per
  entry type's database.
- Recording-backed replays only cover what a run recorded. A new version that calls a new tool
  gets "Not in the recording" and is judged on less. The summary says how many calls were outside
  the recording.
- A verifier comparing two outcomes is a model judging a model. It is a signal, labelled as one,
  and never the only thing that decides an update.

## Tests

- Keeping a case writes no secret or sign-in address that the run held; a case moves with its bot;
  "Export cases" writes only what the review showed.
- A wiring replay of a case passes on the version it came from, and fails on a version that drops
  an effect the run used or changes a contract's output shape.
- A model replay, on `spade-testkit`'s fake model endpoint standing in for the person's model:
  every outward call answers from the recording or is refused, and none reaches a network; a call
  outside the recording is counted; nothing is written to the bot's real workspace.
- A `schema` check that fails sends the contract's output back to the callee and, after two more
  failures, fails the call; a `criterion` check joins the goal and a `done` without it reads
  `not_yet`.
- A routine with `"verify": true` opens a goal and ends verified or `not_yet`, never done unchecked.
- Outcome sharing, against a real local market: nothing is sent while it is off; what is sent
  holds only the listed fields; the entry page shows nothing below 20 installs.
