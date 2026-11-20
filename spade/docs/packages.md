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

How the review starts them (`effectStartsOn` in `@ace/ui-core/spade-chat`): a package by ace starts
with what it declares on. One from anyone else starts with only `network` to the hosts it names on;
acting in pages or apps as the person (`drive_site`, `drive_app`), a `tool` grant, `network`
without hosts, `publish`, `send_as_person`, `pay` and `change_access` start off, and the review
says in one sentence why. A send, payment or access change the person turns on still asks each
time.

After install the same switches are rows in the bot's Security section, each with its `why`
(`PUT /v1/agents/{id}/package/effects`). Turning one on there is the person's grant, as on the
review; only what the package declared is listed, so the ceiling still refuses anything else.

The gate (`spade_core::effect::route`, right after the credential refusal) refuses any call whose
effect the package didn't declare, or the person turned off: "Not run: Flight watcher doesn't
declare publishing." It runs before any route of Spade's own (a bot made for the person, a club),
in every mode, Full access too. What it holds a call to:

- The call's effect as the gate reads it, and for a command that runs or asks to run outside the
  sandbox (`shell`, `service_start`), what the shell classifier read in it: `curl -X POST …` is
  `network`, `npm publish` or a deploy is `publish`, a send is `send_as_person`, a command it
  can't read whole is unresolved. A driving step needs `network`.
- A sandboxed command's reach is the sandbox's: with `network` off (or never declared) the bot's
  commands, terminal, services and plugin servers get no egress at all, whatever its own or the
  machine's allow list says, and runs that had egress lose it when the switch goes off.
- A call whose effect Spade can't resolve (an app's tool with no trusted declaration, a word this
  build doesn't know) is refused unless the sandbox holds it with nothing that reaches a server.
- A declared send, payment or access change, and anything unresolved the sandbox holds, goes to
  the person every call: no Always allow, typed grant (`git_push`, `pr_comment`) or kept answer
  carries to it.
- It is read again right before a call starts, so one decided, approved, held on a Reconnect card
  or queued while a switch was on never runs after the person turned it off.

A worker or helper under a packaged bot is held to every packaged bot above it. A bot a packaged
bot makes for the person (`bot_create {kind: standing}`) is held to its maker's ceiling: the one
it was made under is stored with it (`package_ceiling:<bot>`, in the bot's own transaction, and
moved with it), narrowed by its maker's as it is now while the maker is there.

