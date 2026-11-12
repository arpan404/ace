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
`{provider, name, accounts: [{id, label}], models: [{id, name}]}`, as ace lists them: providers
whose CLI is installed and turned on and that have a read-only mode, with every account not known
to be signed out. While ace is away it answers `{"providers": [], "error": "<one line>"}`.

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
