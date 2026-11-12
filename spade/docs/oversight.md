# Research and oversight

Date: 2026-11-12. As built for [ADR 0135](../../docs/adr/0135-spade-research-and-oversight.md):
deep research, per-bot spending caps, the activity log and the optional model review. Extends
[harness.md](harness.md), [agents.md](agents.md) and [workspace.md](workspace.md). Money is in
micros: millionths of a US dollar, as in the ledger.

## Deep research

`research {question, depth?}` is a background tool (harness.md): the call answers at once and the
report arrives later as the job's result. Risk read; its output is untrusted, so a write after it
asks. `depth` is `quick`, `standard` (the default) or `deep`:

| Depth      | Sub-questions | Pages read | Time   | Spend |
| ---------- | ------------- | ---------- | ------ | ----- |
| `quick`    | 3             | 6          | 2 min  | $0.10 |
| `standard` | 5             | 15         | 6 min  | $0.40 |
| `deep`     | 8             | 30         | 15 min | $1.50 |

Each run also stops at the bot's caps and the service's daily cap, checked before each model call.

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
and why it stopped early if it did ("the page budget", "the time budget", "the spend budget", "the
bot's daily cap"). `job_finished.files` is `[path]`: the app shows a file chip on the bot's next
bubble that opens the report. While it runs, the bot's status (roster and live stream) is
`Researching`, `Researching · 14 sources read` or `Researching · writing the report`. Its model
calls are recorded in the ledger under the bot's conversation.

## Spending caps

Each bot may have a daily cap and a monthly cap, either or both, beside the service's daily cap
(`SPADE_DAILY_CAP_USD`). A day runs from midnight to midnight and a month from the first, both in
the person's time zone (`PUT /v1/oversight {time_zone}`; the machine's until set).

A bot is **at its cap** when its spend this day (or month) is at least that cap. Then:

- No model call starts for it: its open turn ends before its next step (`reply_finished` with no
  text), and research and reviews stop.
- `cap_reached` is stored in its conversation once per day or month the cap is first hit; the
  chat shows it as one bubble of the bot's.
- The person's messages answer `402 {"error": "Research is at its daily cap of $1.00 until
midnight."}`; `bot_message` to it answers the caller with that error; its routines and
  heartbeat are skipped with that detail.

