# Agents, endpoints and models

Spade is a set of agents on one machine ([ADR 0126](../../docs/adr/0126-spade-agents.md),
[ADR 0127](../../docs/adr/0127-spade-main-bot-and-chat.md)). Spade itself is the main agent; every
other agent is a bot. Each agent has exactly one conversation, which runs, steers, stops,
compacts and recovers on its own, as [chat-core.md](chat-core.md) and [harness.md](harness.md)
describe. Agents run on models from the person's own endpoints.

## Agents

- **Main agent.** Created by the server on first start: name `Spade`, avatar `{"kind":"spade"}`,
  empty task, the person's first usable model (first endpoint with a key and a saved model), else
  the presets' main role. At most one per service. It cannot be deleted, and its name and avatar
  cannot change (`409`); its task and model can. `PUT /v1/main {"enabled": false}` switches it off
  on a machine that does not host Spade: it is left out of `GET /v1/agents` and `bots_list`, and
  messages to its conversation answer `409`. Its stored conversation is kept.
- **Bots.** Created by the person. Name 1 to 40 characters (trimmed, one line), task up to 4,000
  characters, avatar, model.
- **Task and model** changes are stored as an `agent_configured` event in the agent's
  conversation and used from its next turn, never mid-turn: a turn's prompt takes the task stored
  before its `reply_started`, placed in the cached top of the prompt, and `reply_started` names
  its model. A restart rebuilds the identical prompt. Name and avatar changes apply at once.
- **Delete** first marks the agent as being deleted, under the lock every delivery takes: from
  then on no message or job result reaches it, no turn, job or title starts, and messages answer
  `404`. Its turn and jobs are stopped and given up to 5 seconds to let go; whatever is still
  running then is cancelled. Then the agent, its conversation and its events are deleted.
  Spending stays in the ledger.
- **Concurrent changes** to one agent are read, merged and written as one, so two PATCHes never
  overwrite each other's fields.
- **Upgrade.** Schema 2 turns each stored conversation into a bot named after its title (or
  `Agent`), empty task, generated avatar, and the model its latest reply used (else the presets'
  main role). The main agent is created fresh. A later schema turns every initials avatar into a
  character face (see Faces).
- **Titles** and other side jobs use the person's fast model (`PUT /v1/settings`), else the
  agent's own model. Compaction always uses the agent's own model.

### Bots talking

Every agent has two tools:

- `bots_list`: the other agents on this machine (id, name, task summary, state).
- `bot_message {bot, text}`: `bot` is an id or exact name. The text is stored in that bot's
  conversation as a `user_message` with `from_agent: {id, name, depth}`, which wakes it. It runs as
  a background job, so the caller carries on; the bot's next finished reply comes back to the caller
  as the job's `<job_result>` (a stop, failure or restart comes back as an error). A restart reports
  it lost like any job. It is a write: the person approves it (once with "always"), and its result
  counts as untrusted, so a write after it asks. A bot cannot message itself. A turn that another
  bot's message started or steered counts as untrusted, so every write in it asks the person, even
  one they allowed "always". `depth` is 1 when the caller was answering the person and one more per
  hop; a message deeper than 16 is refused, a guard against bots messaging each other forever
  (it was 3 before ADR 0158). The same holds for asks from other machines.

## Endpoints and models

The person's endpoints and saved models are in Spade's database; keys stay in the OS keychain (ADR 0119) or the endpoint's environment variable. `config/models.json`, built into the binary and read
from there on every start, holds presets: endpoint templates and known facts about model ids
(context, capabilities, prices). On the first start with schema 2, every preset whose key is already
present becomes one of the person's endpoints with the same id, so existing keys keep working.

**Credentials stay with their host.** Spade follows no redirect on any model call or listing, since
each carries a key or the person's headers; a redirect answers as an error. A base URL is read with
the HTTP client's own URL parser: only `http` and `https`, no user name or password, no backslash,
no query or fragment. Changing an endpoint's `base_url` to another origin (scheme, host and port as
that parser reads them) is refused with `409` while a key is stored for it in the keychain or found
in its environment variable, whatever `needs_key` says (remove it with `DELETE /v1/keys/{id}`
first), while it takes its key from an environment variable (add a new endpoint for the other host),
or while it has extra headers (send `"headers": {}` with the new URL). An endpoint made from a
preset but pointing at another origin than the preset's keeps neither the preset's key variable nor
its headers. If the keychain cannot be read, the change is refused (`503`) rather than taken as "no
key".

