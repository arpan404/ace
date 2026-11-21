# Subscriptions through your CLIs

Date: 2026-11-12. Status: built. Decision: [ADR 0133](../../docs/adr/0133-spade-cli-brains.md).

A bot can think with one of the person's subscriptions (Codex, Claude Code, OpenCode, Pi)
instead of an endpoint. A bot's session runs read-only, so only providers with a read-only mode
can carry one: Cursor and Antigravity have none, and ACP agents have none ace has verified. Spade never reads a CLI's login: the ace
daemon runs the turn in the person's own installed, signed-in CLI, as it runs any provider
session (ADR 0002).

## The model

A bot's model is `cli:<provider>/<model>` or `cli:<provider>@<account>/<model>`:

- `provider` is one of ace's provider ids: `claude`, `codex`, `opencode`, `cursor`,
  `antigravity`, `acp`, `pi`.
- `account` is ace's account id (no `/`, `@` or spaces). Without it the provider's default
  account runs the turn.
- `model` is the model id as ace lists it.

`POST /v1/agents` and `PATCH /v1/agents/{id}` take it like `endpoint/model`. Spade checks only its
shape; whether the CLI is there is ace's to say when a turn runs.

## Listing

`GET /v1/subscriptions` answers `{"providers": [...], "error": null}`, each provider
`{provider, name, accounts: [{id, label}], models: [{id, name}], terms}`, as ace lists them:
providers whose CLI is installed and turned on and that have a read-only mode, with every account
not known to be signed out. While ace is away it answers `{"providers": [], "error": "<one line>"}`.

## Terms (ADR 0205)

A subscription is only ever the person's informed choice for one bot: never the first usable
model, a template's, a recipe's, the fast model, the model for new bots or part of a route
(`PUT /v1/settings` refuses one for `fast_model` and `new_bot_model`; one stored by an older
build is passed over).

- **The record.** `spade/config/cli-terms.json`, shipped with each build:
  `{version, providers: [{provider, name, status, checked, source, note}]}`. `status` is
  `allowed`, `unclear` or `refused`; a record with `allowed` or `refused` must name the terms it
  was read from (`source`) and when (`checked`), or the file doesn't load. Every provider reads
  `unclear` until its record is written from the vendor's own terms. A provider with no record
  reads `unclear`.
- **`terms` in the listing:** `{status, checked, source, note, version, acknowledgement,
acknowledged}`. `acknowledgement` is what the person reads: "This bot will run in your <name>
  CLI on your subscription. Its maker's terms apply to how you use it. If they change, Spade may
  stop offering it.", plus "Its terms don't say whether this is allowed." while `unclear`.
- **Acknowledging.** `PUT /v1/subscriptions/{provider}/terms {"use": true}` stores
  `cli_terms_ack:<provider>` with the date, the record's version and the status acknowledged; it
  holds until that provider's status changes. `POST /v1/agents` and `PATCH /v1/agents/{id}` with
  a `cli:` model of a provider not acknowledged answer `409 {"error", "terms": {provider,
acknowledgement}}`.
- **Signed notices.** A change between builds reaches Spade as the market's signed notices
  (`GET /v1/notices` on the market, `{format: "ace-market-notices", issued, notices: [{provider,
status, note, at}], key}`, signed by the signer behind `ace-market-notices-v1`). The daemon reads
  them with the marketplace's daily refresh (and every manual one), verifies them with the keys
  its build ships and hands them over as signed: `PUT /v1/subscriptions/notices {"signed"}`.
  Spade checks the signature again with its own market keys (`400`, nothing changed, for one no
  trusted key signed), keeps the list only when its `issued` is newer than the one it has
  (`{"applied": false}` otherwise), stores it as `terms_notices`, and applies it at every start.
  Each notice only ever makes a provider's status stricter than the shipped record: `allowed`,
  then `unclear`, then `refused`; a looser one is ignored, since loosening needs a build. A record
  a notice tightened carries `noticed_ms` and the notice's `note`. A notice never changes a bot's
  model: a bot on a provider it refuses waits, as below. The daemon reads notices only while
  Settings › Beta has the marketplace on.
