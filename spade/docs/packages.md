# Agent packages

A bot made from an agent package stays linked to it, so its maker can fix it and the person can
update or roll it back ([ADR 0200](../../docs/adr/0200-spade-is-an-agent-operating-system.md)
§3, §6.1). The package is the bot recipe of [teams.md](teams.md) at `version: 3`; a version 2
recipe still installs as an unlinked copy the person owns.

## The manifest

`bot.json`, read by `spade_core::package::read` (and `readRecipe` in `@ace/marketplace`, which
must agree). Version 3 adds, beside version 2's fields:

| Field      | What it is                                                                                                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requires` | `{runtime: "1", spade: "0.0.25"}`; a build that can't meet them refuses with "Needs a newer Spade"                                                                                              |
| `uses`     | Runtime modules (`task`, `memory`, `files`, `web`, `apps`, `agents`, `ui`, `schedule`, …)                                                                                                       |
| `triggers` | `message`, `mention {in}`, `schedule {name, instruction, schedule}`, `event {name, instruction, event}` (`thread.finished`, `thread.failed`, `thread.needs_you`), `webhook {name, instruction}` |
| `effects`  | `{effect, why, hosts?, grant?}` with `effect` one of `network`, `publish`, `send_as_person`, `pay`, `change_access`                                                                             |
| `limits`   | `spend_alert {usd_per_day}`, `workers_at_once`, `workspace_mb`: an alert line and bounds, never a stop                                                                                          |
| `pricing`  | `{kind: "free"}` only; missing reads as free                                                                                                                                                    |
| `tests`    | `tests/<name>.json` scenario files in the package                                                                                                                                               |

Version 2's `routines` read as schedule triggers. Refused whole: anything named or shaped like a
secret; `publisher`, `signature`, `hash`, `package` or a string `version` (identity is the signed
manifest's); `mcpServers`, `hooks`, `commands` and other executions (those are plugins'); the
`credential` effect; a grant other than `drive_site`, `drive_app` or `tool` (and any grant under a
send, payment or access change); any price but free. Fields this build doesn't know (`surfaces`
and `contracts` until phase 2) are kept by name and grant nothing.

## Effects: switches and a ceiling

Each declared effect is a switch on the install review, keyed `word`, `word:hosts:<sorted hosts>`
or `word:<grant kind>:<target>`. Only what the person leaves on becomes ADR 0167 state, recorded
`by: person`: hosts join the bot's egress allow list, a grant is made. Turning a switch off takes
back exactly what it made.

The gate (`spade_core::effect::route`, right after the credential refusal) refuses any call whose
effect the package didn't declare, or the person turned off: "Not run: Flight watcher doesn't
declare publishing." A driving step needs `network`. A declared send, payment or access change
still goes to the person each time. A worker or helper under a packaged bot is held to every
packaged bot above it.

## API

- `POST /v1/agents` with `recipe` (the published `bot.json`), `package {source, name, version,
hash}`, `switches {key: bool}` (missing is off), `grants`, `from_recipe`, `start_routines`:
  makes the linked bot. Schedule, event and webhook triggers start paused unless
  `start_routines`. A failure part-way removes the bot and whatever its switches made.
- `GET /v1/agents/{id}/package`: `{package}` with `version`, `previous`, `withdrawn {reason}`,
  `updating`, `effects [{key, effect, hosts, grant, why, on}]` and `limits`. The agent view carries
  the same under `package`.
- `POST /v1/agents/{id}/package/plan {recipe}`: `{plan}`, what moving to that manifest does:
  `name`, `task`, `face`, `personality` each `same`, `replace` or `kept` (the person or the bot
  changed it), routine steps (`add` paused, `replace`, `remove`, `kept`), `notes_kept`,
  `asks_more` (effect keys that start off) and `off`.
- `POST /v1/agents/{id}/package {recipe, package, transaction}`: applies an update or a
  rollback, the same path both ways. Refused with 409 while the bot works or waits. One step
  keyed by its transaction: asked again it does nothing twice, and one a crash cut short is taken
  again at the next start.
- `PUT /v1/agents/{id}/package/effects {key, on}`: the person turns one declared effect on or off.
- `POST /v1/agents/{id}/package/withdrawn {reason}` pauses the bot's routines with the reason;
  nothing is deleted. `DELETE` resumes what that pause stopped.

The person's conversation, notes they wrote, knowledge, workspace files, connections, grants and
settings are never in a plan. `workers_at_once` bounds the bot's workers under
`SPADE_WORKERS_AT_ONCE`, and `spend_alert` becomes the floor of its spend alert.

## The ten templates

The templates New bot offers are packages by ace, one folder each in `spade/templates/<id>/`
(`bot.json`, `README.md`, `tests/`), built into the binary ([teams.md](teams.md), Templates). A bot
made from one is linked to `{source: "spade", name: <id>, version, hash}`, the hash ADR 0014's over
the folder's files (the same `ace bot check` prints), so a later Spade's corrected template updates
it the way any package update does. The market's seed lists the same folders.

## Developer kit

ADR 0200 §9, in ADR 0178's grammar:

| Command                              | What it does                                                                                                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ace bot init NAME [--template T]`   | A package that passes check and test as written: `bot.json`, `README.md`, `skills/<name>/SKILL.md`, `cards/<card>.json`, `tests/`. Templates `blank`, `watcher`, `club-member`                                                       |
| `ace bot check [PATH]`               | `@ace/marketplace`'s checks with `readRecipe`, the reader that agrees with this one; every problem at its place, exit 1. Warns (never refuses) on a `why` under four words and on no tests                                           |
| `ace bot test [PATH]`                | Runs `spade --bot-test PATH` with a bare environment and prints its report; exit 1 when a scenario fails                                                                                                                             |
| `ace bot dev [PATH] [--spade DIR]`   | Installs the package as `local/<folder>` at `0.0.0-dev.N`, through `POST /v1/agents` with its declared switches on once the person said yes, then each save is checked and posted as an update; a save that asks for more asks again |
| `ace bot publish [PATH] --version V` | `check`, then `test`, then `ace market publish spade-bot PATH`                                                                                                                                                                       |

