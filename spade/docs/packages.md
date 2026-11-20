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
  or queued while a switch was on never runs after the person turned it off. The call is read
  first (a command's files may be waited on), then checked and started, its first poll included,
  with every packaged bot over it held, so no switch changes in between.
- A send, payment or access change Spade's classifier reads in a call is stored with its verdict
  (`raised`): refused, not asked, when the package never declared it or the person turned it off,
  and held to again when a call the person allowed starts.
- A run's egress ticket is issued from the policy read in the same step, against a package commit
  that narrows what bots reach; the commit ends every live ticket whose policy is no longer what
  its bot would be issued (a host turned off while another stays on included).

A worker or helper under a packaged bot is held to every packaged bot above it. A bot a packaged
bot makes for the person (`bot_create {kind: standing}`) is held to its maker's ceiling: the one
it was made under is stored with it (`package_ceiling:<bot>`, in the bot's own transaction, and
moved with it), narrowed by its maker's as it is now while the maker is there. That stored ceiling is narrowed
to what its makers allow after every package commit and before the bot moves, so it never widens
again once the maker is gone or on another machine.

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
versions; a market bot only to versions of the same package the market signed, never to one
withdrawn while it had it (`withdrawn_hashes`), and back only to the version it had just before
(`previous`); taking the same version again doesn't end a withdrawal. An update keeps its proof
wherever it waits (held while the bot works, written down before a crash) and is taken again only
on it; one recorded with none, or whose proof no longer verifies, waits for the person to accept
the version again.

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