`uses` narrows the bot to its modules' tools, the ones the turn loop answers itself included:
with `uses: []` there is no `tool_search`, `ask_user` or `app_connect_request`, and an app's or
plugin's own tools belong to `apps`. Every bot always has its conversation and reply, and Spade's
harness tools outside `spade.v1` (`decision_log`, the skill library's `skill_*`).

## Identity

A package's identity is the market's signed version manifest (ADR 0200 §3.2), checked by Spade
itself with the market keys this build ships (`spade/config/market-keys.json`, the same as
`shippedMarketKeys` in `@ace/marketplace`): Ed25519 over `ace-market-manifest-v1` and the body's
canonical JSON, its files' content hash, and the sha256 of `bot.json`'s exact text among them. A
`package` the caller sends is believed only when it matches. Without a signed manifest a version 3
package installs as a local package, `local/<name>` at version `local`: linked, so its ceiling
holds, but claiming no publisher and no market version. A local bot moves only between local
versions; a market bot only to versions of the same package the market signed.

## Install, update and switches, each one step

An install stores the bot and its link (the ceiling) in one transaction, marked `installing`;
routines are made paused, then apps, plugins and notes are added, the switches' grants and hosts
are committed with the link in one transaction, and only then do routines the person turned on
start. Nothing is scheduled for an installing bot, and one a crash left is removed, with what it
was allowed, at the next start before any work. An update, a rollback (held or not), a switch, a
withdrawal and its end each hold the bot's package from their first read to their commit, and
commit the link with the grants and hosts they make or take back in one transaction: a switch the
person turned off while an update waited stays off.

## API

- `POST /v1/agents` with `recipe` (the published `bot.json`), `envelope {signed, bot_json}` (the
  market's signed version manifest as served, and `bot.json`'s exact text), `package {source,
name, version, hash}` (checked against the envelope, refused without one), `switches {key:
bool}` (missing is off), `grants`, `from_recipe`, `start_routines`: makes the linked bot. Schedule, event and webhook triggers start paused unless
  `start_routines`. A failure part-way removes the bot and whatever its switches made.
- `GET /v1/agents/{id}/package`: `{package}` with `version`, `previous`, `withdrawn {reason}`,
  `updating`, `held {version}`, `effects [{key, effect, hosts, grant, why, on}]` and `limits`. The
  agent view carries the same under `package`.
- `POST /v1/agents/{id}/package/plan {recipe}`: `{plan}`, what moving to that manifest does:
  `name`, `task`, `face`, `personality` each `same`, `replace` or `kept` (the person or the bot
  changed it), routine steps (`add` paused, `replace`, `remove`, `kept`), `notes_kept`,
  `asks_more` (effect keys that start off) and `off`.
- `POST /v1/agents/{id}/package {recipe, envelope, package, transaction}` (the envelope as
  above; a local bot's without one): applies an update or a
  rollback, the same path both ways. While the bot works or waits on the person it isn't refused:
  it answers `202` with `held {version}`, the step is stored (`bot_package_held:<bot>`), and it is
  applied when the bot's turn ends with nothing of it working, or at the next start; a later one
  replaces one still held. The profile says "Updates when Flight watcher is done with its turn."
  One step keyed by its transaction: asked again it does nothing twice, the held record is cleared
  only after it committed, and one a crash cut short is taken again at the next start.
- `PUT /v1/agents/{id}/package/effects {key, on}`: the person turns one declared effect on or off.
- `POST /v1/agents/{id}/package/withdrawn {reason}` pauses the bot with the full pause of
  [autonomy.md](autonomy.md) "Pause, resume and the running view" (its work stops; wakes, routine
  slots and messages are held; services stop; through a restart) and records the reason; nothing
  is deleted. `DELETE` is Resume. Any Resume, the Running page's too, ends the withdrawal, and an
  update or rollback to another version resumes it.

The person's conversation, notes they wrote, knowledge, workspace files, connections, grants and
settings are never in a plan. `workers_at_once` bounds the bot's workers under
`SPADE_WORKERS_AT_ONCE`, and `spend_alert` becomes the floor of its spend alert.

## Reviews and moves

The daemon's review passes the running Spade's version to the market reader, so `requires.spade`
refuses a package before install ("Needs a newer Spade: 0.0.30 or later"), not only at Spade.

A move (ADR 0187) carries `bot_package:<bot>` and `bot_package_held:<bot>` with the bot's other
settings, so it keeps its link and installed version. At its next refresh the target's daemon
finds the linked bot it has no install for and fetches the pinned bytes by hash: from its own
store, else from the bot's source at that version, kept only when they hash to the link's. The
bot is then an install there: Update, Roll back and withdrawals reach it. A package already
installed there for another bot is left as it is.

## The ten templates

The templates New bot offers are packages by ace, one folder each in `spade/templates/<id>/`
(`bot.json`, `README.md`, `tests/`), built into the binary ([teams.md](teams.md), Templates). A bot
made from one is linked to `{source: "spade", name: <id>, version, hash}`, the hash ADR 0014's over
the folder's files (the same `ace bot check` prints), so a later Spade's corrected template updates
it the way any package update does. The market's seed lists the same folders.

## Developer kit

ADR 0200 §9, in ADR 0178's grammar:

| Command                              | What it does                                                                                                                                                                                                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ace bot init NAME [--template T]`   | A package that passes check and test as written: `bot.json`, `README.md`, `skills/<name>/SKILL.md`, `cards/<card>.json`, `tests/`. Templates `blank`, `watcher`, `club-member`                                                                                        |
| `ace bot check [PATH]`               | `@ace/marketplace`'s checks with `readRecipe`, the reader that agrees with this one; every problem at its place, exit 1. Warns (never refuses) on a `why` under four words and on no tests                                                                            |
| `ace bot test [PATH]`                | Runs `spade --bot-test PATH` with a bare environment and prints its report; exit 1 when a scenario fails                                                                                                                                                              |
| `ace bot dev [PATH] [--spade DIR]`   | Installs the package through `POST /v1/agents`, claiming no identity, so it is linked to the local package `local/<name>`, its declared switches on once the person said yes; then each save is checked and posted as an update; a save that asks for more asks again |
| `ace bot publish [PATH] --version V` | `check`, then `test`, then `ace market publish spade-bot PATH`                                                                                                                                                                                                        |

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