**Deleting an endpoint** removes its keychain key first. If the keychain cannot do that, the delete
is refused (`503`) and the endpoint keeps its id. A new endpoint never takes an id that still has a
key in the keychain: it gets the next free one (`gate-2`). An endpoint is in use, and cannot be
deleted (`409` naming the agents), while an agent's model is on it or an agent's open or paused
reply still runs on one of its models. Headers that carry credentials
(`authorization`, `proxy-authorization`, `x-api-key`, `api-key`, `x-goog-api-key`, `cookie`,
`set-cookie`, any case) are refused as extra headers and as the session header: keys go to the
keychain. Listing errors hide the key and every configured header value.

**Presets are inherited, not copied.** An endpoint made from a preset remembers it. Only what the
person chose is stored; the preset's models and their facts (context, capabilities, price) are
read from the binary each time, so shipped corrections reach existing installs. A model's facts
come from the endpoint's own preset first; a fact borrowed from another preset with the same model
id never brings its price.

Earlier builds copied `models.json` into the data folder and then read only that copy, so an
upgrade never saw new shipped facts. Now a copy found there is read once, before presets are
imported: if it equals a file some Spade shipped it holds nothing of the person's. Otherwise every
value in it that no Spade ever shipped for that endpoint or model (a moved URL, an added header, a
changed context) is the person's edit and is stored, winning over the presets; the rest is
inherited. Endpoints no Spade shipped are taken whole; a shipped endpoint nobody edited is taken
only when it has a key. Either way it is moved to
`models.json.old` and never read again.

A model is `endpoint/model`, split at the first `/` (endpoint ids have none; model ids may), or
one of the person's subscriptions, `cli:<provider>[@<account>]/<model>`
([cli-brains.md](cli-brains.md)). Any
model id on one of the person's endpoints works, saved or not. Its facts come from what the person
saved, else the endpoint's own listing when saved from it, else the presets' facts for that id,
else defaults: context 128,000, capabilities `["tools"]`.

Live listing is `GET <base_url>models`: `Authorization: Bearer <key>` for OpenAI formats,
`x-api-key` and `anthropic-version: 2023-06-01` for Anthropic, plus the endpoint's headers.
`{"data":[…]}`, `{"models":[…]}` and bare arrays are read; items without a string id are skipped;
context comes from `context_length`, `context_window`, `max_context_length` or
`max_input_tokens`. At most 4 MB, 5,000 models and 10 seconds. A failure is one line that never
carries the key.

## Models per role

Each bot uses a model per role ([ADR 0162](../../docs/adr/0162-spade-model-routing.md)):
`main` (its turns: the bot's model), `helper`, `verify` (the check of done), `review`, `compact`
(summaries) and `title`. A role's model is the bot's override, else the global one, else the
default:

| Role                         | Default                                                                                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `helper`, `compact`, `title` | the fast model (`fast_model`), else the bot's                                                                                                   |
| `review`                     | the review model (oversight `review_model`, the global override), else the fast model, else the bot's                                           |
| `verify`                     | the most expensive model the person already uses (bots', review, fast, new-bot) listing at least the bot's price, not the bot's; else the bot's |

Strength is the listed input plus output price; unpriced models never win a default. An override
whose model is gone is skipped. Roles other than `main` take endpoint models only, never `cli:`.
Overrides are JSON settings (`model_roles`, `model_roles:{agent}`); a bot's go with it when it is
deleted.

- **Per call.** `helper {model}` takes a role name or `endpoint/model`. A model must be listed on
  one of the person's endpoints and, when the bot has an `allowed` list, on it; anything else is
  refused with the roles and the allowed models.
- **Escalation.** With `escalate` on (the call's, else the bot's, else the global setting; off by
  default) a helper that failed on another model reruns once on the bot's model, stored as job
  `<job>~2`. Its result starts "(The helper failed on X, so it ran again on Y.)".
- **Spend.** The ledger (`spend.role`) records each call's role; a helper's calls are `helper`,
  rows from before the column `main`.
- **Cache.** A role's model applies from its next new request; past prompts are never rewritten.
  Compaction moves to the `compact` model only when that model's context holds the prompt (plus
  8,192 tokens), it takes what the conversation's model takes (tools, images, PDFs) and, unless
  the person chose the model, its cold estimate is below the conversation model's cached one.

API: `GET`/`PUT /v1/models/roles` (`{roles: {<role>: model | null}, escalate}`) and
`GET`/`PUT /v1/agents/{id}/models` (`{roles: [{role, model, source}], overrides: {roles, allowed,
escalate}, escalate, spend: {today, month}}`; `source` is `bot`, `global`, `default` or `own`).
`main` is refused there: change the bot's model. `PUT /v1/models/roles {roles: {review}}` sets
oversight's `review_model`.

## Faces

A bot's character face is eight fields; clients draw it (the model and geometry live in
`packages/ui-core/src/bot-face/`, the same rules in `spade-core/src/face.rs`):