- **Refused.** A `refused` provider is offered to no new bot (`400`, and its acknowledgement is
  refused). A bot already on it waits: messages are stored and no turn starts, as for a paused
  bot; a reply left open on it ends with the refusal. Its roster row carries `terms_hold:
{provider, name, text, choices}`, `text` being "<name>'s terms no longer allow this. Pick another
  model for this bot." and `choices` the person's own endpoint models (the bot's `main` route,
  else the global one, then the first usable model), and `problem` says the same. Nothing changes
  the bot's model for the person; once they pick one, what waited is answered on it.

## A turn

Each turn of a CLI bot is one request to the daemon, `POST <daemon>/spade/brains/turn` with
Spade's grant as the bearer:

```json
{
  "bot": "<agent id>",
  "provider": "codex",
  "account": "work",
  "model": "gpt-6.1-sol",
  "instructions": "<Spade's rules, how to reach the bot's tools, the task, skill and notes indexes>",
  "instructionsChanged": false,
  "message": "<what arrived since the session's last turn>"
}
```

- **One session per bot.** The daemon keeps one hidden thread per bot (`host: "spade-bot"`) in
  Spade's project and resumes its provider session every turn, so the CLI keeps its own context.
  A new provider or account starts a new thread (a turn naming no account uses the account ace
  launches on now, and reuses the session only if it is that one); a new model switches the same
  thread. The thread runs read-only in Spade's workspace folder. Spade owns its lifecycle: the
  socket refuses every client command naming it, no caller (its own agent included) can change
  its access or mode, and ace's recovery never holds, resumes, replays or moves it to another
  account (after a daemon restart its pending turn is dropped; Spade sends the next one).
- **What is sent.** The message is everything since the last step's `seen` that the person,
  another bot, a routine or a finished job sent, framed as for an endpoint model (`<context>`,
  `<bot_message>`, `<job_result>`); an answer to `ask_user` is left out (the CLI got it as the
  call's result). If the session's last turn stopped after a call instead of finishing (Spade
  paused or restarted mid-turn), the turn resumes with a note saying it was cut off and that the
  call may or may not have taken effect; such a turn is never recorded as done with nothing in it.
  Images are described, not shown. The daemon puts the instructions before the
  message on a session's first turn and whenever `instructionsChanged` is true (they differ from
  the ones the last turn was built from: a new task, a new notes index).
- **The answer** is JSON lines, ended by `finished` or `failed`:

  | Line                                         | Meaning                                                                             |
  | -------------------------------------------- | ----------------------------------------------------------------------------------- |
  | `{"type":"session","thread","fresh"}`        | The bot's hidden thread; `fresh` when this turn started it                          |
  | `{"type":"text","text"}`                     | Reply text, streamed into the reply like a model's                                  |
  | `{"type":"status","status"}`                 | A few words for the bot's status line; `null` is "Thinking"                         |
  | `{"type":"read","source"}`                   | A tool of the session's (any agent's) may have let outside text in, once per source |
  | `{"type":"finished","usage":{input,output}}` | The turn ended; counts are stored on the step with no cost                          |
  | `{"type":"failed","reason","message"}`       | One line to show; `reason` as below                                                 |

  Unknown line types are skipped.

- **Taint fails closed.** Every native tool call in the session counts as outside text unless it
  is known to return none: the agent's to-do list or plan, ace's tools that return only ace's
  state (`machines`, `models`, `projects_find`, `automations_list`) and the bridge below. File
  reads, searches, shell output and custom tools all taint the turn.
- **A native permission prompt** (which nobody would see) interrupts the whole session tree, then
  the turn fails with `needs_permission`.
