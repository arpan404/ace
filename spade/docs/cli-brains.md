# Subscriptions through your CLIs

Date: 2026-11-12. Status: built. Decision: [ADR 0133](../../docs/adr/0133-spade-cli-brains.md).

A bot can think with one of the person's subscriptions (Codex, Claude Code, OpenCode, Cursor,
Antigravity, Pi, an ACP agent) instead of an endpoint. Spade never reads a CLI's login: the ace
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
`{provider, name, accounts: [{id, label}], models: [{id, name}]}`, as ace lists them: providers
whose CLI is installed and turned on, with every account not known to be signed out. While ace is
away it answers `{"providers": [], "error": "<one line>"}`.

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
  A new provider or account starts a new thread; a new model switches the same thread. The thread
  runs read-only in Spade's workspace folder and no client can send to it.
- **What is sent.** The message is everything since the last step's `seen` that the person,
  another bot, a routine or a finished job sent, framed as for an endpoint model (`<context>`,
  `<bot_message>`, `<job_result>`); an answer to `ask_user` is left out (the CLI got it as the
  call's result). Images are described, not shown. The daemon puts the instructions before the
  message on a session's first turn and whenever `instructionsChanged` is true (they differ from
  the ones the last turn was built from: a new task, a new notes index).
- **The answer** is JSON lines, ended by `finished` or `failed`:

  | Line                                         | Meaning                                                             |
  | -------------------------------------------- | ------------------------------------------------------------------- |
  | `{"type":"session","thread","fresh"}`        | The bot's hidden thread; `fresh` when this turn started it          |
  | `{"type":"text","text"}`                     | Reply text, streamed into the reply like a model's                  |
  | `{"type":"status","status"}`                 | A few words for the bot's status line; `null` is "Thinking"         |
  | `{"type":"read","source"}`                   | The CLI read outside text with its own tools ("the web"), once each |
  | `{"type":"finished","usage":{input,output}}` | The turn ended; counts are stored on the step with no cost          |
  | `{"type":"failed","reason","message"}`       | One line to show; `reason` as below                                 |

  Unknown line types are skipped.

- **Stop, pause and restart.** Spade closing the request interrupts the CLI's turn: Stop closes
  the reply as stopped; a pause for an update or a stop of Spade sends the same turn again when it
  resumes; a turn cut off by a crash closes as interrupted. Messages that arrive while the CLI
  works are answered in a following turn of the same reply.
- **Not Spade's money.** CLI turns cost nothing in Spade's ledger: the daily cap, the per-turn
  cost limit and the step limit never stop them, and messages to a CLI bot are taken while the cap
  is used up. Compaction never runs for them. Usage shows in ace's usage display under the
  provider and account.

## The bot's tools

In a bot's session, ace's MCP endpoint offers two tools no other session gets:

- `spade_tools {query?}`: the bot's offered tools with their schemas (`tool_search` and
  `call_tool` reach the rest, connectors included), or the matches for `query`.
- `spade_call {tool, arguments}`: runs one.

The daemon forwards both with Spade's token to the bot's MCP server in Spade,
`POST /v1/agents/{id}/mcp`, which answers JSON-RPC `initialize`, `tools/list` (`params.query`
optional) and `tools/call` (`params.name`, `params.arguments`), one JSON answer each.

A call is stored as a step of the open reply (with the text the CLI wrote before it) and goes
through the same gate as an endpoint model's call: reads run, notes run unless the turn is
untrusted, writes ask unless allowed always, destructive calls always ask, and a turn that read
untrusted output asks for every write. A `read` line counts as untrusted output. The call waits
for the person's answer; the CLI gets the stored result (for `ask_user`, the person's answer).
Calls run one at a time. A call made while the bot has no CLI turn running answers "Not run".
ace's own tools are the session's own, under the host thread's lease rules (no `ask`).

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
