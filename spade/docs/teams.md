# Teams: groups, bots on other machines, templates

[ADR 0132](../../docs/adr/0132-spade-teams.md) decided this. Spade's bots work together in
groups, reach bots on the person's other machines through ace, and can be made from templates,
duplicated, exported and imported. Everything is under `/v1` with the bearer token, as
[agents.md](agents.md) describes; problems are `{"error": "<one line>"}`.

## Groups

A group is a name, a lead and 2 to 8 member bots, with its own transcript. It lives on the lead's
machine; the lead is a bot of that machine. Members may be bots of any of the person's machines.

**Member** = `{"agent", "machine": "<host id>"|null, "name", "avatar"|null, "away": bool}`.
`machine` is null for a bot of this machine. `name` and `avatar` are what the bot last answered
with (kept for a bot whose machine is away). `away` is true while a member's machine can't be
reached.

**Group** = `{"id", "name", "lead": Member, "members": [Member], "conversation", "created_at",
"updated_at", "last_activity", "state", "status", "last_message"}`.

- `members` includes the lead, in the order the person chose.
- `conversation` is the group's transcript: read it with `GET /v1/conversations/{id}/events` and
  `GET /v1/conversations/{id}/live` like any conversation. Posting to it there answers `409`.
- `state`: `idle`, `working` (an ask is open) or `waiting` (a member of this machine that is
  answering waits for the person). `status`: a few words while not idle (`Research is
answering`, `Research is waiting for you`, `Waiting for Studio to come online`), else null.
- `last_message`: `{"from": "person"|"agent", "text", "at", "agent": {"id", "name",
"machine"}|null}` or null; plain text, at most 200 characters.

| Method and path              | Body                                          | Answer                                   |
| ---------------------------- | --------------------------------------------- | ---------------------------------------- |
| `GET /groups`                |                                               | `{"groups":[Group]}`, by `last_activity` |
| `POST /groups`               | `{name, members: [{agent, machine?}], lead?}` | `201 {"group"}`                          |
| `PATCH /groups/{id}`         | any of `name`, `members`, `lead`              | `200 {"group"}`                          |
| `DELETE /groups/{id}`        |                                               | `204`; its open asks are stopped         |
| `POST /groups/{id}/messages` | `{text}`                                      | `202 {"run"}`                            |
| `POST /groups/{id}/stop`     |                                               | `204`                                    |

