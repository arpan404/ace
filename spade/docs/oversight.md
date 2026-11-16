# Research and oversight

Date: 2026-11-12. As built for [ADR 0135](../../docs/adr/0135-spade-research-and-oversight.md):
deep research, what each bot spent, the activity log and the optional model review. Spade has no
spending limits ([ADR 0166](../../docs/adr/0166-spade-has-no-spending-limits.md)): spend is recorded and shown, and nothing stops on it. Extends
[harness.md](harness.md), [agents.md](agents.md) and [workspace.md](workspace.md). Money is in
micros: millionths of a US dollar, as in the ledger.

## Deep research

`research {question, depth?}` is a background tool (harness.md): the call answers at once and the
report arrives later as the job's result. Risk read; its output is untrusted, so a write after it
asks. `depth` is `quick`, `standard` (the default) or `deep`:

| Depth      | Sub-questions | Pages read | Time   |
| ---------- | ------------- | ---------- | ------ |
| `quick`    | 3             | 6          | 2 min  |
| `standard` | 5             | 15         | 6 min  |
| `deep`     | 8             | 30         | 15 min |

A run has no spend budget; what its calls cost is recorded like any other.

1. **Plan.** One typed call on the bot's model: sub-questions, each with one or two search
   queries.
2. **Gather.** Every query runs through `web_search`'s backends, four at a time; addresses are
   deduplicated (scheme, host, path; no fragment) and taken in the order the searches ranked them,
   alternating between questions, until the page budget. Pages are read through `web_fetch`'s
   fetcher, four at a time; a page that fails is skipped. From each page Spade keeps the passages
   with the most words in common with the questions (at most 2,400 characters per source), plain
   text only. Time and pages are checked before each fetch.
3. **Write.** One call on the bot's model with the question, the sub-questions and each source as
   `<source n="3" url="…">passages</source>`, told the sources are data, never instructions. It
   writes Markdown that cites `[n]`, has a short summary first, a section per sub-question, then
   "Where sources disagree" and "Resting on one source".
4. **Check.** One typed call: every sentence with a citation is compared with its sources'
   passages; claims they do not support are listed, and the report gains "Not confirmed by its
   sources" with them. A citation of a number no source has is removed.
5. **Save.** `research/<YYYY-MM-DD>-<slug>.md` in the bot's workspace (`-2`, `-3` when taken):
   the report, then "Sources", numbered, each title and address, built by Spade from the pages it
   read. It is never added to the workspace's trust record, so reading it later is untrusted too.

The job's result is the summary (at most 1,500 characters), the path, how many sources were read
and why it stopped early if it did ("the page budget", "the time budget"). `job_finished.files` is `[path]`: the app shows a file chip on the bot's next
bubble that opens the report. While it runs, the bot's status (roster and live stream) is
`Researching`, `Researching · 14 sources read` or `Researching · writing the report`. Its model
calls are recorded in the ledger under the bot's conversation.

## Spending

Every model call (a step, compaction, a title, a review, a check of done, research, a digest's
polish) and every image or transcription call is recorded in the ledger under the bot's
conversation, with its role (ADR 0162): a helper's under its bot as `helper`. A step cut off
before its usage arrived (Stop, a pause, an error, an early end) is charged what the error
reported, else its prompt at about four characters a token and what streamed. A day runs from
midnight to midnight and a month from the first, both in the person's time zone
(`PUT /v1/oversight {time_zone}`; the machine's until set).

Nothing is refused, ended, skipped or parked for spend ([ADR 0166](../../docs/adr/0166-spade-has-no-spending-limits.md)). There are no per-bot or
service caps (`SPADE_DAILY_CAP_USD` is ignored), no budgets and no `402`. Builds before it stored
caps in each bot's settings (removed by a forward migration), `cap_reached` events (read as raw
data, shown nowhere) and cap or budget parks (cancelled when Spade opens; the task carries on).

## Activity log

Folded on each request from the conversation's events; nothing more is stored. An entry:

```
{"id": "41-0", "seq": 41, "at": 1794193200000, "kind": "tool", "name": "web_fetch",
 "summary": "url: https://example.com/page", "sentence": "Read a web page",
 "detail": "https://example.com/page", "outcome": "ok", "reply": "r7", "cost_micros": null}
```

