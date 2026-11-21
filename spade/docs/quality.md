# Quality: cases from real work

A bot's quality is judged on the person's own work ([ADR 0204](../../docs/adr/0204-spade-measures-agent-quality-on-real-work.md)).
This page covers **cases**, **replays** and **checks**. Evidence on listings comes later.

## A case

The person keeps one finished reply as a test, from the reply's More menu ("Keep as a test").
Nothing is kept by itself. A stopped, failed, interrupted or still-open reply can't be kept.

`spade_core::quality::case` reads the run out of the conversation's events:

| Field          | What it holds                                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------------------------------- |
| `id`, `bot`    | The case's id and its bot                                                                                             |
| `reply`        | The reply it was kept from; a reply is kept once                                                                      |
| `package`      | `{name, version, hash}` of the package the bot ran, for a packaged bot                                                |
| `trigger`      | `{kind, name?}`: `message`, `bot`, `routine`, `group`, `thread` or `contract`                                         |
| `given`        | `{messages, input?}`: the message it answered, any steered in while it ran, and a contract call's input               |
| `steps`        | Each model step's words and calls (`{id, tool, arguments}`); the model's thoughts are not kept                        |
| `tool_results` | Every outside answer in the order the run got it: `{call, tool, arguments, content, is_error}`                        |
| `outcome`      | `{text, cards, contract?, effects, verdict?}`: the reply, its cards, a contract's ending, effects, ADR 0159's verdict |
| `mark`, `why`  | `right` or `wrong`, and one line of why (at most 280 characters)                                                      |
| `made_at`      | When it was kept                                                                                                      |

A case larger than 4 MB as JSON isn't kept.

## Redaction

`spade_core::quality::redact` runs before anything is written. Every string of the trigger's name,
`given`, `steps`, `tool_results`, `outcome` and `why`, and every object key in them:

1. Values the person marked on the review are replaced with `•••` (at least two characters each,
   at most 50 values).
2. The person's own mail addresses become `person@example.com` and their names `Person`, read
   from the shared (`about_person`) notes they kept: addresses anywhere in them, names after
   "name is", "named", "called", "goes by", "I am" or "I'm" (up to three capitalised words, the
   whole name and each word), replaced as whole words in any case.
3. Secrets are hidden by `spade_core::redact`: values under names that hold secrets, and strings
   shaped like keys or tokens (the market's patterns).

The run in the conversation stays as it was.

## Storage and moves

Cases live in the `cases` table of Spade's database (`id`, `agent_id`, `reply`, `mark`, `body`,
`made_ms`), deleted with their bot. They are one of the tables a move copies (ADR 0187): they
arrive with the bot, are checked to be its own, and leave the machine it left.

## API

- `POST /v1/agents/{id}/cases/preview {reply, mark?, why?, hide?}`: `{case}`, what keeping would
  write, already redacted. Nothing is stored.
- `POST /v1/agents/{id}/cases {reply, mark?, why?, hide?}`: keeps it; `201 {summary, case}`, or
  `200` with the case that reply already has. `404` for a reply that isn't there, `409` for one
  that didn't finish, `400` for a mark other than `right` or `wrong`.
- `GET /v1/agents/{id}/cases`: `{cases}`, each a summary `{id, reply, mark, why, trigger, given,
outcome, made_at}` with `given` and `outcome` on one line, newest first (at most 200).
- `GET /v1/agents/{id}/cases/{case}`: `{summary, case}`.
- `DELETE /v1/agents/{id}/cases/{case}`: `204`.

## Replays

A kept case runs again on a package version (`spade_core::quality::replay`, run by
`spade_server::replay`), each on its own throwaway Spade: a temporary folder, the real engine and
install path, the version installed as a local package with its switches on, no keychain, ace,
app or plugin.

- **Free (wiring) replay.** The case becomes a scenario: its recorded steps are the scripted
  model's, on `spade-testkit`'s fake endpoint on this machine. It spends nothing.
- **Model replay, opt-in.** The case's given runs on a model the person names (`current`, a
  role such as `review`, or `endpoint/model`), through their own endpoints, at their cost. Spade's
  own tools work on a copy of the bot's workspace (at most 5,000 files and 200 MB), never the
  workspace itself. A case the person marked is then compared with its kept run by one call of
  ADR 0159's verifier (the bot's `verify` role), quoting both outcomes as data: a run marked right
  holds when the new outcome agrees or does better, one marked wrong when it doesn't repeat the
  mistake. Its cost counts in the bot's caps.
