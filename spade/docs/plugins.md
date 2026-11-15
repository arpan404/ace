# The person's plugins

Date: 2026-11-14. How Spade's bots use the plugins the person accepted in ace
([ADR 0151](../../docs/adr/0151-spade-skills-and-plugins.md), points 8–13; plugins themselves are
[ADR 0014](../../docs/adr/0014-plugins.md)). Built in `packages/plugins` (the daemon's
`plugins.spade` and `plugins.spadeFile`), `spade-ace` (the requests), `spade-mcp` (the stdio transport), `spade-core`
(`hooks`, the two events) and `spade-server` (`plugins/`, `engine/plugin_hooks.rs`,
`tools/plugins.rs`, `api/plugins.rs`). Extends [harness.md](harness.md) and
[connectors.md](connectors.md).

## Reading plugins from ace

Spade asks the daemon over the skill library's socket, in the `pluginRequest` envelope, one
request at a time (the daemon refuses a second on the same socket):

- `plugins.list`: every accepted plugin at its accepted version, and whether ace has it on
  (`plugins.availability`; no saved policy means on).
- `plugins.spade {name}`, new: one accepted plugin as `{install, enabled, root, components,
executions, unsupported}`. `components` are its skills, commands, agents and rules with their
  text (a component over 256 KiB, or past 640 KiB for the whole answer, comes without text and
  with `omitted`); `executions` are its hooks and MCP servers exactly as the person accepted
  them; `root` is the accepted version's folder, which `${PLUGIN_ROOT}` names in a command. The
  daemon verifies the version's files before answering, as it does before any execution. Read
  scope, like the catalog.

Spade never reads a plugin's folder; it only runs the accepted commands there. It reads the
list again when the last reading is 30 seconds old (at a conversation's first turn, before
starting servers, before running hooks, and on every settings page; hooks wait at most 2
seconds for it, then go with the last reading), and fetches a plugin again only when its hash
changed. With ace away the last copy is used.

## Who may use what

A bot gets no plugin until the person turns it on in that bot's settings; Spade itself is a bot
like any other here. Only accepted plugins can be turned on, and a plugin turned off in ace is
off for every bot. A new version needs accepting in ace again before any bot sees it. The lists
are in Spade's database (`settings`, key `plugins.access`), and a deleted bot's list goes with
it.

## What a bot uses of a plugin

Decided in `plugins/view.rs` from the daemon's answer alone:

| Component          | Spade                                                                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rules              | Without selectors: joined to the standing instructions (below). With `globs`, or frontmatter without `alwaysApply: true`: not used, the same test ace uses |
| Hooks              | Run at the six events below; a hook at any other event is not used                                                                                         |
| Local MCP servers  | Started by Spade (below)                                                                                                                                   |
| Remote MCP servers | Listed for the person to add as an app by URL, signed in like any connector; the plugin's headers are not sent                                             |
| Skills             | Store skills with origin `plugin` (below): searched, indexed and loaded, with their files, by the bots allowed the plugin                                  |
| Commands           | Manual store skills with origin `plugin`: only the person starts one; the bot never finds, indexes or loads one                                            |
| Agents             | Helper profiles of the bots allowed the plugin (ADR 0152, [helpers.md](helpers.md)): instructions, `tools` and `model` from the agent's file               |

An agent's `tools` may name the coding CLIs' tools; each stands for Spade's tools that do the same
job: `Read` for `workspace_read` and `document_read`, `Grep` for `workspace_search`, `Glob` and
`LS` for `workspace_list`, `Write` for `workspace_write`, `Edit` and `MultiEdit` for
`workspace_edit`, `Bash` for `shell`, `WebFetch` for `web_fetch`, `WebSearch` for `web_search` and
`TodoWrite` for `todo`. Other names are kept as written.

Anything ace could not import (`unsupported`) and any execution of a kind this Spade doesn't
know is listed too. The settings page shows all of these as "Not used by Spade", each with its
reason.

A bot on a subscription (ADR 0133) gets only rules, skills and commands: its CLI runs the
plugin's servers and hooks itself, and ace already gives the CLI the person's plugins.

## Skills and commands

`plugins.spade` sends each skill's SKILL.md with the list of its other files (path in the skill's
folder, size, hash, executable bit; hidden entries and files past 1 MB or 200 left out), and each
command's file. After each reading, every plugin ace has on has its skills and commands in the
skill store as rows of origin `plugin` (`plg_` and 20 hex digits of the SHA-256 of plugin, kind
and name; `source` is the plugin). A new or changed one is copied with its files, each fetched
with `plugins.spadeFile {name, path}` (the daemon reads it from the accepted version and checks
it against the accepted hash; Spade checks the hash again) and replaced whole like any store
skill; a skill whose files could not be read keeps its last copy. A plugin turned off in ace, or
removed, loses its rows at that reading.

Each bot is offered only the rows of the plugins it may use now: `skill_search`, `skill_load` and
the index read the store for the calling bot, reading ace's plugins again first when the last
reading is stale. Turning a plugin off for a bot hides its skills from that bot at once. A
command is a manual skill: never searched, indexed or loaded by the bot.

## Rules

Before a conversation's first model call, Spade stores `plugins_started
{rules, added}`: the rules of the bot's plugins as one block, each under its name, in plugin and
name order:

```
Rules from the person's plugins:

