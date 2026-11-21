# Quality: cases from real work

A bot's quality is judged on the person's own work ([ADR 0204](../../docs/adr/0204-spade-measures-agent-quality-on-real-work.md)).
This page covers the first part: **cases**. Replays, checks and listing evidence come later.

## A case

The person keeps one finished reply as a test, from the reply's More menu ("Keep as a test").
Nothing is kept by itself. A stopped, failed, interrupted or still-open reply can't be kept.

`spade_core::quality::case` reads the run out of the conversation's events:

| Field          | What it holds                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| `id`, `bot`    | The case's id and its bot                                                                                     |
| `reply`        | The reply it was kept from; a reply is kept once                                                              |
| `package`      | `{name, version, hash}` of the package the bot ran, for a packaged bot                                       |
| `trigger`      | `{kind, name?}`: `message`, `bot`, `routine`, `group`, `thread` or `contract`                                 |
| `given`        | `{messages, input?}`: the message it answered, any steered in while it ran, and a contract call's input       |
| `steps`        | Each model step's words and calls (`{id, tool, arguments}`); the model's thoughts are not kept               |
| `tool_results` | Every outside answer in the order the run got it: `{call, tool, arguments, content, is_error}`               |
| `outcome`      | `{text, cards, contract?, effects, verdict?}`: the reply, its cards, a contract's ending, effects, ADR 0159's verdict |
| `mark`, `why`  | `right` or `wrong`, and one line of why (at most 280 characters)                                              |
| `made_at`      | When it was kept                                                                                              |

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