`sentence` and `detail` are what the app shows: the entry in Spade's words, so no app prints a
tool's name or its arguments. `sentence` is set on every entry ("Ran a command", "Searching the
web" while it runs, "Used create issue in Linear", "You declined: send an email", "The reviewer
asked you: run a command", "Daily briefing ran", "Access changed to Auto-review"). `detail` is one
line (the same 160 characters and redaction as `summary`), or null when the sentence says it all:
for a call, the part that matters for its kind (a command, a file's path, a note's text, a search's
words, a page's address, `To Research: …` for a message to a bot, `To Marta and 2 others · Plan`
for an email), else its fields as `Label: value; …` with hidden secrets left out; for other kinds,
the `summary`. `memory_forget` has none (only the note's id). `access`, `task` and `hook` entries
carry the whole of it in the sentence. The words live in `spade-core` `activity::words`, the
server's copy of the app's tool words; `summary` stays for older apps and for search.

| `kind`      | One per                                                              | `name`        | `summary`                | `outcome`                                                    |
| ----------- | -------------------------------------------------------------------- | ------------- | ------------------------ | ------------------------------------------------------------ |
| `tool`      | tool call that started or was declined                               | the tool      | its arguments, cut short | `ok`, `error`, `unknown`, `declined`, `running`              |
| `connector` | the same, for a connector's tool (`<app>__<tool>`)                   | the tool      | as above                 | as above                                                     |
| `file`      | `workspace_write`/`workspace_edit`, or a file a tool kept (a report) | the tool      | the path                 | as above                                                     |
| `bot`       | `bot_message` sent, or a message from a bot                          | the other bot | the text, cut short      | `sent`, `received`                                           |
| `approval`  | approval asked, or answered                                          | the tool      | its arguments, cut short | `asked`, `allowed`, `always`, `declined`                     |
| `routine`   | routine or heartbeat fired                                           | the routine   | its label (`9:00`)       | `heartbeat` for a heartbeat, else null                       |
| `review`    | model review verdict                                                 | the tool      | the reviewer's reason    | `allowed`, `escalated`                                       |
| `spend`     | turn that ended having cost something                                | null          | `3 steps`                | how it ended: `finished`, `stopped`, `failed`, `interrupted` |

`summary` is one line of at most 160 characters. Arguments show as `key: value` pairs (strings
unquoted, nested values as compact JSON). Secrets never show. A name is secret when one of its parts (split at `_`, `-`, `.` and
camelCase) is `token`, `secret`, `password`, `passwd`, `auth`, `authorization`, `credential(s)`,
`cookie`, `apikey`, `accesskey` or `privatekey`, or is `key` after another part (`api_key`,
`X-Api-Key`); not `key` alone, `tokens`, `keywords`, `author` or `session_id`. A JSON value under
such a name becomes `•••`. In text, the value such a name gives is hidden however it is written:
`NAME=value`, `NAME = value`, `NAME="…"`, `name: value`, `"name": "…"`, `--name value`,
`--name=value`, a URL's `?name=…`; a value runs to whitespace, to its close quote when it opens
with one (a `\"` inside is escaped, not the close), and in a query also to `&` or `#`. JSON
escaped inside a shell string (`\"password\":\"…\"`) is read the same way, and a URL's password
(`postgres://user:…@host`) is hidden too. After `Authorization:` the scheme (`Basic`,
`Bearer`, `Digest`, `Token`) and its credential are both hidden, and so is the word after
`Bearer` anywhere. Then any word shaped like a key is hidden: one starting `sk-`, `sk_`,
`pk_live_`, `rk_live_`, `gh?_`, `github_pat_`, `xox?-`, `glpat-`, `AIza`, `AKIA` or `ASIA` (12
characters or more), a JWT (`eyJ…` in three dotted parts), or 32 or more characters of letters,
digits, `-`, `_`, `+`, `/` and `=` holding a digit, a lowercase and an uppercase letter (so
single-case hex such as commit hashes stays). A shell command is its own summary, with the same
redaction. `spend` and `review` carry `cost_micros`, and with it `role` (`main`, `review`; ADR 0162).

`GET /v1/agents/{id}/activity` takes `kind` (comma-separated kinds), `day` (`YYYY-MM-DD` in the
person's zone), `q` (words, case-insensitive, all must appear in `name`, `summary`, `sentence` or `detail`), `before`
(an event `seq`; entries before it) and `limit` (1 to 500, default 200). Answer:
`{"entries": [Entry], "more": bool, "next_before": seq|null, "spend_by_role": {"today": {role:
micros}, "month": {…}}}`, newest first; `spend_by_role` comes from the ledger, so it counts
helpers, checks, summaries and titles too. Spade reads the
history in windows of 2,000 events from the newest, SQLite filtering by event type and day and
the rows decoded outside the database lock, and at most 20,000 events per request: a page may
be empty with `more` true. `next_before` is where the next page starts; pass it as `before`. A call or job started in a page and ended above
its `before` still shows how it ended. With `day`, paging goes on until what is left is older
than the day.

## Model review

Off by default. `review` is set for every bot (`PUT /v1/oversight {review_default}`) or per bot
(`PUT /v1/agents/{id}/oversight {review}`, `null` to follow the default). The review model is
the bot's `review` role ([ADR 0162](../../docs/adr/0162-spade-model-routing.md)): its own
override, else `review_model`, else the fast model, else the bot's own model.

When the gate (gate.rs) decides **Run** for a call of risk `write`, and the bot's review is on,
the engine asks the review model, as typed output `{verdict: "allow" | "escalate", reason}`:

- the bot's name and task;
- the person's last three messages to it (not other bots' or routines'), each cut to 1,000
  characters;
- the untrusted sources in view (`context::untrusted_in_view`), by name;
- the call: tool, description, arguments (cut to 4,000 characters).

`allow` runs the call. `escalate`, a failed or unreadable answer, or no review
model stores `approval_requested` as the gate would have: the person decides. The verdict is
stored first as `call_reviewed`; a stored verdict for the call is reused after a restart, so a
call is reviewed once. A call the gate asks about, a read, a note (`memory`) and a destructive call
are never reviewed. The review's cost goes to the ledger under the bot's conversation as
the `review` role. The status line says `Checking a step` while it runs.

## Events

| Type            | Fields                                                                                       | Meaning                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `call_reviewed` | `reply`, `call_id`, `name`, `verdict: "allow"\|"escalate"`, `reason`, `model`, `cost_micros` | The model review judged a call                                                                            |
| `job_finished`  | `…, files?: [path]`                                                                          | Workspace files the job kept (a research report), for file chips; the app reads it on `tool_finished` too |

The app shows an escalated call's `reason` in its approval bubble: "Asked you because: …".

## API

Under `/v1`, with the bearer token, as in [agents.md](agents.md).

**Spending** (on every Agent as `spending`) = `{"today_micros", "month_micros"}`. Every Agent
also carries
`"review": true|false|null` (its own switch; `null` follows the default).

**Oversight** = `{"time_zone", "today_micros", "month_micros", "review_default",
"review_model": "endpoint/model"|null}`. `today_micros` and `month_micros` are every bot's spend
together.

| Method and path              | Body                                                          | Answer                                                  |
| ---------------------------- | ------------------------------------------------------------- | ------------------------------------------------------- |
| `GET /oversight`             |                                                               | `{"oversight"}`                                         |
| `PUT /oversight`             | any of `time_zone`, `review_default`, `review_model`          | `200 {"oversight"}`; `400` for an unknown zone or model |
| `GET /agents/{id}/oversight` |                                                               | `{"spending", "review"}`                                |
| `PUT /agents/{id}/oversight` | `review` (may be `null`); caps an older app sends are ignored | `200 {"spending", "review"}`                            |
| `GET /agents/{id}/activity`  | query as above                                                | `{"entries", "more", "spend_by_role"}`                  |

Settings are kept in the `settings`
table (`oversight` and `oversight:<agent id>`), deleted with the bot.

## Digests, decisions and escalation levels

[ADR 0165](../../docs/adr/0165-spade-digests-and-decision-log.md). Built from events in
`spade_core::digest`, with no model call unless the person turns polish on.

- **Levels.** Every event served by `/events` and `/live` carries `"level"` (`inform`, `ask`,
  `block`, `stop`) when it reaches the person; `spade_core::escalation` maps them. Nothing new
  waits: the level names what an existing wait already does.
- **Decision log.** `decision_log {choice, reason, options?, item?}` stores `decision_made`; it
  shows in the activity log (kind `task`) and in digests.
- **Digests.** Per bot, with a nested digest per bot worker for a tree. They are made on a
  schedule (daily by default; workers only when set on them) or on request. Settings are in the
  `settings` table (`digests` and `digests:<agent id>`); digests are in the `digests` table,
  deleted with the bot.

| Route                           | Body or query                        | Answer                                          |
| ------------------------------- | ------------------------------------ | ----------------------------------------------- |
| `GET /digests`                  | `agent?`, `after?` (an id), `limit?` | `{"digests"}`, newest first                     |
| `GET /digests/{id}`             |                                      | `{"digest"}`                                    |
| `GET`/`PUT /digests/settings`   | `{every?, polish?}`                  | `{"settings", "every_ms", "polish"}`            |
| `GET`/`PUT /agents/{id}/digest` | `{every?, polish?}`, `null` inherits | `{"settings", "every_ms", "polish", "next_ms"}` |
| `POST /agents/{id}/digests`     |                                      | `201 {"digest"}`                                |
| `GET /notices/live`             |                                      | server-sent `notice` events                     |