- **Stop, pause and restart.** Spade closing the request interrupts the CLI's turn: Stop closes
  the reply as stopped; a pause for an update or a stop of Spade sends the same turn again when it
  resumes; a turn cut off by a crash closes as interrupted. Messages that arrive while the CLI
  works are answered in a following turn of the same reply.
- **Not Spade's money.** CLI turns cost nothing in Spade's ledger. Compaction never runs for
  them. Usage shows in ace's usage display under the
  provider and account.

## The bot's tools

In a bot's session, ace's MCP endpoint offers two tools no other session gets:

- `spade_tools {query?}`: the bot's offered tools with their schemas (`tool_search` and
  `call_tool` reach the rest, connectors included), or the matches for `query`.
- `spade_call {tool, arguments}`: runs one.

The daemon forwards both with Spade's token to the bot's MCP server in Spade,
`POST /v1/agents/{id}/mcp`, which answers JSON-RPC `initialize`, `tools/list` (`params.query`
optional) and `tools/call` (`params.name`, `params.arguments`), one JSON answer each. ace stamps
each `tools/call` with `params._meta["dev.acehq.spade/seq"]`: how many lines of the running turn's
answer precede the call (ace first commits and turns into lines everything the session reported).
Spade admits the call only once it has applied that many lines, so a `read` the CLI made just
before the call taints it even when the call arrives first. A call without the stamp answers "Not
run".

How each adapter runs the bridge in read-only (the daemon marks the session as a bot's and names
the ace tools it may run unasked: the allow-list below):

| Provider | Read-only is                         | The bridge                                                                                                                                |
| -------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Codex    | read-only sandbox, approvals `never` | the allow-listed tools are all ace offers it, and Codex runs them unasked                                                                 |
| Claude   | plan mode                            | the adapter answers Claude's permission check for them itself; `ExitPlanMode` is refused with a note, and its plan text becomes the reply |
| OpenCode | the plan agent                       | allow rules for `ace_<tool>` on the session                                                                                               |
| Pi       | a read-only tool list                | the bridge is kept in the list                                                                                                            |

A call is stored as a step of the open reply (with the text the CLI wrote before it) and goes
through the same gate as an endpoint model's call: reads run, notes run unless the turn is
untrusted, writes ask unless allowed always, destructive calls always ask, and a turn that read
untrusted output asks for every write. A `read` line counts as untrusted output. The call waits
for the person's answer; the CLI gets the stored result (for `ask_user`, the person's answer).
Calls run one at a time. A call made while the bot has no CLI turn running answers "Not run".
Of ace's own tools the session is offered an allow-list and nothing else, whether listed, found
with `tools_find` or called through `tools_call`: the bridge, ace's reads that return only ace's
own state (`machines`, `models`, `projects_find`, `automations_list`, `guide`), and `tools_find`
and `tools_call`. `ask` is withheld as for every host thread (`askAvailable: false`). The turn is reported finished only once nothing else in the session runs (no
agent, background task or queued work); after two minutes the session is stopped and the turn
fails with one line; the two minutes start when the root's run ends. Reply text comes only from
this turn's runs.

## Failures

`reason` is `not_installed`, `signed_out`, `rate_limited`, `quota`, `needs_permission` (the CLI
asked for a permission ace can't show, since the session is hidden), `unavailable` (turned off,
or the account or model isn't available) or `failed`. The reply closes as failed with the line;
the bot's `problem` (in `GET /v1/agents`) carries it until a later reply finishes, and the
roster row shows it. Nothing retries the turn and the daemon never moves the bot to another
account. With ace away the turn fails with "ace isn't reachable…".

## Known limits

- The CLI's own tools (web search, reading files in Spade's workspace) are not gated by Spade;
  read-only access keeps them from changing anything, and their reads taint the turn.
- Calls from the CLI to the bot's tools run one at a time, and a call waits at most as long as
  ace lets a tool call run (11 minutes); a later answer stays in the conversation.
- A bot moved from an endpoint to a subscription starts its session with its notes and task, not
  its old transcript.