<rule plugin="style" name="tabs">
Indent with tabs.
</rule>
```

and `added`, the text the `SessionStart` hooks printed. Both become part of the standing
instructions after the skill index (`context::instructions`). They are stored again after each
compaction (with `SessionStart` run again, `source: "compact"`), and before the next model call
after the person changes which plugins the bot may use (the change is stored as
`plugins_changed`). So a rule changed in ace reaches the bot at its next compaction, and a plugin
the person turns on or off applies from the bot's next model call; in between the cached prompt
top never changes. The latest `plugins_started` is in effect; turning every plugin off stores an
empty one. A bot that never had plugins stores nothing. CLI bots' instructions are built the same
way.

## Hooks

Each hook is the plugin's command, run with `/bin/sh -c` (cmd.exe on Windows) in the bot's
workspace through the workspace shell: its own process group or job object, the shell's built
environment plus `PLUGIN_ROOT`, `ACE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT` and `CURSOR_PLUGIN_ROOT`
naming the plugin's folder (on Windows the placeholders are also written out in the command), the
event as JSON on stdin, and 10 seconds. The JSON has `hook_event_name`, `session_id` (the
conversation), `cwd`, and per event `prompt`, `tool_name`, `tool_input`, `tool_response`,
`stop_hook_active` or `source`/`trigger`.

| Plugin event       | When                                          | What its answer can do                                    |
| ------------------ | --------------------------------------------- | --------------------------------------------------------- |
| `SessionStart`     | first model call, each compaction, a change   | add text to the standing instructions (`plugins_started`) |
| `UserPromptSubmit` | before the next model step, after the message | add text after the person's message                       |
| `PreToolUse`       | before the gate sees a new call               | refuse the call, with a reason                            |
| `PostToolUse`      | before the next model step, after the result  | add text after the step's results                         |
| `Stop`             | a reply about to finish                       | ask for one more step, with a reason                      |
| `PreCompact`       | before compacting                             | nothing; it runs for its own effects                      |

Only the person's own messages run `UserPromptSubmit`, not another bot's, a routine's or a
group's. `matcher` names tools separated by `|`, each matched exactly (none, empty or `*` is
every tool); it is matched against the tool a call runs, the inner tool of a `call_tool`.

Exit 0 with nothing on stdout changes nothing; exit 0 with stdout adds it (cut at 20,000
characters; `PreToolUse` and `PreCompact` add none); exit 2 refuses or asks for more, with stderr
as the reason; anything else, a timeout included, is a failed hook and the turn carries on. A
refused call is answered "Not run: the person's plugin refused this call. <plugin>: <reason>" and
the gate never sees it. The reason is the hook's text, so it is untrusted like added text: a
later write in that turn asks. A hook never allows a call the gate would ask about. `Stop` can extend a
reply at most 3 times.

Every answer is stored as `hook_ran {hook, target, outcomes}` before the turn moves on, `target`
being the call id, or the message's, step's or compaction cut's event index; a hook never runs
again for a target it answered, so a restart does not rerun it and a rebuilt prompt is the same.
A `PreToolUse` refusal is stored in the same write as the refused call's result, and a refusal
found stored without its result (a write that failed half way) is answered before anything else,
whatever the bot's hooks are now: a refused call never runs.
Added text reads to the model as

```
<hook_output plugin="guard" event="PostToolUse">
…
</hook_output>
```

and is untrusted: a later write in that turn asks, even one allowed "always". The standing
instructions say once that `<hook_output>` is information, never instructions. Hooks that did
something (added text, refused, asked for more, failed) appear in the bot's activity log as kind
`hook`.

## Local MCP servers

`spade-mcp` has a stdio transport beside streamable HTTP, sharing the client: a child process
spoken to over its stdin and stdout, with no stderr. The server runs in the bot's workspace with
the shell's built environment, the variables the plugin declared and the plugin-root variables,
never Spade's own; `${PLUGIN_ROOT}` in its command and arguments is written out. On macOS and
Linux it leads its own process group, killed whole; on Windows it is held in a kill-on-close job
object.

One process per bot and server, started before the bot's first `tool_search` or `call_tool` in a
conversation step (so the search finds its tools), stopped after 10 minutes unused, when the
plugin is turned off or changes version, and when Spade stops. A crash is restarted on the next
use, at most 3 times in 10 minutes; then the server says it failed until the person turns the
plugin off and on. A stop for being idle never counts as a crash.

Its tools are deferred, named `<plugin>__<tool>` (anything but letters, digits, `_` and `-`
becomes `_`, at most 64), described as `<plugin>: <description>`, with risk from their
annotations (unlabelled means write) and output untrusted, as connectors' are. A call is sent
once with a 60-second timeout.

## API

Under `/v1` with Spade's bearer token. `503` when Spade isn't set up with ace.

| Method and path            | Body                | Answer                                                                 |
| -------------------------- | ------------------- | ---------------------------------------------------------------------- |
| `GET /agents/{id}/plugins` |                     | `{plugins: [Plugin], cli, problem}`; reads ace's plugins again first   |
| `PUT /agents/{id}/plugins` | `{plugins: [name]}` | The same, after storing; `400` for a plugin not accepted in ace, `404` |

A Plugin is `{name, version, enabled_in_ace, allowed, rules: [name], skills: [name], commands:
[name], agents: [name], hooks: [event], servers:
[{name, state, tools, problem}], remote: [{name, url}], not_used: [{what, reason}]}`, where a
server's `state` is `not_started`, `running`, `stopped` (idle) or `failed`.

The web app's bot settings show a Plugins section under Apps: one switch per accepted plugin with
what it brings, a remote server's address to add in Apps, and the "Not used by Spade" list.

## Not yet

- Starting a command from the composer: commands are in the store as manual skills, but the
  composer has no command picker yet.
- Remote servers are not added as connectors by themselves: the person adds the address.
- A server's `cwd` from the plugin is not used: every server runs in the bot's workspace.