`ace bot dev` reaches the person's Spade through the daemon, or a development Spade directly by
its data folder (`server.json` and `token`). It is the person's: an agent's shell is refused.

### Scenarios

`spade --bot-test <folder>` reads `bot.json` with `spade_core::package::read` and each file its
`tests` names with `spade_core::package::scenario::read_scenario`, then runs each on a throwaway
Spade in a temporary folder: the real engine and install path, `spade-testkit`'s fake model on
loopback scripted by the scenario (titles and other plain calls get a fixed answer), no keychain,
ace, app or plugin. The bot is installed linked, every declared switch on, routines paused; each
approval is answered yes, as the developer would. Tools that would reach outside (`web_search`,
`web_fetch`, `research`, `shell`, `service_*`, `image_generate`, `git_push`, `pr_comment`,
`issue_comment`, `send_message`, `delegate`, and any name that isn't one of Spade's) are fakes
under their real names, read by the gate from the same table, answering the scenario's results.
Spade's own tools (notes, knowledge, files, plans, cards, routines) run for real in the temporary
folder. It prints `{name, problems, scenarios: [{file, name, passed, failures, calls}]}` and exits 0
when all pass, 1 otherwise, 2 for a wrong command line.

```json
{
  "name": "Remembers a trip to watch",
  "given": { "message": "Watch KTM to DEL in March, under $200." },
  "model": [
    {
      "calls": [{ "tool": "web_fetch", "arguments": { "url": "https://api.example-fares.com/" } }]
    },
    { "calls": [{ "tool": "memory_save", "arguments": { "text": "KTM-DEL, March, under 200" } }] },
    { "say": "I'll watch KTM to DEL and tell you when it drops under $200." }
  ],
  "tools": { "web_fetch": "KTM-DEL 182 USD" },
  "expect": { "calls": ["web_fetch", "memory_save"], "reply_contains": ["KTM to DEL"] }
}
```

- `given`: a `message`, or a `trigger` naming one of the package's schedule, event or webhook
  triggers (its routine runs now).
- `model`: one step per model call, `say` then `calls`; the last step only says something.
- `tools`: fake results by tool name, one or a list taken in turn; only tools that reach outside.
- `expect`: `calls` (ran, in this order), `not_called`, `effects` (asked for, as the gate read
  the calls), `refused` (the gate refused them), `cards` (words in a shown card's title),
  `reply_contains`. A refused call fails the scenario unless `refused` names it; an expected call
  that answered an error fails it; a card that didn't fit fails it. Unknown fields are a problem,
  so a typo never passes silently.