- `name`: 1 to 60 characters, one line. `lead` is a member's `agent` id on this machine. Without
  `lead`, Spade leads (and is added as a member when it isn't one); with Spade switched off on
  this machine, the first member of this machine leads. `members` (lead counted) is 2 to 8
  distinct bots. `400` for a body that doesn't fit, `404` for a bot of this machine that doesn't
  exist, `409` when the lead isn't a bot of this machine.
- Deleting a bot removes it from every group it's in; a group left with fewer than 2 members
  stays, and posting to it answers `409` until the person adds one.

### A run

Each message from the person starts a **run**. `@Name` (a member's name, any case, longest match
first) sends the message to that member; several mentions send it to each. Without a mention it
goes to the lead.

Each recipient answers in **its own conversation**: the message is stored there as a
`user_message` with `from_group {id, name, run, ask, untrusted}` and the group's recent messages
in its context, so it answers with its own model, memory, tools and connectors. Its reply (the
first reply to finish after the message) is posted in the group. A member's own chat shows these
messages with the label `In <group>`.

`group_ask {member, text}` (a tool every bot has; it refuses outside a group turn) hands work to
another member: it is posted as a handoff line, the member answers in its own conversation, the
answer is posted as the member's message, and the tool returns it to the asker (untrusted). The
tool waits for the answer (up to 10 minutes). Only bots of the group's machine can call it.

**Budget.** A run allows at most 8 asks (the person's own included) and a chain at most 3 deep
(person to lead is 1, lead to member 2, member to member 3). Asks beyond either, asks after Stop
and asks in a group being deleted are refused with words for the bot.

**Stop** (`POST /groups/{id}/stop`) ends the run: every open ask is stopped (a bot of this
machine has its turn stopped; a bot elsewhere is sent a stop through ace), stopped answers aren't
posted, and later asks in that run are refused. A new message from the person starts a new run.

**Trust.** A message the person posts reaches the lead (or a mentioned member) as the person's
words; `from_group.untrusted` is true when the context carries other bots' messages, and then the
turn counts as untrusted (every write in it asks). An ask from another bot carries `from_agent`
as `bot_message` does, so it is untrusted.

### Group events

Stored in the group's conversation:

| Type             | Fields                                                  | Shown as                              |
| ---------------- | ------------------------------------------------------- | ------------------------------------- |
| `group_message`  | `run`, `text`, `from`: null (the person) or `Bot`       | a bubble (the bot's face and name)    |
| `group_asked`    | `run`, `ask`, `by`: null or `Bot`, `to`: `Bot`, `depth` | `Spade asked Research` when `by` set  |
| `group_answered` | `run`, `ask`, `to`: `Bot`, `outcome`, `detail`?         | a line unless `outcome` is `answered` |
| `group_queued`   | `run`, `ask`, `to`: `Bot`, `machine_name`               | `Waiting for Studio to come online`   |
| `group_stopped`  | `run`                                                   | `Stopped`                             |

`Bot` = `{"id", "name", "machine": "<host id>"|null}`. `outcome` is `answered`, `stopped`,
`failed`, `refused` or `gave_up` (an offline machine never came back within 7 days).

The live stream also sends `status` frames `{state, status}` for the group, as for a bot. While
the group waits, the frame also carries `waiting_member` (`Bot`): the member of this machine that
waits for the person. Clients find that member by its id, never from the status words. `GET
/groups` answers it as `waiting_member` too (null otherwise). A member starting or stopping to
wait sends the frame at once.

## Bots on other machines

`bots_list` lists the bots of this machine and of every linked machine whose Spade answers:
`{"id", "name", "task", "state", "machine": "<name>"|null}`. `bot_message {bot, machine?,
text}` reaches a bot elsewhere when `machine` names it (its name or host id). Both go through the
local daemon.

### Sending (outbox)

An ask to a bot of another machine is stored in the outbox first, with a key the sender makes
(`<sender host id>.<ask id>`), then sent. The outbox delivers it, then reads its answer by key
with long polls, and survives restarts. While the machine can't be reached the ask is queued
(backoff 2 s doubling to 5 minutes, for up to 7 days); a group shows `group_queued`, `bot_message`
keeps waiting. At most 500 asks wait at once (more are refused until some end); ended entries
are kept 30 days. Stop withdraws a queued ask before it is sent, and sends `stop` for one already
delivered.

### Receiving (inbox)

`POST /v1/inbox`. Only the local daemon reaches it: it forwards machine calls from the person's
other machines (op `spade`, below) and stamps them:

- `x-ace-from-host`: the pairing id the call authenticated with on this daemon (never the host
  id the caller claims), the sender every key belongs to;
- `x-ace-from-name`: the calling machine's name, percent-encoded UTF-8;
- `x-ace-inbox-time`: milliseconds since the epoch;
- `x-ace-inbox-proof`: lowercase hex HMAC-SHA256, keyed with the daemon's local token
  (`<ace home>/daemon-token`), of `ace-spade-inbox/1\n<time>\n<from-host>\n<from-name as
sent>\n<hex SHA-256 of the body>`.

Spade reads the daemon's token from ace's home on each request and refuses (`403`) anything
unsigned, signed with another key, or signed more than 5 minutes from its clock; Spade's own
bearer token alone never reaches the inbox. Without ace's home it answers `503`. Bounds: one
sender may deliver 500 asks a day (`429` past that), keys are kept 30 days, names are cut to one
line (a bot's to 40 characters, a group's to 60), and an ask must name the bot (`from`) or the
group it came through: words from another machine are never the person's own (`400`). Bodies:

| `op`     | Fields                                                                      | Answer                                       |
| -------- | --------------------------------------------------------------------------- | -------------------------------------------- |
| `bots`   |                                                                             | `{"bots":[{id, name, task, state, avatar}]}` |
| `ask`    | `key`, `to`, `text`, `from: {id, name}`, `depth`, `group?: {id, name, run}` | `{"status":"accepted"                        | "duplicate"}`; `404`no such bot;`409` refused |
| `answer` | `key`, `wait_ms` (0 to 25,000)                                              | `{"status":"pending"                         | "answered"                                    | "stopped"   | "failed" | "unknown", "text"?}` |
| `stop`   | `key`                                                                       | `{"status":"stopped"                         | "not_running"                                 | "unknown"}` |

`key` is 1 to 160 of `A-Za-z0-9_.:-`, scoped to the calling host: the same key from two machines
is two asks. The key is stored in the same transaction that stores the message, so a repeated
`ask` answers `duplicate` and delivers nothing. The message carries `from_agent {id, name, depth,
machine}` (so it is untrusted, and the bot's chat names the machine) and, for a group,
`from_group`.

### What ace adds

The daemon passes these bodies through without reading them, except `op` for the risk below.

- **Spade to its daemon** (the socket Spade already uses for `skills.request`):
  - `spade.machines {requestId}` → `spade.machines.result {requestId, machines: [{hostId, name,
status: "online"|"offline"}]}`: the linked machines this daemon can call.
  - `spade.remote {requestId, machine: <host id>, request: <JSON object>}` →
    `spade.remote.result {requestId, result}` with `result` `{kind: "response", status, body}`
    (`body` is Spade's JSON answer there) or `{kind: "error", code, message}`, `code` one of
    `unknown_machine`, `offline` (nothing was sent), `disconnected` (it may have arrived),
    `refused` (that machine said no), `forbidden`.
- **Between daemons:** machine call op `{op: "spade", request: <JSON object, at most 512 KiB>}`.
  The target admits it under the Agents grant (ADR 0105): `bots` and `answer` need Read, `ask`
  and `stop` need Read and act. A pairing made from a time-limited link is a guest and is refused
  (`machine_forbidden`). It forwards the request to its Spade as `POST /v1/inbox` with the
  stamps and signature above and answers `{status, body}`. With Spade off there it refuses
  `unavailable`.
- `spade.http` and the desktop's direct path refuse `/v1/inbox` (`invalid_path`).

## Templates

`GET /v1/templates` → `{"templates": [Template]}`, shipped in the binary
(`config/templates.json`).

**Template** = `{"id", "name", "blurb", "task", "color", "model_kind": "fast"|"capable",
"routines": [{"name", "instruction", "schedule"}]}`. `schedule` is a phrase routines read
(`weekdays at 8:00`).

`POST /v1/agents` takes `template` (an id): `name`, `task` and `avatar` default to the
template's, the model to the fast model for `fast` (else the default), and its routines are
created with the bot, in `time_zone` (an IANA zone in the body; the machine's when absent).
Unknown template: `404`.

## Duplicate, export, import

| Method and path               | Body         | Answer                                      |
| ----------------------------- | ------------ | ------------------------------------------- |
| `POST /agents/{id}/duplicate` | `{name?}`    | `201 {"agent"}`                             |
| `GET /agents/{id}/export`     |              | `200` the bot file (below)                  |
| `POST /agents/import`         | the bot file | `201 {"agent", "left_out": ["<one line>"]}` |

**Duplicate** copies the task, avatar, model, routines (each with its pause state; webhooks get
new secrets), connector choices and the bot's own notes. The name is `name`, else `<name> copy`.
Never the conversation. The main bot can be duplicated; the copy is a bot.

**The bot file** is JSON, at most 6 MiB:

```json
{
  "format": "spade-bot",
  "version": 1,
  "name": "Research",
  "task": "…",
  "avatar": { "kind": "generated", "color": "teal" },
  "model": "openrouter/some-model",
  "routines": [
    {
      "kind": "routine",
      "name": "Morning digest",
      "instruction": "…",
      "trigger": { "kind": "schedule", "schedule": "weekdays at 8:00" },
      "time_zone": "Europe/Berlin",
      "paused": false
    }
  ],
  "connectors": { "all": false, "connectors": ["linear"] },
  "notes": ["Prefers sources from the last two years."]
}
```

An image avatar is `{"kind": "image", "data": "data:image/png;base64,…"}`. Never in the file:
keys, connector tokens, webhook secrets, the conversation, shared notes. Import makes a new bot
with all of it; a model whose endpoint this machine doesn't have falls back to the default model,
connectors this machine hasn't connected are left out, and a routine that doesn't read here is
skipped. Each is one line in `left_out`. A file that isn't a bot file is `400`.