| Field       | Values                                                                   |
| ----------- | ------------------------------------------------------------------------ |
| `body`      | round, blob, pebble, sprout, ghost, bot, fox, bird, cloud, bean          |
| `pair`      | ember, butter, mint, lagoon, sky, lilac, rose, berry, sage, cocoa, stone |
| `ears`      | none, cat, bear, bunny, tuft, nubs                                       |
| `marking`   | none, cap, mask, muzzle, patch, stripes, spots                           |
| `eyes`      | egg, round, big, sleepy, almond, bead                                    |
| `mouth`     | none, smile, open, cat, o, grin                                          |
| `cheeks`    | none, blush, freckles                                                    |
| `accessory` | none, bow, flower, glasses, headphones, beanie, scarf                    |

- Some bodies take fewer values (a bird has no mouth or ears, a bot no ears), and some values
  never go together (big ears and headphones, a mask and glasses, spots and freckles).
- **Repair, never refuse.** A face in a body (create, patch, import) is repaired: an unknown or
  missing value takes the default (round, lagoon, egg eyes, none elsewhere), then each value the
  body or another field rules out falls back to `none`. Fields Spade doesn't know are dropped. The
  stored face is the repaired one, so what is stored is what every client draws. Shared vectors
  (`spade-core/src/face/vectors.json`) pin Spade and the TS model to the same answers.
- **Picked faces.** A bot without a face gets one shuffled from a generator seeded by its id
  (FNV-1a, then Mulberry32; the TS model makes the same face from the same id), in a colour pair
  no other bot wears while one is left.
- **Initials avatars migrate in the store**, once: schema 6 rewrites every `generated` (or
  unreadable) avatar as the face its agent's id seeds, oldest agent first, each preferring pairs
  the earlier ones don't wear. Pictures and Spade's mark are untouched. Reading an avatar that is
  still not a face (one a group member on another machine sent, say) shows the face its id seeds.
