# 0151: Spade keeps its own skills and runs the person's plugins

Status: accepted. Date: 2026-11-14. Decided by: the owner (2026-11-14: make Spade's agent harness
better, with skills, plugins and hooks, before the card redesign). Builds on
[ADR 0014](0014-plugins.md) (plugins), [ADR 0103](0103-skill-library.md) (ace's skill library),
[ADR 0130](0130-spade-skills-and-workspace.md) (skills a bot writes, the workspace),
[ADR 0131](0131-spade-connectors.md) (connectors) and [ADR 0140](0140-spade-cloud.md) (Spade
Cloud). Helpers, the other half of this work, are [ADR 0152](0152-spade-helpers.md).

## Context

A Spade bot reads skills only from ace's library, through the daemon socket. Three things follow:

- With ace away, and always on Spade Cloud, a bot has no skills at all, and a skill a bot writes
  there has nowhere to go.
- `skill_load` returns `SKILL.md` alone. A skill's other files (references, templates, scripts)
  never reach the bot, so most real skills work only half.
- Search matches words in names and descriptions, and the index lists the first 40 skills by name,
  so a large library offers the bot whatever sorts first.

The person's plugins (ADR 0014) bring skills, commands, agents, rules, MCP servers and hooks to
every coding CLI ace runs. Spade's bots get the plugins' skills through the library and nothing
else, and Spade can reach MCP servers only over HTTP, so a plugin's local server is out of reach.

## Decision

### Spade's skill store

1. **Spade keeps a skill store in its data folder:** `skills/<id>/` holds a skill's `SKILL.md` and
   its files, indexed in Spade's SQLite. Each skill has an origin:
   - `ace`: a copy of a skill in ace's library, read only;
   - `spade`: a skill written in Spade, by a bot's proposal or by the person;
   - `plugin`: a skill from a plugin the bot is allowed (point 8), read only.
2. **The ace copies follow the library.** While ace is there, Spade lists the library and fetches
   a skill whose hash changed, its files included, on start and on each change notice. The copy
   is replaced whole, written beside the old one and renamed over it. A skill the library no longer
   has is dropped. With ace away, the last copy is used and says nothing; there is no "stale" state
   to show.
3. **A saved proposal goes to ace when ace is there**, as ADR 0130 says, so every agent can use
   it; the store then copies it like any library skill. With ace away (and always on Cloud), it is
   saved in the store with origin `spade`. Spade never pushes a `spade` skill to ace on its own;
   Settings offers **Add to ace's library** on each one, which creates it there and drops the
   store's copy once the library has it.
4. **The daemon gives a skill's files.** `skills.request` gains a `files` operation: a skill's
   relative paths, sizes and hashes, and the content of one file by path. Paths are the library's
   own, checked the same way as plugin paths. Files over 1 MB, and more than 200 files, are left
   out with a note.
5. **Loading a skill brings its files.** `skill_load` answers with `SKILL.md`, a list of the
   skill's other files, and the folder they are in: `skills/<name>/` inside the bot's workspace,
   written there (read only) when the skill is loaded and replaced if the skill changed. The bot
   reads them with the workspace tools and runs a skill's scripts with `shell`, under the same
   gate as any command. These files are trusted: the person installed the skill. Each one is
   recorded with its hash in the workspace's trust record (ADR 0130, point 8), so a script that
   rewrites one makes it untrusted like any other file a command changed.
6. **Search ranks by text and use.** `skill_search` scores name, description and body (name above
   description above body, rarer words counting more), then breaks ties by how often this bot
   loaded the skill and marked it helpful. The index frozen into a conversation lists the 40 skills
   this bot used most, then by name; the bytes are still fixed when the conversation starts.
   Ranking is pure, in `spade-core`.
7. **Spade Cloud** has the store too, with `spade` skills only. It never reaches a person's
   daemon, so it has neither ace's skills nor plugins.

### Plugins

8. **The person allows plugins per bot**, as with connectors: a bot gets none until the person
   turns one on in that bot's settings. Only plugins accepted in ace are listed, at the version
   that was accepted; a plugin turned off in ace (`plugins.availability`) is off for every bot.
   A new plugin version needs accepting in ace again, as ADR 0014 already requires, before any bot
   sees it.
9. **Spade reads plugins from the daemon** over the socket: `plugins.list`, the components, and a
   new `plugins.spade` request that answers, for one accepted plugin, its components with their
   text and its executions (MCP servers and hooks) as accepted. Spade never reads the plugin's
   folder itself.
10. **Each component maps to something a bot already has:**
    - **skills** become store skills with origin `plugin`;
    - **commands** become manual skills: the person starts one from the composer, and the bot never
      loads one on its own;
    - **rules** without selectors join the bot's standing instructions, under the rule's name, in
      plugin and name order. They are frozen into a conversation when it starts, like the skill
      index, so the cached prompt top never changes mid-conversation. Rules with selectors are left
      out with a note in the bot's settings;
    - **agents** become helper profiles (ADR 0152);
    - **MCP servers** become tool sources (point 11);
    - **hooks** run at Spade's events (point 12).
      A component Spade cannot map is listed in the bot's settings as "Not used by Spade", with the
      reason.
11. **MCP servers from plugins.** A remote server is offered like a connector the person added by
    URL, signed in the same way. A local (stdio) server is a process Spade starts, which needs a
    new stdio transport in `spade-mcp`:
    - it runs in the bot's workspace folder, with the shell's built environment (ADR 0130, point 6)
      plus the variables the plugin declared, never Spade's own; in its own process group on macOS
      and Linux and a kill-on-close job object on Windows;
    - one process per bot and server, started on the first tool search or call, stopped after 10
      minutes unused and when Spade stops; a crash is restarted on the next use, at most 3 times in
      10 minutes, then the server says it failed until the person turns it off and on;
    - its tools are deferred, named `<plugin>__<tool>`, risk from their annotations (unlabelled
      means write), and output untrusted, as connectors' are.
12. **Hooks** are the plugin's commands, run at these events, with the event as JSON on stdin and a
    10-second limit, in the bot's workspace with the shell's environment:

    | Plugin event       | Spade event                 | What its answer can do                |
    | ------------------ | --------------------------- | ------------------------------------- |
    | `SessionStart`     | a conversation's first turn | add text to the standing instructions |
    | `UserPromptSubmit` | a person's message stored   | add text after the message            |
    | `PreToolUse`       | before the gate             | refuse the call, with a reason        |
    | `PostToolUse`      | a tool's result stored      | add text after the result             |
    | `Stop`             | a reply about to finish     | ask for one more step, with a reason  |
    | `PreCompact`       | before compacting           | nothing; it runs for its own effects  |

    `matcher` matches the tool name. Exit 0 with nothing on stdout changes nothing; exit 2 refuses
    or asks for more, with stderr as the reason; stdout on exit 0 is text to add; anything else is
    a failed hook, noted in the activity log, and the turn carries on. A hook can only make Spade
    stricter or add text: it never allows a call the gate would ask about. Text a hook adds is
    untrusted, since a hook may relay anything. `Stop` can extend a reply at most 3 times. What a
    hook did is stored as an event, so a rebuilt prompt is the same, and a hook never runs again
    on restart for an event it already answered. Other plugin events are listed as not used.

13. **Bots on CLI brains** (ADR 0133) get only skills and rules: their CLI runs its own MCP
    servers and hooks, and ace already gives the CLI the person's plugins.

## Consequences

- Skills work everywhere a bot runs, with their files, and the bot sees the ones it uses most.
- One plugin install reaches the coding CLIs and Spade's bots, under the same review.
- New daemon requests: `skills.request` `files` and `plugins.spade`, schemas in
  `packages/protocol`, mirrored in `spade-ace`.
- `spade-mcp` gains a stdio transport, kept beside the HTTP one, sharing the protocol code.
- Hooks and local servers are code the person installed, run with Spade's narrow environment, not
  in a sandbox. That matches how every CLI runs them; the review in ace is the trust step.

## Tests

- A skill saved with ace away lands in the store and is offered after a restart; with ace there,
  it goes to the library and the store copies it.
- A library skill's change notice replaces the copy and its files; a removed skill disappears.
- A loaded skill's files are in the workspace, readable without asking, and its script runs under
  the gate; one rewritten by a command reads as untrusted.
- Search ranks a body match below a name match and above nothing; the index favours used skills.
- A plugin turned on for one bot offers its tools to that bot only; turned off in ace, to none.
- A stdio server (a small real child process) lists tools, answers a call, is stopped when idle and
  restarted after a crash, and gets none of Spade's environment.
- A `PreToolUse` hook that exits 2 refuses the call with its reason; one that times out leaves the
  turn running; one that prints text adds untrusted text, after which a write asks.
