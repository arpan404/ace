---
name: make-a-bot
description: Write a Spade bot as an agent package the person can install, test offline and publish, with ace bot init, check, test, dev and publish.
---

# Make a bot

A Spade bot can be shipped as an **agent package**: a folder with a `bot.json` manifest, its own skills, cards and scenario tests. Installed, the bot stays linked to the package, so whoever made it can fix it and the person can update or roll it back. Use this skill when the person asks for a bot they can keep, share or publish, or asks you to fix one. The person describes what the bot should do; you write the package, prove it with its tests, and hand it to them to try.

The format is `spade/docs/packages.md`; the tools a bot has are `spade/docs/runtime.md` (`spade.v1`). Read them when a field or a tool isn't in this page.

## The commands

| Command                                                                   | What it does                                                             | Who runs it                                                                      |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `ace bot init NAME [--template blank\|watcher\|club-member] [--path DIR]` | Makes a package that already passes check and test                       | You                                                                              |
| `ace bot init --from BOT [--path DIR]`                                    | Makes a package of one of the person's own bots                          | You                                                                              |
| `ace bot check [PATH]`                                                    | The market's checks, with Spade's own reader: every problem at its place | You                                                                              |
| `ace bot test [PATH]`                                                     | Runs `tests/*.json` on Spade's engine with a scripted model, offline     | You                                                                              |
| `ace bot dev [PATH]`                                                      | Installs it here as a development bot, updated on every save             | The person                                                                       |
| `ace bot publish [PATH] --version V`                                      | Check, test, then the market's publish path; free only                   | You may make a draft (`--draft`); the person publishes if they asked to be asked |

Add `--json` to read results as data. Exit codes: 0 done, 1 a problem to fix (each listed as `path: sentence`), 2 the person must act, 64 the command line was wrong.

`ace bot dev` installs a bot that acts, so it is the person's: from your shell it answers `person_only`. Tell them to run it, and what they'll be asked.

## Steps

1. **Ask what it's for**, in one or two questions at most: what starts its work (they write to it, a time of day, an ace event, a mention in a club) and what it may do outside its own folder (read the web, change things in apps, send in their name, publish).
2. **Start from a template, or from their bot.** `ace bot init "Fare watcher" --template watcher`. `blank` answers messages, `watcher` adds a morning routine, a `network` effect and a card, `club-member` answers mentions. When the person already has a bot that does the job, start from it instead: `ace bot init --from "Fare watcher"` writes its task, face, personality, routines as triggers, the skills and apps it uses, and every effect its calls had. Each effect's `why` and the blurb say `TODO`: write them, and take out any effect the task doesn't need. Its conversation, notes, knowledge, workspace files, keys and grants stay with the bot; the README lists what else didn't carry over. A bot installed from someone else's package is refused: its maker's package is the one to change.
3. **Write `bot.json`.** Keep it plain JSON, no comments. The fields that matter most:
   - `task`: the standing instructions, in the second person ("You watch…"). Say what to do, when to speak up, and what never to do. At most 4000 characters.
   - `triggers`: `message`, `mention {in}`, `schedule {name, instruction, schedule}` ("daily at 7:00", "weekdays at 8:00" or cron), `event {name, instruction, event}` (`thread.finished`, `thread.failed`, `thread.needs_you`), `webhook {name, instruction}`. Routines arrive paused; the person turns them on.
   - `effects`: every effect beyond reading and writing its own folder, each with a `why` the install review shows beside its switch. Words: `network` (optionally `hosts`), `publish`, `send_as_person`, `pay`, `change_access`. Undeclared, a call is refused before any review: `Not run: Fare watcher doesn't declare publishing.` Declare only what the task needs, and write each `why` as a sentence about this bot ("Reads fares from the airline sites you name.").
   - `model`: `fast` or `capable`, never a model id: the person's own models run it.
   - `needs.connectors`: apps by catalogue id or https address, each with a `why`. Only the person connects them.
   - `skills`: `skills/<name>` folders in the package (ADR 0103's `SKILL.md`), or `spade-skill/<name>` from the market.
   - `tests`: the scenario files.
   - `pricing`: `{"kind": "free"}`; nothing else is offered.
4. **Never put in `bot.json`:** a key, token or password; `publisher`, `signature`, `hash`, `package` or a string `version` (the market's signed manifest says who and which version); `mcpServers`, `hooks` or `commands` (code runs only as a skill's script or through a plugin); the `credential` effect. `ace bot check` refuses each.
5. **Write scenarios** in `tests/<name>.json`, one behaviour each:

   ```json
   {
     "name": "Remembers a trip to watch",
     "given": { "message": "Watch KTM to DEL in March, under $200." },
     "model": [
       {
         "calls": [
           { "tool": "web_fetch", "arguments": { "url": "https://api.example-fares.com/ktm-del" } }
         ]
       },
       {
         "calls": [
           {
             "tool": "memory_save",
             "arguments": { "text": "Watch KTM to DEL in March, under 200 USD." }
           }
         ]
       },
       { "say": "I'll watch KTM to DEL and tell you when it drops under $200." }
     ],
     "tools": { "web_fetch": "KTM-DEL 182 USD" },
     "expect": { "calls": ["web_fetch", "memory_save"], "reply_contains": ["KTM to DEL"] }
   }
   ```

   `given` is a `message` or a `trigger` (a schedule, event or webhook trigger's name). `model` is what the scripted model answers, one step per model call: words in `say`, then `calls`; the last step only says something. `tools` are fake results for tools that would reach outside (web, shell, sends, app tools); they never run. `expect` may name `calls` (in order), `not_called`, `effects` asked for, `refused` (calls the gate must refuse), `cards` (words in a shown card's title) and `reply_contains`. A call the gate refuses fails the scenario unless `expect.refused` names it.

6. **Check and test until both pass:** `ace bot check`, then `ace bot test`. Fix each `path: sentence` where it points. A scenario's failure says what happened instead ("web_fetch ran and answered an error: …"); read it before changing the test.
7. **Hand it over.** Tell the person the folder and to run `ace bot dev` there: it installs the bot here with every declared effect as a switch they approve once, routines paused, then applies each save. A save that adds an effect, a trigger kind or an app asks them again. The development bot shows "Development" in their list and belongs to the folder: renaming it in `bot.json` renames the same bot, while copying the folder elsewhere makes a second one.
8. **Publish only when asked.** `ace bot publish --version 1.0.0 --draft` runs the check and the tests, then uploads a draft and prints its scan. Publishing the draft (`ace market draft publish ID`) may be the person's to approve.

## When something fails

| You see                                                           | Do                                                                                |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `effects[0].why says in a sentence why it needs this`             | Add the `why`: one sentence the review shows                                      |
| `effects[0].why still says TODO`                                  | Write what the bot does with it, or take the effect out                           |
| `X was refused: … doesn't declare …`                              | Declare the effect, or name the tool in `expect.refused` if refusing is the point |
| `X ran and answered an error: The arguments do not fit this tool` | Give the call the tool's real arguments (`spade/docs/runtime.md`)                 |
| `A card didn't fit and wasn't shown: …`                           | Fix the card's blocks at the place named                                          |
| `tests.web_fetch: Spade runs …`                                   | Only tools that reach outside take fake results; let Spade's own run              |
| `Spade's program isn't on this machine`                           | Ask the person to install Spade, or set `ACE_SPADE_BIN`                           |
