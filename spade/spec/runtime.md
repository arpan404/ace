<!-- spec:begin header -->
# Spade Agent Format 1.0: Runtime

<!-- SPDX-License-Identifier: CC-BY-4.0 -->
<!-- Text between spec:begin and spec:end marks is written from Spade's data (ADR 0201 §4). Don't edit it by hand: change the data and run `SPADE_WRITE_SPEC=1 cargo test -p spade-core spec_doc`. -->

Part `runtime`, version 1.0, of the [Spade Agent Format](README.md) 1.0. `spade.v1`: its modules, tool names, the effect of each tool, `since`, aliases and the major and minor rule.

This text is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); the schemas and the conformance suite under Apache-2.0 ([LICENSE.md](LICENSE.md)). The key words MUST, MUST NOT, SHOULD and MAY are to be read as RFC 2119 and RFC 8174 define them, when in capitals.
<!-- spec:end header -->

The tools every bot gets, under stable names, grouped into modules. They are the runtime's own
tools, gated as always: a call goes through the ceiling and the runtime's gate. This is not an
SDK; nothing a package brings runs in the runtime's process.

<!-- spec:begin version -->
This part names `spade.v1`: a package that needs it says `"requires": {"runtime": "1"}`.
<!-- spec:end version -->

A package narrows its bot's tools to the modules it `uses` ([package](package.md)). Each tool's
effect below is the most a call to it does.

## Versions

- **A minor change** adds a tool, an optional argument or a field in an answer. A package that
  requires runtime `1` keeps working; `requires.spade` names the build whose additions it needs
  (the `Since` column).
- **A major change** renames or removes a tool, changes what an argument means or an answer's
  shape, or gives a tool a stronger effect. Each name of the old major MUST keep working as an
  alias for at least six months, and while any listed package still requires it.

<!-- spec:begin modules -->
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
| `contracts_find` | `read` | 0.0.25 |
| `contract_call` | `write_local` | 0.0.25 |
| `contract_return` | `write_local` | 0.0.25 |
| `package_suggest` | `read` | 0.0.25 |

## `ui`

What the person sees besides the reply: questions, images, cards and the state of its package's panels.

| Tool | Effect | Since |
| --- | --- | --- |
| `ask_user` | `read` | 0.0.24 |
| `image_generate` | `write_local` | 0.0.24 |
| `card_show` | `write_local` | 0.0.24 |
| `panel_update` | `write_local` | 0.0.25 |

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

Proactive notices to the person, under their quiet hours, do not disturb, interruption budget and each bot's notification switch; what waits goes into the morning brief. A bot sends at most 3 an hour (more wait for the brief) and 12 a day (more are refused). The words are the bot's, shown as plain text.

| Tool | Effect | Since |
| --- | --- | --- |
| `notify` | `write_local` | 0.0.25 |

## `code`

The tools of the package's own WebAssembly components (ADR 0203), one per tool a component gives, named `code_<component>_<tool>`. Each runs in the bot's sandbox with no authority of its own: what it reaches through `spade:package/http` and `spade:package/tools` Spade does after the gate, the ceiling first. A component the person turned off gives no tools.

| Tool | Effect | Since |
| --- | --- | --- |
| `code_*` | its imports': `network` with `http`, else `write_local` with `kv`, else `read`; each `tools` call the called tool's | 0.0.25 |

<!-- spec:end modules -->

Tools marked "ace's" belong to ace's integration: they are listed by name and effect only, and a
runtime that isn't Spade MAY answer them as unavailable.

## Conformance

`spade-conform` holds a runtime to this part's MUSTs at the Runtime level, through its HTTP API
and its scenario door ([`conformance/README.md`](conformance/README.md)). A runtime conforms at
the Runtime level only when it passes every Reader case too.

<!-- spec:begin level-cases -->
From [`conformance/runtime/packages.json`](conformance/runtime/packages.json).

| Case | A runtime MUST pass |
| --- | --- |
| `runtime/install-starts-every-switch-off` | an install the person left every switch off on |
| `runtime/install-keeps-what-the-person-turned-on` | an install with one switch the person turned on |
| `runtime/install-starts-routines-paused` | schedule, event and webhook triggers start paused |
| `runtime/install-refuses-what-a-reader-refuses` | a manifest a reader refuses makes no bot |
| `runtime/install-refuses-a-module-it-lacks-by-name` | a module the runtime lacks is refused by its name |
| `runtime/a-switch-turns-on-one-declared-effect` | the person turns one declared effect on |
| `runtime/a-switch-for-an-effect-not-declared-is-refused` | a switch for an effect the package didn't declare |
| `runtime/an-update-is-one-step-and-what-it-adds-starts-off` | an update keeps the switches the person set, and a new effect starts off |
| `runtime/a-rollback-is-one-step-back` | a rollback moves the bot back to the version before in one step |
| `runtime/contracts-are-published-and-the-person-closes-calls` | a package's contracts are listed at install, and the person's switch closes calls to it |

From [`conformance/runtime/scenarios.json`](conformance/runtime/scenarios.json).

| Case | A runtime MUST pass |
| --- | --- |
| `runtime/a-declared-call-runs` | a call within the ceiling runs, read as its effect in the runtime part |
| `runtime/a-call-outside-the-ceiling-is-refused-when-the-person-allows-everything` | a push, which sends as the person and the package never declared, is refused though the person allows every call |
| `runtime/a-package-cant-change-the-effect-a-call-is-read-as` | a package's words don't make a push read as anything else |
<!-- spec:end level-cases -->

## Aliases

<!-- spec:begin aliases -->
None. `spade.v1` is the first version.
<!-- spec:end aliases -->

## Not part of the API

<!-- spec:begin internal -->
These names are a runtime's own and outside `spade.v1`; a package MUST NOT rely on them: `decision_log`, `skill_search`, `skill_load`, `skill_propose`, `skill_feedback`.
<!-- spec:end internal -->