- Templates ship their own faces; exported bot files carry the face and import repairs it.
- The iPhone draws faces later from the same tables and geometry (Spade's tab is hidden there).

## API

All under `/v1`, with the bearer token; JSON; problems are `{"error": "<one line>"}`. Unknown
fields in a body are ignored. Times are integer milliseconds since the epoch.

**Agent** = `{"id", "kind": "main"|"bot", "name", "task", "avatar", "model", "conversation",
"created_at", "updated_at", "last_activity", "pinned_at", "state", "working", "waiting_for", "status",
"problem", "last_message", "seen_seq", "unseen", "access", "task_state", "continuing"}`

- `access`, `task_state`, `continuing`: the bot's access level and its task as it last said, and
  whether Spade is carrying the task on by itself ([autonomy.md](autonomy.md)).
- `parent`, `workers`: the bot that made it as a worker (`{id, name}`, else `null`), and how many
  of its own worker bots have not settled ([workers.md](workers.md)). `state` rolls up its
  workers: it reads `waiting` or `working` while any of them does.
- `from_recipe`, `tools`: only on a bot made from a marketplace recipe: the recipe's
  `{source, name, version}`, and the built-in tools it is narrowed to when the recipe named them
  ([teams.md](teams.md)).

- `avatar`: `{"kind":"image","sha256"}` (served by `GET /v1/images/{sha256}`),
  `{"kind":"character","v":1,"body","pair","ears","marking","eyes","mouth","cheeks","accessory"}`
  (see Faces), or `{"kind":"spade"}`.
- `state`: `idle`, `working` (a reply is open or a background job runs) or `waiting` (an approval
  or a question waits for the person). `working` is `state != "idle"`, kept for clients built on the first
  draft of this contract.
- `waiting_for`: while `state` is `waiting`, `"question"` when the agent asked the person with
  `ask_user` (see [memory.md](memory.md)), else `"approval"`; `null` otherwise.
- `status`: a few plain words while not idle (`Thinking`, `Writing` once a step's words stream,
  told before them, `Searching the web`, `Reading a page`,
  `Asking Research`, `Waiting for you`, `Working in the background`, `Using <tool>`); never
  arguments; `null` when idle.
- `problem`: why the agent's latest reply on a subscription failed (signed out, out of quota),
  until a later reply finishes; `null` otherwise ([cli-brains.md](cli-brains.md)).
- `last_message`: `{"from": "person"|"agent", "text", "at", "seq", "from_agent": {"id","name"}|null}`
  or `null`. The latest message in the conversation: a message to the agent (`person`; with
  `from_agent` set when another bot sent it) or the agent's reply text (`agent`), never tool
  output. `text` is the list's preview: plain text on one line, at most 200 characters, with
  markdown gone (emphasis, headings, quotes, fences, list marks, strike-through) and links and
  images as their words (`[the plan](…)` → `the plan`). `seq` is its event. A group's message and
  a reply that answers only group messages are the group's ([teams.md](teams.md)), never this.
- `seen_seq`: the conversation's seen cursor (see Seen), or `null` when never marked.
- `unseen`: the bot finished and the person hasn't seen it: `state` is `idle` and the bot's own
  `last_message` is past `seen_seq`. Never true while any of its work runs or waits on the person.

### Pins

`PUT /v1/agents/{id}/pin` and `PUT /v1/groups/{id}/pin` with `{"pinned": bool}` pin a bot or a
group (Spade, the main bot, too) to the top of the person's list, or unpin it. Answer
`{"agent"}` or `{"group"}`; `404` for none. Agents and groups carry `pinned_at`: the ms it was
pinned, or `null`. Pinning a pinned conversation keeps its `pinned_at`, so a list shows the strip
oldest pin first. Pins live in `agents.pinned_ms` and `groups.pinned_ms`, so every device that
reads this Spade shows the same strip, and they survive restarts.

### Seen

`PUT /v1/conversations/{id}/seen` with `{"seq"?}` (or no body) marks a bot's or a group's
conversation seen up to that event, the conversation's last when absent, never past it. The
cursor only moves forward: an older `seq` leaves it where it is. Answer `{"seen_seq"}`; `404` for
no such conversation. Each mark is sent on the conversation's live stream as
`event: seen`, `data: {"seq"}`, so every device drops its mark. Cursors live in the `seen` table,
so they survive restarts, and go with their conversation; they are never events, so nothing the
model reads changes. The schema step that added them counted every conversation as seen up to
then.

| Method and path                               | Body                                                                       | Answer                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `GET /agents`                                 |                                                                            | `{"agents":[Agent]}`: main first, then by `last_activity`  |
| `POST /agents`                                | `{name, task?, model?, avatar?, access?, first_message?}`                  | `201 {"agent"}`; `model` defaults as below                 |
| `PATCH /agents/{id}`                          | any of `name`, `task`, `model`, `avatar`, `access`                         | `200 {"agent"}`; `409` for the main agent's name or avatar |
| `DELETE /agents/{id}`                         |                                                                            | `204`; `409` for the main agent                            |
| `PUT /agents/{id}/pin`                        | `{"pinned": bool}`                                                         | `200 {"agent"}`; `404`; `pinned_at` is ms or `null`        |
| `PUT /main`                                   | `{"enabled": bool}`                                                        | `204`                                                      |
| `GET /models`                                 |                                                                            | `{"endpoints","presets","fast_model","new_bot_model", …}`  |
| `POST /endpoints`                             | `{name, format, base_url, headers?, session_header?, needs_key?, preset?}` | `201 {"endpoint"}`                                         |
| `PATCH /endpoints/{id}`                       | same fields but `preset`                                                   | `200 {"endpoint"}`                                         |
| `DELETE /endpoints/{id}`                      |                                                                            | `204` (its keychain key goes too); `409 {error, agents}`   |
| `GET /endpoints/{id}/models`                  |                                                                            | `{"models":[{id, name?, context?, capabilities?}]}`, live  |
| `POST /endpoints/{id}/models`                 | `{id, name?, context?, capabilities?}`                                     | `200 {"endpoint"}`                                         |
| `DELETE /endpoints/{id}/models?id=<model id>` |                                                                            | `204`; `404` if not saved                                  |
| `PUT /settings`                               | any of `fast_model`, `new_bot_model`: `"endpoint/model" \| null`           | `204`                                                      |
| `PUT`/`DELETE /keys/{endpoint}`               | `{key}`                                                                    | as before (ADR 0119)                                       |
| `POST /conversations`                         |                                                                            | `410`: create an agent instead                             |

- A new bot's `model`, when the body names none: `new_bot_model` (the person's choice in Settings,
  answered by `GET /models`, set with `PUT /settings`; `null` clears it), else the person's first
  usable model. A template's own model kind still wins over it, and an imported bot whose model
  isn't here gets it too.
