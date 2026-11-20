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