Every model call (a step, compaction, a title, a review, research) is admitted against the caps
counting the calls still in flight at their estimated cost, and the estimate is released when its
real cost is recorded. The estimate is the prompt at about four characters a token, the part the
endpoint will read from its cache (a turn's previous prompt) at the cache-read price, and as
output the call's own limit, else the longest of the turn's last three answers, else 1,024 tokens.
Only real spend reaching a cap refuses a call (and only that stores `cap_reached` or closes a
turn). When it is the estimates of running calls that would pass a cap, the call waits until one
of them settles and looks again. A step cut off before its usage arrived (Stop, a pause, an
error, an early end) is charged what the error reported, else its prompt and what streamed. The
service's daily cap is counted in the same day as the bots' caps.

## Activity log

Folded on each request from the conversation's events; nothing more is stored. An entry:

```
{"id": "41-0", "seq": 41, "at": 1794193200000, "kind": "tool", "name": "web_fetch",
 "summary": "url: https://example.com/page", "outcome": "ok", "reply": "r7",
 "cost_micros": null}
```

| `kind`      | One per                                                              | `name`              | `summary`                | `outcome`                                                    |
| ----------- | -------------------------------------------------------------------- | ------------------- | ------------------------ | ------------------------------------------------------------ |
| `tool`      | tool call that started or was declined                               | the tool            | its arguments, cut short | `ok`, `error`, `unknown`, `declined`, `running`              |
| `connector` | the same, for a connector's tool (`<app>__<tool>`)                   | the tool            | as above                 | as above                                                     |
| `file`      | `workspace_write`/`workspace_edit`, or a file a tool kept (a report) | the tool            | the path                 | as above                                                     |
| `bot`       | `bot_message` sent, or a message from a bot                          | the other bot       | the text, cut short      | `sent`, `received`                                           |
| `approval`  | approval asked, or answered                                          | the tool            | its arguments, cut short | `asked`, `allowed`, `always`, `declined`                     |
| `routine`   | routine or heartbeat fired                                           | the routine         | its label (`9:00`)       | `heartbeat` for a heartbeat, else null                       |
| `review`    | model review verdict                                                 | the tool            | the reviewer's reason    | `allowed`, `escalated`                                       |
| `spend`     | turn that ended having cost something                                | null                | `3 steps`                | how it ended: `finished`, `stopped`, `failed`, `interrupted` |
| `cap`       | `cap_reached`                                                        | `daily` / `monthly` | the cap in words         | null                                                         |

`summary` is one line of at most 160 characters. Arguments show as `key: value` pairs (strings
unquoted, nested values as compact JSON). Secrets never show. A name is secret when one of its parts (split at `_`, `-`, `.` and
camelCase) is `token`, `secret`, `password`, `passwd`, `auth`, `authorization`, `credential(s)`,
`cookie`, `apikey`, `accesskey` or `privatekey`, or is `key` after another part (`api_key`,
`X-Api-Key`); not `key` alone, `tokens`, `keywords`, `author` or `session_id`. A JSON value under
such a name becomes `•••`. In text, the value such a name gives is hidden however it is written:
`NAME=value`, `NAME = value`, `NAME="…"`, `name: value`, `"name": "…"`, `--name value`,
`--name=value`, a URL's `?name=…`; a value runs to whitespace, to its close quote when it opens
with one, and in a query also to `&` or `#`. After `Authorization:` the scheme (`Basic`,
`Bearer`, `Digest`, `Token`) and its credential are both hidden, and so is the word after
`Bearer` anywhere. Then any word shaped like a key is hidden: one starting `sk-`, `sk_`,
`pk_live_`, `rk_live_`, `gh?_`, `github_pat_`, `xox?-`, `glpat-`, `AIza`, `AKIA` or `ASIA` (12
characters or more), a JWT (`eyJ…` in three dotted parts), or 32 or more characters of letters,
digits, `-`, `_`, `+`, `/` and `=` holding a digit, a lowercase and an uppercase letter (so
single-case hex such as commit hashes stays). A shell command is its own summary, with the same
redaction. `spend` and `review` carry `cost_micros`.

`GET /v1/agents/{id}/activity` takes `kind` (comma-separated kinds), `day` (`YYYY-MM-DD` in the
person's zone), `q` (words, case-insensitive, all must appear in `name` or `summary`), `before`
(an event `seq`; entries before it) and `limit` (1 to 500, default 200). Answer:
`{"entries": [Entry], "more": bool, "next_before": seq|null}`, newest first. Spade reads the
history in windows of 2,000 events from the newest, SQLite filtering by event type and day and
the rows decoded outside the database lock, and at most 20,000 events per request: a page may
be empty with `more` true. `next_before` is where the next page starts; pass it as `before`. A call or job started in a page and ended above
its `before` still shows how it ended. With `day`, paging goes on until what is left is older
than the day.

## Model review

Off by default. `review` is set for every bot (`PUT /v1/oversight {review_default}`) or per bot
(`PUT /v1/agents/{id}/oversight {review}`, `null` to follow the default). The review model is
`review_model`, else the fast model, else the bot's own model.

When the gate (gate.rs) decides **Run** for a call of risk `write`, and the bot's review is on,
the engine asks the review model, as typed output `{verdict: "allow" | "escalate", reason}`:

- the bot's name and task;
- the person's last three messages to it (not other bots' or routines'), each cut to 1,000
  characters;
- the untrusted sources in view (`context::untrusted_in_view`), by name;
- the call: tool, description, arguments (cut to 4,000 characters).

`allow` runs the call. `escalate`, a failed or unreadable answer, a bot at its cap, or no review
model stores `approval_requested` as the gate would have: the person decides. The verdict is
stored first as `call_reviewed`; a stored verdict for the call is reused after a restart, so a
call is reviewed once. A call the gate asks about, a read, a note (`memory`) and a destructive call
are never reviewed. The review's cost goes to the ledger under the bot's conversation and counts
toward its caps. The status line says `Checking a step` while it runs.

## Events

| Type            | Fields                                                                                       | Meaning                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `cap_reached`   | `scope: "daily"\|"monthly"`, `cap_micros`, `period_start`, `resets_at`                       | The bot reached a cap; once per period                                                                    |
| `call_reviewed` | `reply`, `call_id`, `name`, `verdict: "allow"\|"escalate"`, `reason`, `model`, `cost_micros` | The model review judged a call                                                                            |
| `job_finished`  | `…, files?: [path]`                                                                          | Workspace files the job kept (a research report), for file chips; the app reads it on `tool_finished` too |

The app shows an escalated call's `reason` in its approval bubble: "Asked you because: …".

## API

Under `/v1`, with the bearer token, as in [agents.md](agents.md).

**Spending** (on every Agent as `spending`) = `{"today_micros", "month_micros",
"daily_cap_micros": n|null, "monthly_cap_micros": n|null, "capped": null|"daily"|"monthly",
"resets_at": ms|null}`. `resets_at` is when the cap that holds it ends. Every Agent also carries
`"review": true|false|null` (its own switch; `null` follows the default).

**Oversight** = `{"time_zone", "daily_cap_micros", "today_micros", "month_micros",
"review_default", "review_model": "endpoint/model"|null}`. `daily_cap_micros` is the service's
cap (read only); `today_micros` and `month_micros` are every bot's spend together.

| Method and path              | Body                                                                           | Answer                                                  |
| ---------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `GET /oversight`             |                                                                                | `{"oversight"}`                                         |
| `PUT /oversight`             | any of `time_zone`, `review_default`, `review_model`                           | `200 {"oversight"}`; `400` for an unknown zone or model |
| `GET /agents/{id}/oversight` |                                                                                | `{"spending", "review"}`                                |
| `PUT /agents/{id}/oversight` | any of `daily_cap_micros`, `monthly_cap_micros`, `review` (each may be `null`) | `200 {"spending", "review"}`; `400` for a negative cap  |
| `GET /agents/{id}/activity`  | query as above                                                                 | `{"entries", "more"}`                                   |

A cap of 0 is allowed and means the bot makes no model calls. Settings are kept in the `settings`
table (`oversight` and `oversight:<agent id>`), deleted with the bot.