- **The recording is the tool layer.** Every tool that would reach outside (the scenario runner's
  list, and any name that isn't Spade's own) answers from the case's `tool_results`: a call with
  the same tool and arguments gets the answer the kept run got, each once and in order (the last
  again when asked more often); any other answers "Not in the recording" and is counted. A call
  the gate refused in the kept run has no answer. Nothing reaches a network but the model's own
  endpoint.

A replay is judged without a model where none is needed:

| Judged on                                                                              | Wiring | Model               |
| -------------------------------------------------------------------------------------- | ------ | ------------------- |
| The run finished with a reply, its cards fit                                           | yes    | yes                 |
| No call the kept run made was refused (a dropped effect)                               | yes    | yes                 |
| No new call was refused (an effect outside the ceiling)                                |        | yes                 |
| A contract call that returned still returns (a changed output fails `contract_return`) | yes    | yes                 |
| Every call the kept run made ran, and each effect it asked for was asked for           | yes    |                     |
| No call left the recording                                                             | yes    | counted, not failed |
| The verifier's comparison with a marked run                                            |        | yes                 |

A case whose routine or contract the version no longer has fails without running. The summary is
one sentence: "All 20 kept runs replay the same.", "18 of 20 kept runs replay the same. 2 don't:
see why.", or for a model replay "18 of 20 kept runs the same or better. 2 worse: see why. 3
calls were outside the recording."

### Where it runs

- **Every update review.** The daemon asks for the free replay of the bot's latest 20 kept runs on
  the version the review would move it to, and the review says the summary with See why
  (`update.replay`); a replay that fails or takes more than 20 s leaves the review without it. A
  template bot's update dialog runs it as it opens and offers "Try it on your last 20 kept runs:
  about $0.12 on GPT-6.1 mini." with Try it, which runs the model replay on the bot's own model.
- **`ace bot test --cases BOT [PATH]`** replays the bot's kept runs on the folder's version, or the
  one the bot runs; `--model ROLE` replays them on a model, after saying what that costs and
  getting a yes (or `--yes`).

### API

- `POST /v1/agents/{id}/cases/replay {cases?, recipe?, files?, pages?, model?}`: `{replay: {mode,
model?, cases: [{id, given, mark?, passed, lines, outside}], passed, failed, outside, summary}}`.
  `cases` names case ids (the latest 20 when absent); `recipe` (with its contract schema `files`
  and panel `pages`) is the version, the bot's own when absent, written back from its manifest
  (`spade_core::package::written`, which reads as the same manifest). `400` for a version or
  model that doesn't read, `409` for a bot from no package with no version given.
- `GET /v1/agents/{id}/cases/replay?model=ROLE`: `{estimate: {model, model_name, cases,
cost_micros, priced}}`, about what a model replay of the latest 20 costs: each recorded step
  reads everything before it and writes its own words and calls, at four characters a token.

## Checks

A package's `checks` ([packages.md](packages.md)) are what Spade holds a result to before it
counts as done, in the package's own words; they only add conditions.

- **`schema`** on `contract:<name>`: the output of `contract_return` is held to the rule after the
  contract's own schema, with the same tries: a miss goes back to the callee with the reasons
  ("The output doesn't pass the package's checks; fix it and return again (2 more tries)"), and
  the third fails the call.
- **`schema`** on `card:<id>`: `card_show {surface: "<id>", data}` names one of the package's
  cards, and its data is held to the rule before it is shown. A miss goes back to the bot; the
  third in a reply leaves the card unshown for the rest of that reply.
- **`criterion`** on `goal`: its line joins the criteria of the goal the bot drafts with
  `task_goal` (after the bot's own), so a `done` without it reads `not_yet`.
- **`code`**: refused until Spade runs package code (ADR 0203).

A schedule, event or webhook trigger with `"verify": true` opens a goal for each run, right after
the run's message: the routine's name and instruction, the package's `criterion` checks as its
criteria (or, with none, that the instruction was carried out), and the run's id (`goal_set.run`).
The message tells the bot what done means. The run reads `checking` when its reply ends,
`verified` on a `done` verdict, and `failed` (with what was missing) once the check said `not_yet`
three times: the goal ends as failed and nothing carries the run on. It never reads done
unchecked. A goal already open when the routine fires stays the goal; the run opens none.