- `first_message`: `{"text", "images"?: [{"data"}]}` (images as for messages) makes the bot and
  sends it this as its first message, the new-bot conversation's one call. Both happen, or
  neither: a message Spade can refuse before the bot exists (empty, too long, too many images)
  answers as `POST /conversations/{id}/messages` would and makes nothing; one refused as it is
  sent (an attachment that is no image, storage) deletes the bot again before answering. The answer's
  `agent` is read after the send, so its `state` is already `working`. Files and voice go in
  later messages.
- Avatar in a body: `{"kind":"image","data":"<base64 or data: URL>"}` (PNG, JPEG, GIF or WebP,
  3.75 MB at most, stored like attached images) or a character face. An absent avatar, or
  `{"kind":"generated"}` from an older client (its colour ignored), gets a face Spade picks (see
  Faces).
- **Endpoint** = `{"id", "name", "format", "base_url", "session_header", "header_names",
"needs_key", "key_set", "key_source": "keychain"|"environment"|null, "models": [{"id", "name",
"context", "capabilities", "source": "listed"|"typed"|"preset"}]}`. Header values and keys are
  never answered. The id is a slug of the name, unique (`-2`, `-3`, …). `format` is `openai-chat`,
  `openai-responses` or `anthropic`; `needs_key` defaults to true (false for a local server).
  With `preset`, missing fields come from that preset, its key variable and models included.
  A keychain read never holds the answer up: one still waiting (a prompt nobody answered) leaves
  `key_set` and `key_source` null, and `GET /models` then says `"keys_pending": true`; asked
  again, the keychain's answer shows once it comes.
- **Preset** = `{"id", "name", "format", "base_url", "key_env", "session_header"}`.
- Errors: `400` for a body that does not fit (or `413`/`415`/`422` from the JSON reader), `404`
  for an unknown id, `409` as above, `502` when the endpoint's own listing fails, `400` when it
  needs a key that is not set.

### Live stream

`GET /v1/conversations/{id}/live` also sends `status` events, `{"state", "status"}`: once after
`caught_up`, then on each change (a model step starts, a tool starts, an approval waits or is
answered, a turn or job ends). Not stored. Older clients ignore the event name.

## Events

| Type               | Fields                              | Meaning                               |
| ------------------ | ----------------------------------- | ------------------------------------- |
| `agent_configured` | `task`, `model`                     | The agent's task or model changed     |
| `user_message`     | `…, from_agent?: {id, name, depth}` | `from_agent` when another bot sent it |
