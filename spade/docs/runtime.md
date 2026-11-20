# The runtime API, `spade.v1`

<!-- Written from `spade_core::effect::runtime`. Don't edit by hand: change the table and run `SPADE_WRITE_RUNTIME_DOC=1 cargo test -p spade-core runtime_doc`. -->

The tools every Spade bot gets, under stable names (ADR 0200 §4). They are Spade's built-in tools, gated as always: a call goes through the effects gate, the sandbox, the reviewer or the person. This is not an SDK; nothing a package brings runs in Spade's process.

A package says which version it needs with `requires.runtime` (now `1`) and narrows its bot's tools to the modules it `uses`.

**Effects** are ADR 0171's words, from least to most serious: `read`, `write_local`, `network`, `publish`, `send_as_person`, `pay`, `drive`, `change_access`. Each Spade tool's effect is read from the same table the gate decides with.

## Versions

- **A minor change** adds a tool, an optional argument or a field in an answer. A package that requires runtime `1` keeps working; `requires.spade` names the build whose additions it needs (the `Since` column).
- **A major change** renames or removes a tool, changes what an argument means or an answer's shape, or gives a tool a stronger effect. That is `spade.v2`. Each v1 name keeps working as an alias for at least six months, and while any listed package still requires v1, with a note below.
- A test walks the table and fails when a v1 tool goes missing or its effect gets stronger without an alias.

## `task`

The bot's goal, plan and where its task stands; its own task and face.

| Tool | Effect | Since |
| --- | --- | --- |
| `task_goal` | `write_local` | 0.0.24 |
| `task_plan` | `write_local` | 0.0.24 |
| `task_status` | `write_local` | 0.0.24 |
| `task_update` | `write_local` | 0.0.24 |
| `todo` | `write_local` | 0.0.24 |
| `profile_update` | `write_local` | 0.0.24 |

## `memory`

Notes, the knowledge base, past episodes and the conversation's history.

| Tool | Effect | Since |
| --- | --- | --- |
| `memory_save` | `write_local` | 0.0.24 |
| `memory_update` | `write_local` | 0.0.24 |
| `memory_forget` | `write_local` | 0.0.24 |
| `memory_search` | `read` | 0.0.24 |
| `knowledge_write` | `write_local` | 0.0.24 |
| `knowledge_update` | `write_local` | 0.0.24 |
| `knowledge_forget` | `write_local` | 0.0.24 |
| `knowledge_link` | `write_local` | 0.0.24 |
| `knowledge_merge` | `write_local` | 0.0.24 |
| `knowledge_read` | `read` | 0.0.24 |
| `knowledge_search` | `read` | 0.0.24 |
| `episode_search` | `read` | 0.0.24 |
| `history_read` | `read` | 0.0.24 |
| `history_search` | `read` | 0.0.24 |
| `about_person` | `read` | 0.0.24 |

## `files`

The bot's workspace, its sandboxed shell and the services it owns.

| Tool | Effect | Since |
| --- | --- | --- |
| `workspace_list` | `read` | 0.0.24 |
| `workspace_read` | `read` | 0.0.24 |
| `workspace_search` | `read` | 0.0.24 |
| `workspace_write` | `write_local` | 0.0.24 |
| `workspace_edit` | `write_local` | 0.0.24 |
| `document_read` | `read` | 0.0.24 |
| `share_file` | `write_local` | 0.0.24 |
| `shell` | `write_local` | 0.0.24 |
| `service_start` | `write_local` | 0.0.24 |
| `service_status` | `read` | 0.0.24 |
| `service_logs` | `read` | 0.0.24 |
| `service_stop` | `write_local` | 0.0.24 |

## `web`

Searching and reading the web.

| Tool | Effect | Since |
| --- | --- | --- |
| `web_search` | `read` | 0.0.24 |
| `web_fetch` | `read` | 0.0.24 |
| `research` | `read` | 0.0.24 |

## `apps`

The person's connected apps and allowed plugins. Their own tools are offered deferred and gated, and their output is untrusted; their names are the apps', not part of this API.

| Tool | Effect | Since |
| --- | --- | --- |
| `apps_find` | `read` | 0.0.24 |
| `app_connect_request` | `read` | 0.0.24 |
| `tool_search` | `read` | 0.0.24 |
| `call_tool` | the called tool's | 0.0.24 |

## `agents`

Other bots, clubs, workers, helpers and ace's coding agents.

| Tool | Effect | Since |
| --- | --- | --- |
| `bots_list` | `read` | 0.0.24 |
| `bot_message` | `network` | 0.0.24 |
| `group_ask` | `write_local` | 0.0.24 |
| `club_add` | `write_local` | 0.0.24 |
| `bot_create` | `network` | 0.0.24 |
| `worker_message` | `network` | 0.0.24 |
| `worker_status` | `read` | 0.0.24 |
| `worker_result` | `read` | 0.0.24 |
| `worker_stop` | `write_local` | 0.0.24 |
| `helper` | `write_local` | 0.0.24 |
| `delegate` | `network` (ace's) | 0.0.24 |

## `ui`

What the person sees besides the reply: questions, images and cards.

| Tool | Effect | Since |
| --- | --- | --- |
| `ask_user` | `read` | 0.0.24 |
| `image_generate` | `write_local` | 0.0.24 |
| `card_show` | `write_local` | 0.0.24 |

## `schedule`

Routines, wakes and waits.

| Tool | Effect | Since |
| --- | --- | --- |
| `routines_list` | `read` | 0.0.24 |
| `routine_save` | `write_local` | 0.0.24 |
| `routine_delete` | `write_local` | 0.0.24 |
| `sleep_until` | `write_local` | 0.0.24 |
| `wait_for` | `write_local` | 0.0.24 |
| `wake_cancel` | `write_local` | 0.0.24 |

## `devices`

ace's browser, screen and simulators, and devices named with @, through ace.

| Tool | Effect | Since |
| --- | --- | --- |
| `browser_*` | `read`, or `drive` when it acts (ace's) | 0.0.24 |
| `screen_*` | `read`, or `drive` when it acts (ace's) | 0.0.24 |
| `sim_*` | `read`, or `drive` when it acts (ace's) | 0.0.24 |

## `outward`

Pushes, comments and messages with the person's own sign-ins.

| Tool | Effect | Since |
| --- | --- | --- |
| `git_push` | `send_as_person` | 0.0.24 |
| `pr_comment` | `send_as_person` | 0.0.24 |
| `issue_comment` | `send_as_person` | 0.0.24 |
| `send_message` | `send_as_person` | 0.0.24 |

## `notify`

Proactive notices to the person. Phase 2; no tools yet.

## Aliases

None. `spade.v1` is the first version.

## Not part of the API

Harness internals (compaction, titles, the check of done) and these tools, which may change in any build: `decision_log`, `skill_search`, `skill_load`, `skill_propose`, `skill_feedback`.
