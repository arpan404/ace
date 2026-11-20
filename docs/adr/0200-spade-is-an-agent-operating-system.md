# 0200: Spade is an agent operating system

Status: accepted. Date: 2026-11-20. Decided by: the owner (2026-11-20: "go for it", taking every
recommendation under Decided below). Direction from the owner
(2026-11-19 and 2026-11-20): "make our spade a true agentic OS: an operating system of
agents/intelligence so people can buy/sell at 0 or priced money (initially no paid stuff). A
sophisticated system that can run agents and systems, like a traditional OS handles application
software." Already decided: Spade is the agent OS, under its own name, and paid listings are out
of scope for now, though the format must leave room for them.

Builds on [ADR 0126](0126-spade-agents.md) (bots), [ADR 0129](0129-spade-routines.md)
(routines), [ADR 0130](0130-spade-skills-and-workspace.md) (the workspace),
[ADR 0131](0131-spade-connectors.md) (apps), [ADR 0132](0132-spade-teams.md) (clubs,
templates, bot files), [ADR 0151](0151-spade-skills-and-plugins.md) (skills and plugins),
[ADR 0158](0158-spade-no-fixed-step-or-time-limits.md),
[ADR 0159](0159-spade-goals-plans-and-verification.md),
[ADR 0160](0160-spade-wake-and-owned-services.md),
[ADR 0161](0161-spade-orchestration-trees.md), [ADR 0163](0163-spade-auto-review-only.md),
[ADR 0164](0164-spade-knowledge-and-episodes.md),
[ADR 0166](0166-spade-has-no-spending-limits.md),
[ADR 0167](0167-spade-security-boundaries.md), [ADR 0171](0171-spade-decides-on-effects.md),
[ADR 0172](0172-spade-classifies-calls-with-its-own-model.md),
[ADR 0187](0187-spade-bots-move-between-machines.md),
[ADR 0195](0195-spade-reaches-the-person.md),
[ADR 0197](0197-spade-bots-start-from-one-message.md) and
[ADR 0198](0198-address-bots-clubs-and-agents-from-a-thread.md); on the market,
[ADR 0168](0168-ace-marketplace.md), [ADR 0174](0174-market-publishers-discovery-and-scanning.md)
and [ADR 0178](0178-one-cli-grammar-interactive-home-and-market.md) §11 and §12; on the screen,
[ADR 0077](0077-interactive-visualizations.md) (sandboxed pages in chat) and
[ADR 0150](0150-suits.md) (Suits). If accepted, it amends ADR 0168 §5 (the bot recipe gains
version 3) and §8 (a bot installed from a version 3 package stays linked to it and can update).

## Context

Spade already has most of an operating system. It grew one decision at a time:

- **Processes.** Bots, each one conversation (0126). Workers and helpers in a tree, whose state
  rolls up (0152, 0161). Tasks with a goal, a plan and a separate check of done (0159).
- **A scheduler.** Routines on a schedule, an ace event or a webhook (0129). Wakes and waits
  (0160). Owned services. Retries that wait out an outage.
- **A kernel's security.** An OS sandbox per bot, an egress proxy, credentials kept out (0167).
  Every tool's effect declared once and decided on (0171). A small model and a reviewer for what
  the sandbox can't hold (0172, 0163). Grants that pass down as subsets.
- **Memory and files.** A workspace per bot with checkpoints. Notes, a knowledge base and
  episodes (0128, 0164). Trust labels and provenance on what came from outside.
- **Drivers.** The person's apps through their own MCP servers (0131). Plugins (0151). ace's
  browser, computer use, simulators and devices. Coding agents through ace's `delegate`.
- **Talking between agents.** `bot_message`, clubs (0132), worker reports (0161), `@` from an
  ace thread (0198), and parcels between agent threads (0182).
- **A package manager.** The market, signed and pinned on the device (0168, 0174, 0178).

What is missing is what makes these into a system other people can build for:

1. **No unit describes an agent completely.** A bot recipe (0168 §5) carries a task, a face, a
   model kind, scheduled routines, skills, plugins and needs. It can't say what else wakes the
   bot, which effects it will use, what it shows besides text, what other agents may ask of it,
   or how to check that it works.
2. **The maker can't fix an installed bot.** A recipe installs as a copy the person owns, and
   "bots don't update" (0168 §8). That suits a template. It doesn't suit an agent someone
   maintains: a publisher who fixes a bug can't reach anyone who installed it.
3. **There is no stable surface to build against.** A bot's tools are whatever this build ships.
   A recipe can narrow them (`needs.tools`), but nothing says which names will still be there
   next month.
4. **A bot can show only text and question cards.** Coding agents have sandboxed pages in chat
   (0077), and Suits have sandboxed scenes (0150). Bots have neither.
5. **Nothing shows everything that runs.** The tree (0161 §8), wakes and services (0160 §8), spend
   (0166 §2) and the egress log (0167 §3) each answer part of "what is each agent doing, and what
   is it costing me". Nothing puts them together, and there is no one place to stop, pause or
   remove an agent.
6. **Agents talk only in words.** `bot_message` and `group_ask` carry text, and a parcel carries
   bytes. One agent can't ask another for a typed answer and rely on its shape.

One rule shapes every decision below: **no parallel stack.** A packaged agent is a Spade bot. Its
calls go through the same gate. Its files live in the same workspace. Its schedule is routines
and wakes. Its listing is a market entry. This ADR adds a manifest, a versioned name for the
surface bots already have, a few tools, two kinds of screen surface, and views.

## Decision

### 1. Spade is the agent OS

- **One name.** Spade. No new brand, no new service, no new process and no new store.
- **Words.** In this ADR an **agent** is a Spade bot. An **agent package**, or **package**, is
  the folder that installs one. In the app the person keeps seeing "bot" until the owner says
  otherwise (open question 5). "Apps" keeps its meaning in Spade today, the person's connected
  services (0131, ADR 0193's catalogue), so a package is never called an app.
- **The person is the only administrator.** Their standing comes from ADR 0190's proof (the app
  signed in as them, or a device paired from their link). No package, bot or host-token process
  ever has it.

### 2. Today's pieces, as an operating system

| OS part               | What does it in Spade today                                                                                                                                                                    | Decided in                   | What this ADR adds                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------- |
| Kernel and security   | OS sandbox per bot, egress proxy, credential deny-list; effects declared per tool and routed; the classifier; auto-review or Full access; grants; taint and provenance; the person's approvals | 0163, 0167, 0171, 0172       | A package's declared effects as a ceiling, and install-time switches (3.4) |
| Users and permissions | The person, by proven standing; per-bot security settings; grants that pass down as subsets                                                                                                    | 0161, 0167, 0190             | Nothing new: a package never gets standing                                 |
| Processes             | Bots, bot workers, helpers, ace coding agents in one tree; rolled-up state                                                                                                                     | 0126, 0152, 0161             | A `paused` state, lifecycle verbs, a task manager (6)                      |
| Programs              | A bot's task, skills (scripts run in the sandbox), routines, notes                                                                                                                             | 0126, 0130, 0151, 0197       | One manifest for all of it (3)                                             |
| Scheduler             | Routines (schedule, ace event, webhook), the heartbeat, wakes and waits, parked retries, owned services, workers at once                                                                       | 0129, 0158, 0160, 0161       | Triggers in the manifest, mapped onto routines (3.5)                       |
| Memory                | One conversation with compaction; notes; knowledge base; episodes; history search                                                                                                              | 0126, 0128, 0158, 0164       | Nothing new: the `memory` module names it (4)                              |
| File system           | A workspace per bot, consented folders, checkpoints, the trust record                                                                                                                          | 0130, 0142, 0167             | Nothing new: the `files` module names it (4)                               |
| Drivers               | Apps through their MCP servers; plugin servers; ace's browser, screen, simulators, devices; coding agents through `delegate`; CLI brains                                                       | 0131, 0133, 0142, 0151, 0198 | Nothing new: the `apps`, `devices` and `agents` modules name them (4)      |
| IPC                   | `bot_message`, `group_ask`, clubs, worker messages and reports, `@` from threads, asks to bots on other machines, parcels between agent threads                                                | 0132, 0161, 0182, 0198       | Typed contracts (7)                                                        |
| Shell                 | The chat and composer, question cards, voice, `@` mentions, notifications and quiet hours, digests and the brief, the `ace` CLI                                                                | 0134, 0154, 0165, 0178, 0195 | Cards and panels an agent ships (5)                                        |
| Display               | Suits for the whole app; sandboxed pages in coding-agent chats                                                                                                                                 | 0077, 0150                   | Per-agent style inside the Suit (5.3)                                      |
| Runtime library       | Spade's built-in tools, each with an effect in `spade_core::effect`                                                                                                                            | 0171                         | `spade.v1`: the same tools, versioned (4)                                  |
| Package manager       | The market: signed versions, pinned hashes, scans, publishers, withdrawals; plugins; the skill library                                                                                         | 0014, 0103, 0168, 0174, 0178 | Packages that update and roll back (6.1, 8)                                |
| Accounting            | Spend per call in the ledger, spend alerts, the egress log, the activity log                                                                                                                   | 0162, 0166, 0167, 0195       | One running view, and a package's expected spend as its alert line (3.6)   |
| Distributed           | The fleet; asks to bots on other machines; bot moves; where Spade lives; transfers over every route                                                                                            | 0132, 0187, 0192             | A moved bot keeps its package link (3.8)                                   |

The table is a map, not new design. Everything in its last column is defined below.

### 3. The agent package, format v1

#### 3.1 One format: the bot recipe at version 3

- The package is ADR 0168's bot recipe, `bot.json` with `format: "spade-bot"`, raised to
  `version: 3`. The market type stays `spade-bot`. There is no second format for the same thing.
- A version 2 recipe reads as a version 3 package with its routines as schedule triggers and
  nothing else new. It installs as it does today, as a copy the person owns (3.9). A version 1
  bot file keeps ADR 0132's import between the person's own machines.
- A package is a folder, held to ADR 0103's limits (512 files, 4 MiB a file, 16 MiB in all, no
  links or submodules):

```
flight-watcher/
  bot.json                    the manifest
  README.md                   the listing's long description
  assets/preview.png          the listing's picture
  skills/fares/SKILL.md       a skill shipped inside (ADR 0103's format)
  cards/fare-drop.json        a card's schema and layout (5.1)
  panels/watchlist/index.html a panel's page and its files (5.2)
  contracts/cheapest-fare.json a contract's input and output schemas (7)
  tests/watch-a-trip.json     a scenario test (9)
```

#### 3.2 Identity comes from the signature, never from the file

- A package's identity is its market entry: `spade-bot/<name>` at its source, with its version,
  publisher and content hash, all read from the signed version manifest (0168 §6).
- `bot.json` carries no publisher, version or signature. A file that has one of those fields is
  refused, so a file can't claim to be someone else's.
- From a git catalog the identity is "From <address>" at a commit, unsigned, as 0168 §4 says.
- In development (`ace bot dev`, 9) it is `local/<folder>`. It is never listed and never leaves
  the machine.
- Verified publishers and "By ace" are ADR 0174's (§13, §14), unchanged.

#### 3.3 The manifest

A complete example, a "Flight watcher" that watches fares and says when one drops:

```json
{
  "format": "spade-bot",
  "version": 3,
  "requires": { "runtime": "1", "spade": "0.0.25" },
  "name": "Flight watcher",
  "blurb": "Watches fares for the trips you name and tells you when one drops.",
  "task": "You watch flight fares for the person. For each trip they name, keep the route, the dates and the most they'd pay in your knowledge base. Check fares when your routine fires. Tell the person only about a real drop, with the fare and the link. Never book or pay.",
  "face": { "kind": "character", "body": "bird", "pair": "sky" },
  "style": { "accent": "#2F7BEA" },
  "personality": { "tone": "concise" },
  "model": "fast",
  "uses": ["task", "memory", "files", "web", "apps", "ui", "schedule", "agents"],
  "triggers": [
    { "kind": "message" },
    {
      "kind": "schedule",
      "name": "Morning check",
      "instruction": "Check every watched trip. Tell me only about drops.",
      "schedule": "daily at 7:00"
    },
    { "kind": "mention", "in": ["threads", "clubs"] }
  ],
  "skills": ["skills/fares", "spade-skill/airport-codes"],
  "plugins": [],
  "needs": {
    "connectors": [
      {
        "id": "example-calendar",
        "why": "Finds trips already on your calendar.",
        "required": false
      }
    ]
  },
  "effects": [
    { "effect": "network", "hosts": ["api.example-fares.com"], "why": "Reads fares." },
    { "effect": "send_as_person", "why": "Can draft a mail to your travel agent. You send it." }
  ],
  "limits": { "spend_alert": { "usd_per_day": 0.5 }, "workers_at_once": 2 },
  "surfaces": [
    { "id": "fare-drop", "kind": "card", "file": "cards/fare-drop.json" },
    {
      "id": "watchlist",
      "kind": "panel",
      "file": "panels/watchlist/index.html",
      "title": "Watched trips"
    }
  ],
  "contracts": [
    {
      "name": "cheapest_fare",
      "summary": "The cheapest fare seen for a route this week.",
      "file": "contracts/cheapest-fare.json",
      "effects": []
    }
  ],
  "tests": ["tests/watch-a-trip.json"],
  "notes": ["The person books. Never press a purchase button."],
  "pricing": { "kind": "free" }
}
```

Connector ids come from Spade's catalogue (`spade/config/connectors.json`); `example-calendar`
stands in for one here.

| Field                                                            | What it is                                                                                                                        | Rides on                  |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `requires.runtime`, `requires.spade`                             | The runtime API's major version (4) and the oldest Spade build it needs. A build that can't meet them lists "Needs a newer Spade" | 0168 §1's rule for types  |
| `name`, `blurb`, `task`, `face`, `personality`, `model`, `notes` | Unchanged from version 2. `model` is `fast` or `capable`, never a model id: the person's own models are used                      | 0126, 0162, 0168 §5, 0197 |
| `style`                                                          | The agent's accent (5.3)                                                                                                          | 0150's checks             |
| `uses`                                                           | Runtime modules the agent uses (4). Narrows its tools to those modules. Unset: all of them                                        | 0161 §3 (tools narrow)    |
| `triggers`                                                       | What starts its work (3.5)                                                                                                        | 0129, 0198                |
| `skills`, `plugins`, `needs.connectors`, `needs.tools`           | Unchanged from version 2                                                                                                          | 0151, 0131, 0168 §5       |
| `effects`                                                        | Effects it may use, each with a reason: a ceiling the person grants into (3.4)                                                    | 0167 §5, 0171             |
| `limits`                                                         | What it expects to spend and use, and how many workers it runs at once (3.6)                                                      | 0161 §10, 0166, 0195      |
| `surfaces`                                                       | Cards and panels it ships (5)                                                                                                     | 0077, 0150                |
| `contracts`                                                      | Typed calls other agents may make to it (7)                                                                                       | 0158 §2's jobs, 0161      |
| `tests`                                                          | Scenario tests it ships (9)                                                                                                       | `spade-testkit`           |
| `pricing`                                                        | `{"kind": "free"}` only, for now (3.7)                                                                                            |                           |

Unknown fields are kept as raw data and listed on the review as "Not used by this Spade". They
are never fatal. Because capabilities come only from fields this build knows, an unknown field
can't grant anything.

#### 3.4 Declared effects: a ceiling the person grants into, enforced by the gate

This is the phone-permission model on top of ADR 0171's effects.

- **What a package declares.** `effects` lists every effect its bot may use beyond `read` and
  `write_local`, which every bot has inside its sandbox. Each entry has a `why`, which the review
  shows. The words are ADR 0171 decision 3's: `network`, `publish`, `send_as_person`, `pay` and
  `change_access`. A package that declares `credential` is refused at the check.
- **A ceiling.** When a packaged bot makes a call whose effect its package didn't declare, the
  gate refuses it before any review: `Not run: Flight watcher doesn't declare publishing.` It
  narrows the bot the way `needs.tools` already narrows its tools, one level down. The call's
  effect is the gate's own reading (the built-in table, an app's annotations or catalogue entry,
  a plugin's execution entry, the purchase-button rule), never what the package says a call does.
- **Not a key.** Declaring an effect grants nothing. On the install review each declared effect
  is a row in plain words with a switch ("Reaches api.example-fares.com to read fares"). What
  the person leaves on becomes ordinary ADR 0167 state on the new bot, recorded `by: person`:
  - `network` with `hosts` adds those hosts to the bot's egress allow list (0167 §3). Without
    `hosts`, the bot's commands keep the machine's policy, and app and plugin writes are reviewed
    as now.
  - A declared effect may ask for one of 0167 §5's grant kinds with its scope, for example
    `{"effect": "network", "grant": {"kind": "drive_site", "host": "www.example-air.com"}, "why": "…"}`.
    Its switch makes that grant. A grant the API refuses (a payment, a send, an access change, a
    sensitive place, a device) can't be asked for, and the check refuses the package.
  - `send_as_person`, `pay` and `change_access` can be declared and are never granted. The review
    says "It can ask you to send mail. You decide each time." At run time they go to the person,
    as ADR 0163 amendment 1 says.
  - A switch the person turns off narrows the ceiling too: that effect is undeclared for this
    bot. The person can turn effects off later in the bot's Security page, and turn on again only
    what the package declared. Turning one on there is the person's grant, as on the review.
  - **How the review starts them.** A package by ace starts with what it declares on. One from
    anyone else starts with only low-risk reaches on: `network` to the hosts it names. Its strong
    effects start off for the person to turn on: acting in pages or apps as the person
    (`drive_site`, `drive_app`), a `tool` grant, `network` without hosts, publishing, and the
    person-only effects (sending as the person, paying, changing access). The person-only ones
    still go to the person each time once on.
- **Everything else is decided as for any bot.** A packaged bot starts on the auto-review. A
  package can't ask for Full access; turning it on is the person's, per bot (0163 amendment 2).
  The sandbox, taint, provenance, the classifier and the reviewer are unchanged. The ceiling is
  one more pure check in `spade_core::effect::route`, right after the credential refusal.
- **The task is the publisher's words.** A package's task sits in the bot's standing
  instructions, as a typed task does. The reviewer (0163) never reads it as the person asking for
  a step: the person's words come only from the person's own messages, as 0161 §7 already holds
  for a maker's brief.
- **Workers inherit the ceiling.** A worker a packaged bot makes is capped by its maker's grants
  (0161 §3) and by its maker's declared effects.

#### 3.5 Triggers

Each trigger maps onto something Spade already runs:

| Trigger    | Means                                                                | Becomes                                                                                                |
| ---------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `message`  | The person writes to it                                              | Its one conversation (0126). Every agent has it; listing it only says so                               |
| `schedule` | A time, as a phrase or cron                                          | A routine with a schedule trigger (0129 §1). Version 2's `routines` read as these                      |
| `event`    | An ace event: `thread.finished`, `thread.failed`, `thread.needs_you` | A routine with an ace-event trigger (0129 §8)                                                          |
| `webhook`  | Something outside posts                                              | A routine with a webhook trigger (0129 §1), on Spade's loopback API. Reaching it from outside is later |
| `mention`  | `@` from an ace thread, or a message in a club                       | Listed in the `@` picker (0198) and joinable to clubs (0132)                                           |
| `call`     | Another agent calls one of its contracts                             | Section 7. Implied whenever the package has contracts                                                  |

- Schedule, event and webhook triggers arrive paused. The review's "Start its routines" switch
  (0168 §8) covers all three and is off by default.
- A webhook's secret is made at install and never shipped: a package carries no secret (0168 §5).
- App events (a new mail, a changed calendar) aren't a trigger in v1. Apps are MCP servers and
  don't push. A schedule, or a `wait_for`, covers them until a push trigger has its own decision.

#### 3.6 Resource and spend: what a package bounds and what it only says

ADR 0166 stands: nothing stops, waits or is refused for spend, and Stop is the control (0158). A
package can't set a spending cap, and this ADR brings none back. `limits` holds:

- **`spend_alert {usd_per_day}`**: what the publisher expects the agent to cost a day. The review
  shows it ("Expected to cost about $0.50 a day on your fast model"), and it becomes this bot's
  floor for ADR 0195's spend alert. It is information and an alert, never a stop.
- **`workers_at_once`**: at most this many of its bot workers work at once, under
  `SPADE_WORKERS_AT_ONCE` (0161 §10). This is a concurrency setting, which 0161 allows.
- **`workspace_mb`**: the size the publisher expects its workspace to reach. The review shows it,
  and the task manager (6.3) says when the workspace passes twice that. Never a stop.

There is no step, time or turn limit (0158). Open question 2 asks the owner to confirm this is
what "resource and spend limits" should mean.

#### 3.7 Pricing

- `pricing` is `{"kind": "free"}`. It is the only value this build, the market's checks and the
  signer accept. `ace market check` refuses anything else: "Paid packages aren't offered yet." A
  missing `pricing` reads as free.
- **Room left for later.** `kind` is an open word, so a later build can accept others. A
  version's price would live in the signed version manifest beside its hash, so a listing could
  never change what someone agreed to. Payment, licences, refunds, payouts, tax and what a paid
  package may do offline belong to a later ADR. Nothing in this ADR reads a price.

#### 3.8 How today's formats fit

| Today                                 | In the package model                                                                                                                                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bot recipe, version 2 (0168 §5)       | Reads as version 3 and installs as today, as an unlinked copy                                                                                                                                                                                                       |
| Bot file, version 1 (0132 §13)        | Unchanged, between the person's own machines                                                                                                                                                                                                                        |
| The ten built-in templates (0132 §11) | Become version 3 packages by ace. They ship inside Spade, so New bot works offline, and in the market. Installed ones are linked, so ace can fix them                                                                                                               |
| Skills (0103, 0151)                   | Stay their own type and the one format for know-how. A package names `spade-skill` entries from its own source or bundles `skills/<name>/`, as recipes do today                                                                                                     |
| Plugins (0014, 0151)                  | Stay their own type: the one unit that carries runnable executions (MCP servers, hooks) and also reaches coding agents. A package names plugins and never embeds executions. A `bot.json` with MCP servers or hooks, or an executable outside `skills/`, is refused |
| Suits (0150)                          | Stay the look the person wears across ace. A package never ships a Suit; its own style is one accent (5.3)                                                                                                                                                          |
| Apps (0131)                           | Named by catalogue id or https address in `needs.connectors`. Only the person connects them                                                                                                                                                                         |
| Bot moves (0187)                      | A moved bot keeps its `package` link and installed version. The target fetches the pinned bytes by hash from its own registry or the source                                                                                                                         |

#### 3.9 A packaged bot stays linked to its package

- Installing a version 3 package makes a bot that records
  `package {source, name, version, hash}`, shown in its profile. Version 2 installs keep
  `from_recipe` and stay unlinked.
- **What the package owns:** the task as shipped, the face and style as shipped, the personality,
  the triggers' definitions, bundled skills, surfaces, contracts, declared effects, limits and
  notes. An update replaces these as a whole (6.1).
- **What the person owns, which no update touches:** the conversation, notes, knowledge,
  episodes, the workspace's files, connections, grants, the bot's settings (security, reach,
  autonomy), and any package-owned field the person or the bot changed: a `task_update`, a new
  name, an edited or paused routine. A field once changed is detached from the package. The update
  review says so: "You changed its task, so this update leaves it. See the new one."

### 4. The runtime API, `spade.v1`

#### 4.1 What it is

- The calls every agent gets are Spade's built-in tools, gated as they are today. `spade.v1` gives
  them a stable, versioned name: a list of modules, each a set of tools with fixed names,
  arguments, answers and effect.
- It is not an SDK, a library or a second process. A package's "program" is its task, its skills
  (whose scripts run with `shell`, in the sandbox), its triggers, its contracts and its surfaces.
  Nothing a package brings runs in Spade's process or the daemon's.
- It is one table in `spade_core`: module, tool, effect and `since` (the build that added it).
  This is the table `spade_core::effect` already reads for effects, given two more columns, so
  the API and the gate can't drift apart. It is published as `spade/docs/runtime.md`, and as JSON
  Schema the dev kit writes beside a package for editors.

#### 4.2 The modules

Names are today's tools on main. New tools are marked, with the section that defines them.

| Module     | Tools                                                                                                                                                                                                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task`     | `task_goal`, `task_plan`, `task_status`, `task_update`, `todo`, `profile_update`                                                                                                                                                                                           |
| `memory`   | `memory_save`, `memory_update`, `memory_forget`, `memory_search`, `knowledge_write`, `knowledge_update`, `knowledge_forget`, `knowledge_link`, `knowledge_merge`, `knowledge_read`, `knowledge_search`, `episode_search`, `history_read`, `history_search`, `about_person` |
| `files`    | `workspace_list`, `workspace_read`, `workspace_search`, `workspace_write`, `workspace_edit`, `document_read`, `share_file`, `shell`, `service_start`, `service_status`, `service_logs`, `service_stop`                                                                     |
| `web`      | `web_search`, `web_fetch`, `research`                                                                                                                                                                                                                                      |
| `apps`     | `apps_find`, `app_connect_request`, `tool_search`, `call_tool`, and the connected apps' and allowed plugins' own tools (deferred, gated, untrusted)                                                                                                                        |
| `agents`   | `bots_list`, `bot_message`, `group_ask`, `club_add`, `bot_create`, `worker_message`, `worker_status`, `worker_result`, `worker_stop`, `helper`, ace's `delegate`; new: `contracts_find`, `contract_call`, `contract_return` (7)                                            |
| `ui`       | The reply, `ask_user` (question cards, 0154), `image_generate`; new: `card_show`, `panel_update` (5)                                                                                                                                                                       |
| `schedule` | `routines_list`, `routine_save`, `routine_delete`, `sleep_until`, `wait_for`, `wake_cancel`                                                                                                                                                                                |
| `devices`  | ace's `browser_*`, `screen_*` and `sim_*` tools, and a device named with `@` (0198 §10, §11)                                                                                                                                                                               |
| `outward`  | `git_push`, `pr_comment`, `issue_comment`, `send_message` (0171 decision 2)                                                                                                                                                                                                |
| `notify`   | New, phase 2: `notify {title, body}`, a proactive notice under ADR 0195's quiet hours, do not disturb and budget. Until then a bot reaches the person as it does today: a reply from a routine that says something, a question, a finished goal                            |

Harness internals (compaction, titles, the check of done) aren't API.

#### 4.3 Versions and stability

- **A minor change** adds a tool, an optional argument or a field in an answer. A package that
  requires runtime `1` keeps working, and `requires.spade` names the build whose additions it
  needs.
- **A major change** renames or removes a tool, changes what an argument means or an answer's
  shape, or gives a tool a stronger effect. That is `spade.v2`. Spade keeps each v1 name working
  as an alias onto v2 for at least six months and while any listed package still requires v1,
  with a note in `runtime.md`. Suit parts follow the same rule over a shorter horizon (0150).
- A test walks the table and fails when a v1 tool goes missing or its effect gets stronger
  without an alias, as the Suit parts test does for parts.
- `uses` narrows the bot's tool index to its modules, so a small agent also costs fewer tokens.

#### 4.4 What it rides on

| A call to…     | Goes through                                                                       |
| -------------- | ---------------------------------------------------------------------------------- |
| Anything       | The gate: the ceiling, then 0171's routes, the sandbox, the reviewer or the person |
| Files, `shell` | The bot's workspace and sandbox (0130, 0167)                                       |
| Memory         | Spade's store, with Spade's trust labels (0164)                                    |
| Schedule       | Routines and wakes, event-sourced, fired once (0129, 0160)                         |
| Agents         | The tree, clubs and asks, exactly once by key (0132, 0161)                         |
| UI             | Events the clients already fold (`packages/ui-core/src/spade-chat`)                |
| ace's tools    | `spade-ace`, naming the acting bot (0142 §3)                                       |

### 5. Agent UI surfaces

Two kinds, in this order: cards everywhere first, then panels on web and desktop.

#### 5.1 Cards: data the agent sends, drawn by ace

- **A card is a typed value, not a page.** The package's card file holds a JSON Schema for the
  card's data (a bounded subset: objects with known fields, strings with a length, numbers,
  booleans, enums, arrays with a size; at most six levels deep) and a layout built from ace's own
  parts: `title`, `fields` (label and value rows), `table`, `list`, `metric`, `progress`, `image`
  (a workspace file, by hash), `link` (https only, shown with its host) and `actions`.
- **`card_show {surface, data, replaces?}`** puts a card in the conversation as its own row.
  Spade checks `data` against the schema before storing it. A card that doesn't fit is refused to
  the bot with the problems and never shown half drawn. `replaces` updates an earlier card from
  the same bot in place, so a fare can tick down. Every version is an event; the chat shows the
  latest.
- **Actions are fixed kinds.** `choose` sends the action's label back as the person's choice,
  stored as `card_action {card, action}`. The label is fixed when the card is shown, so pressing
  means exactly what it says. `open` opens a link (ace shows the host first) or one of the
  package's panels. Nothing a card does runs anything on its own.
- **Drawn by every client, the iPhone included.** A card holds no code, so it needs no sandbox
  and draws natively. Cards follow the person's Suit as a `card` part with the variant
  `spade-agent`. Status colours, the Working line and approvals stay ace's own (0150's guard).
- Card text is the bot's output, as its reply is. A card whose data came from a page or an app is
  tainted like the reply would be.

#### 5.2 Panels: a sandboxed page the package ships

- **What it is.** An HTML page in the package (`panels/<id>/`). It opens beside the bot's
  conversation, from the bot's header, its profile or a card's `open` action. Web and desktop
  only at first; the phone apps show the agent's cards.
- **Isolation is ADR 0077's, unchanged.** An opaque-origin `sandbox="allow-scripts"` frame,
  `default-src 'none'`, no network, no storage, no daemon socket and no access to the host page.
  On desktop it runs in the in-memory session that cancels every request. On the web it gets 0077
  layers 1 and 2, with 0077's documented residual risk. Its files are served by content hash, as
  a Suit's are (0150).
- **Typed messages only.** One `postMessage` channel, each message checked with Zod on the host:
  - into the page: `init {runtime: "1", tokens, scheme, reduceMotion, size}`, `theme` when the
    person's Suit or scheme changes, and `state {data}`, which the bot sets with
    `panel_update {surface, data}`, checked against the panel's declared schema;
  - out of the page: `height`, and `action {name, value}` for an action the panel declares, its
    value checked against that action's schema.

  A panel action reaches the bot as `panel_action`, the person's input in its own conversation,
  and anything the bot does about it goes through the gate. Nothing else crosses. A page can't
  call tools, read the conversation or open a link by itself; a link is a card's `open` action.

- **Follows the Suit.** The page gets the person's theme tokens on `init` and on every change, as
  visualizations do (0077: "only theme crosses in").
- **Bounded.** One open panel per bot and at most four per window, loaded only while visible, as
  0077 §5 bounds pages. A page that throws or stalls three times is stopped: "The panel stopped."
- A panel is code that runs only in its frame. Like a Suit's scene, it is reviewed per version.

#### 5.3 Per-agent skills and style

- **Skills per agent.** A bundled skill serves only its bot and is first in its index. Store
  skills keep serving every bot (0151 §6).
- **Style per agent.** `style` is one `accent` colour, checked for contrast against the person's
  current Suit as ADR 0150 checks a Suit's accent. One that fails falls back to the face's pair
  colour. The accent tints only the bot's own marks: its face ring, its card's title rule, its
  panel's header, its row in lists. It never colours status, approvals, the Working line or a
  waiting marker. No fonts and no CSS.

### 6. Process model

#### 6.1 Lifecycle

| Verb      | What happens                                                                                                                                                                                                                              | Built on                   |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Install   | `prepare`, the review, `install`: bundled skills and named entries first, then the bot, all or nothing. Triggers start paused, apart from `message`, `mention` and `call`                                                                 | 0168 §8                    |
| Start     | Turns its schedule, event and webhook triggers on. Writing to the bot starts work too                                                                                                                                                     | 0129                       |
| Stop      | Ends the current work and everything under it, now. Triggers stay on                                                                                                                                                                      | 0158, 0161 §9              |
| Pause     | Stop, and then hold: triggers don't fire, open wakes are kept but don't fire, owned services stop, messages and calls to it queue. Survives a restart                                                                                     | 0160, new state            |
| Resume    | Ends a pause. Wakes that came due fire once, missed routine slots catch up once, queued messages and calls are delivered in order                                                                                                         | 0129 §4, 0160 §3           |
| Update    | The review shows what changed: files added, changed and removed, executables flagged, and "Asks for more" for any new effect, trigger kind, contract, plugin or app. New ones start off. Applies at the bot's next turn, once it is still | 0126 §4, 0168 §8, 0187 §15 |
| Roll back | The previous accepted version, from the registry's pinned bytes, by the same path as an update. Needs no network                                                                                                                          | 0168 §6                    |
| Uninstall | Removes what the package owns. The person picks: delete the bot (named workers first, as 0161 §11 asks), or keep it as their own unlinked bot                                                                                             | 0161 §11                   |
| Withdrawn | A withdrawn version's bot is paused with the reason, never deleted. The person can resume it, roll it back or uninstall it. This replaces 0168 §6's "left alone" for linked bots only                                                     | 0168 §6                    |

- The registry keeps the last two accepted versions of each package, so a rollback always has
  something to go back to.
- Updates and rollbacks are never applied on their own, as no market entry is (0014, 0168).

#### 6.2 States, and never showing done while anything works

- The bot's state stays the rolled-up one (0161 §5), with `paused` added below `sleeping`:
  `waiting` if anything under it waits on the person, else `working`, else `sleeping`, else
  `paused`, else `idle`. A paused bot whose stopped work left a question open still reads
  `waiting`.
- A bot being updated or rolled back reads `updating`, which counts as working.
- A caller reads `working` while a contract call it made is open, and `waiting` if the callee is
  waiting on the person for that call, as an ace child does today (7).
- **Restarts.** Spade's recovery is unchanged: open turns carry on, wakes re-arm, `keep` services
  restart, jobs left running report an unknown outcome (0158, 0160). An update or rollback is one
  transaction keyed by its id. A crash before it commits leaves the old version, and the step is
  taken again from the start, as a move's are (0187 §14). A contract call is event-sourced and
  delivered once by key.
- **Failing agents.** Transient failures wait and retry with backoff (0160 §6). A permanent one
  is reported and the bot reads `failed` in the task manager with the reason. Nothing disables a
  bot on its own.

#### 6.3 The task manager

- **One view of everything that runs**, a page in Spade called Running. It has one row per bot,
  with its workers under it as in the tree. Each row shows:
  - its state in words: "Checking fares", "Sleeping until 7:00", "Waiting on you: send a mail",
    "Paused", "Failed: the fares site refused the key";
  - what it uses now: open calls, background jobs, helpers, workers, owned services;
  - spend today and this month (0166 §2), the network today (bytes and hosts, from the egress log),
    and the workspace's size;
  - its package and version, and "Update" when there is one.

  Actions are text buttons: Stop, Pause or Resume, Open. Rows sort by needs you, working,
  sleeping, paused, then idle.

- **One read.** `GET /v1/running` folds the roster, the tree, wakes, services, spend and the
  egress summary into one answer, as a pure fold in `spade_core`, and changes arrive on the
  existing live stream. The app folds it in `packages/ui-core/src/spade-chat`, so the iPhone can
  show the same list.
- **From the terminal.** `ace bot running`, and `ace bot stop|pause|resume BOT` (9).

### 7. Typed agent-to-agent calls: contracts

- **What a contract is.** A function an agent publishes: a `name`, a one-line `summary`, an input
  and an output schema (the same bounded subset as cards; input at most 64 KiB, output at most
  256 KiB), the effects a call may use, and examples, which the tests use.
- **Finding and calling.** `contracts_find {need?}` lists the contracts of bots the caller may
  reach. `contract_call {bot, contract, input}` checks the input against the callee's schema on
  both sides and answers at once with a call id, like a background job (0158 §2). The result
  arrives once, as a `<contract_result>` that opens a reply.
- **The callee works under its own grants.** A call starts a turn in the callee's conversation,
  framed as another agent's request (`from_agent`), never as the person's words. It runs under
  the callee's gate, ceiling and grants, and the callee's reviewer reads the person's words only
  from the callee's own conversation (0161 §7). A caller can't lend its grants or borrow the
  callee's. During that turn, an effect outside the contract's own `effects` is refused, inside
  the package's ceiling. (Amended below: until the reply that serves the call ends, and in every
  helper and worker it starts, for good.)
- **The answer is typed.** The callee answers with `contract_return {call, output}`. Spade checks
  the output against the schema. One that doesn't fit goes back to the callee with the problems,
  at most twice, and then the caller gets `failed` with them. The caller treats the output as
  another agent's data: it is untrusted when the callee read anything untrusted during the call,
  as a helper's result is (0152 §6). (Amended below: or had any in view as the call arrived. The
  caller checks the output as a reader, passing fields its schema doesn't name.)
- **Who may call whom.** In v1, the person's own bots, on this machine and on the person's other
  machines through 0132's asks. The person can turn calls off per bot. Other people's agents
  never call in v1 (open question 4).
- **Exactly once, and stoppable.** Each call carries an idempotency key from the caller, as 0132
  §9's asks do, and both sides store it as events, so a restart neither loses nor repeats it.
  Stop on the caller stops the callee's turn for that call. Stop on the callee fails the call as
  `stopped`. (Amended below: a restart carries on with the callee the call pinned; Stop reaches a
  call another machine may hold.)
- **Stable names.** A contract's name and its schemas move with the package's versions. The dev
  kit compares a new version with the previous one and refuses a change that breaks callers; a
  breaking change takes a new name.
- **Example.** A "Trip planner" bot calls Flight watcher's
  `cheapest_fare {from: "KTM", to: "DEL", month: "2027-01"}` and gets back
  `{fare, currency, carrier, seen_at, link}`, in the shape the contract promises.

### 8. The store

The market of ADRs 0168, 0174 and 0178 carries packages as `spade-bot` entries. What changes for
them:

- **Free listings only**, as 3.7 says. The entry page shows, before anything installs, what each
  version declares, in plain sentences: effects, triggers, apps, surfaces, contracts and expected
  spend.
- **Versions and updates.** Versions follow ADR 0174's rules. The daily check finds updates
  (0168 §8). An update is never applied on its own, and one that asks for more says so (6.1).
- **Verified publishers** are 0174 §13's, and ace's own packages are "By ace" (0174 §14).
- **Scans.** ADR 0174 §8's pipeline, plus checks for packages: the manifest (no secrets, no
  identity fields, no executions, known effect words, `pricing` free, references to the same
  source only), panels (no remote addresses, nothing 0077's bridge removes), bounded schemas for
  cards and contracts, and the package's own tests, run by the signer with the scripted model
  (9). A package whose shipped tests fail isn't listed.
- **Ratings and written reviews** stay out of the first slice, as 0168 §11 decided. Agents need
  them more than Suits do, so they come in phase 3 with moderation: one per ace account per
  package, tied to the version it was written on, with the publisher's reply. Abuse reports hide
  them (0174 §7). Ranking ignores them until moderation is in place.
- **Reporting** is 0174 §7's, plus a Report action in a packaged bot's profile. What the bot did
  is attached only if the person ticks it, never on its own.
- **Installs stay safe:**
  - A package always makes a bot that acts, so it is never content-only (0178 §12.8). Installing,
    updating and rolling back need the person's standing; they are not on the agent allowlist
    (`apps/daemon/src/marketplace/agent-gate.ts`). An agent can find and `prepare` one, and its
    request opens in its thread for the person.
  - Held until the person says: bundled skills serve only the new bot, triggers start paused,
    effects are switches, and nothing is granted before Install.
  - Signed manifests, pinned hashes and the withdrawn list are 0168 §6's, unchanged. Nothing runs
    during fetch, review or install.

### 9. Developer kit

The CLI noun is `ace bot` (open question 5), in ADR 0178's grammar:

```
ace bot init [NAME] [--template T]       make a package folder
ace bot check [PATH]                     the market's checks, plus runtime, card and contract checks; no account
ace bot dev [PATH]                       install it here as local/<folder>, and update it on every save
ace bot test [PATH] [--model ROLE]       run the package's tests
ace bot publish [PATH] [--version V]     the same as `ace market publish spade-bot PATH`
ace bot running                          the task manager (6.3)
ace bot stop|pause|resume|update|rollback|uninstall BOT
```

- **`init` templates:** `blank`, `watcher` (a schedule and a card), `service` (contracts only),
  `club-member`, and `--from BOT`, which writes one of the person's own bots as a version 3
  package (today's "Export as recipe", raised).
- **`dev`** installs through the normal review once, with the developer as the person, as
  `local/<folder>`. After that, each save runs `check` and applies as an update at the bot's next
  turn, with no review per save. A save that adds an effect, a trigger kind, a contract or an app
  asks again. A development bot shows "Development" and can't be moved or published as it is.
- **`test`** runs scenario files. Each gives the agent a message, a trigger or a contract call, a
  scripted model (the steps the model takes) and fake tool results, then states what must happen:
  the calls made, the effects asked for, the cards shown (checked against their schemas), a
  contract's output (checked against its schema), words the reply contains. They run on Spade's
  real engine with `spade-testkit`'s fake model endpoint: deterministic, free and offline.
  `--model ROLE` runs the same scenarios on the developer's own model, on their machine and at
  their cost; then only the shapes are checked (valid cards and contracts, no undeclared effect).
  ace never runs a package's tests on a real model.
- **`publish`** runs `check` and `test` first.
- **Docs:** `spade/docs/runtime.md` (the API table), `spade/docs/packages.md` (the manifest,
  with Flight watcher), `spade/docs/surfaces.md` (cards and panels), and a built-in skill,
  `make-a-bot`, so Spade or a coding agent can write a package with the person, as `make-a-suit`
  does for Suits.

### 10. Phases

1. **First slice: packages that install, update and roll back.**
   - The version 3 manifest without panels and contracts: `requires`, `uses`, triggers
     (`message`, `schedule`, `event`, `mention`, loopback `webhook`), the effects ceiling and its
     install switches, `limits`, `pricing: free`, `tests`.
   - Linked bots, with update, rollback and the withdrawn pause.
   - The `spade.v1` table, `runtime.md` and the table test.
   - Cards (`card_show`), data only, drawn by every client, the iPhone included.
   - The `paused` state, `GET /v1/running`, the Running page and `ace bot running|stop|pause|resume`.
   - `ace bot init|check|dev|test|publish`, and `make-a-bot`.
   - The ten templates re-shipped by ace as version 3 packages.

   This slice turns every recipe into an agent its maker can keep fixing. It adds the one
   enforcement piece that makes a stranger's package safe to grant into (the ceiling), and it
   gives the person one place to see and stop what runs, all on machinery that exists.

2. **Contracts and panels.** `contracts_find`, `contract_call`, `contract_return` and their
   rollup; panels on web and desktop; `notify`; a bot suggesting a package as a request card for
   the person.
3. **The store's depth.** Ratings and written reviews with moderation; webhook triggers reached
   from outside the machine; app push triggers, if apps can push.
4. **Later, each under its own decision:** paid packages; calls between different people's
   agents; packages on Spade Cloud; packages that run their own long-lived code beyond plugins
   and owned services; the `ace-plugin` type (0168 phase 3).

### 11. Out of scope

- Paid listings, payment, licences and payouts.
- Agents of different people calling each other, or a package acting for anyone but the person
  who installed it.
- A package running code in Spade's or ace's process, or outside the sandbox other than through
  a plugin the person accepted.
- A new language, runtime or SDK for agents.
- Spending caps, step limits or time limits (0158, 0166).
- Any change to the sandbox, the effects routes, the classifier or the reviewer, beyond the
  ceiling check.

## Risks

- **The ceiling is only as good as the gate's reading of effects.** An app tool with no
  annotation reads as `network` (0171 decision 3), so a package without `network` can't call it.
  A tool that declares nothing still asks the person on its first call.
- **A publisher's task is standing text in the bot's prompt.** It is shown in full on the review,
  it is never the person's word to the reviewer (3.4), and the ceiling, the egress allow list and
  the person-only effects bound what a hostile task can do. It can still make the bot useless or
  noisy, which reports and withdrawals answer.
- **Updates are a supply-chain path.** Every update is signed, pinned, reviewed and accepted by
  the person, and anything that asks for more starts off.
- **Panels on the web keep 0077's residual risk**: a network hint could reveal that a page was
  viewed or what the person typed into it. Desktop has no such path.
- **A frozen API costs something.** Aliases have to be kept, and a bad name lives for six months.
- **No caps means a buggy package can spend.** The spend alert, the Running page and Stop are the
  answers, as ADR 0166 chose.
- **The install review can grow too long to read.** It has to stay plain sentences, one row per
  ask, with the details behind each row.

## Decided

The owner took each recommendation on 2026-11-20.

1. **Is the first slice right** (section 10, phase 1: manifest v3, the ceiling, linked updates
   and rollback, `spade.v1`, cards, the Running page, the dev kit, the templates as packages)?
   Recommended: yes. Contracts and panels follow in phase 2.
2. **Do "resource and spend limits" mean declarations and alerts, never stops?** A package states
   its expected spend (the alert line) and workspace size, and may bound its workers at once;
   nothing stops for spend (ADR 0166). Recommended: yes.
3. **Cards first, panels second?** Cards are data drawn by ace and work on every client, the
   iPhone included. Panels are sandboxed pages on web and desktop. Recommended: cards in the first
   slice, panels in phase 2.
4. **Contracts only between the person's own bots in v1?** Calls across people need identity,
   abuse limits and a trust model of their own. Recommended: yes, the person's own bots and
   fleet only.
5. **"Bot" or "agent"?** Keep "bot" in the app, `ace bot …` in the CLI and `spade-bot` as the
   format, with "agent OS" as the idea; or rename bots to agents everywhere. Recommended: keep
   "bot". In ace, "agent" already means the coding agents in threads, and `ace agent` would read
   as those.

## Options considered

- **A new `spade-agent` type beside `spade-bot`.** Two formats for one thing, with two readers,
  two reviews and a migration. Rejected: the recipe grows a version instead.
- **An agent SDK with code that runs in a runtime of its own.** A second stack beside the gate,
  whose actions the effects table can't see. Rejected; skills' scripts in the sandbox and
  plugins cover code today.
- **Declared effects as grants.** Simpler installs, but the person couldn't say no to one part,
  and a package's word would become a key. Rejected for switches over a ceiling.
- **Panels with network access.** They would need their own egress policy and a second place to
  hold sign-ins. Rejected: a panel gets data from its bot, which works under the gate.
- **Ratings in the first slice.** Rejected for now: they need moderation the market doesn't have
  yet (0168 §11).
- **Spending caps per package.** Rejected by ADR 0166.

## Consequences

- An agent becomes something people can make, share, maintain and fix, with one format, one
  review and one trust rule.
- Spade gains a ceiling check in the gate, linked bots with updates and rollback, a `paused`
  state, cards, a running view and a versioned API table. Phase 2 adds contracts and panels.
- The bot recipe gains version 3. Version 2 and version 1 still read.
- The market keeps one `spade-bot` type, gains package checks and runs packages' tests on the
  signer.
- `spade_core::effect`'s table gains module and `since` columns and becomes public API.
- More is shown at install, so the review needs care to stay short.

## Tests

Pure tables in `spade_core` and `@ace/marketplace`:

- the manifest: version 2 reads as version 3 with its routines as schedule triggers; identity
  fields, secrets, executions, `credential`, a refused grant kind and a price other than free are
  each refused; unknown fields are kept and grant nothing;
- the ceiling: a call whose effect the package didn't declare is refused before review, whatever
  the tool is called; a declared effect the person turned off is refused too; a declared send
  still goes to the person; a worker of a packaged bot can't use what its maker didn't declare;
- the API table: removing a v1 tool, or giving one a stronger effect, without an alias fails;
- the rollup: a paused bot with an open question reads waiting; a caller reads working while its
  call is open and waiting while the callee waits on the person;
- cards and contracts: data that doesn't fit its schema is refused with its problems; a breaking
  contract change in a new version is refused by the check.

Process tests through Spade's API, with `spade-testkit`'s fake model and a real local market:

- installing a package makes a bot with triggers paused and only the switches the person left
  on; a failure part-way leaves nothing installed;
- an update that adds an effect turns nothing new on; an update keeps the person's edited task,
  their notes and their workspace; a rollback restores the previous version offline;
- pause holds a due wake and a routine slot across a restart, and resume fires each once;
- a withdrawn version pauses its bot and deletes nothing;
- a contract call is delivered once across a restart of either side, and Stop on the caller stops
  the callee's turn;
- a panel's page can't reach the network or the host page, and only declared actions reach the
  bot (desktop isolation as 0077 proves it);
- `ace bot test` runs a package's scenarios with no network and no real model.

## Amendment, 2026-11-20: what a contract call holds, and who may make one

A security review of §7 as first built found six ways a call could reach past what it promised.
Each is fixed at its cause:

1. **The effects hold until the serving reply ends, and bind every descendant.** A call's
   effects no longer stop holding when the callee returns: they hold the reply that serves the
   call until that reply ends (a restart's interruption isn't an end), so a tool later in the same
   reply can't use an effect the contract left out. A helper that reply starts stays held to the
   calls of that reply for as long as it lives; a worker made under a call keeps the call's scope
   on its link (`worker_of.held`), for good.
2. **Taint at entry counts.** A call's output is untrusted when the callee had untrusted content
   in view as the call arrived (another bot's message, a page it read, a summary drawn from
   either), or read some during the call. The call's own message isn't counted.
3. **Stop reaches a call another machine may hold.** The outbox marks a queued entry as maybe
   there before each send, so a crash or a lost answer leaves the mark. Stop then sends `stop`
   under the key, again after the backoff, until that machine answers: one that never had it is
   withdrawn, one that had it ends `stopped` there. Only an entry never tried is withdrawn here
   alone.
4. **Only Spade sends to another machine's Spade, and a caller is a bot of the sending machine.**
   The daemon forwards `spade.remote` only from Spade's own socket (loopback, ace's local token);
   a paired device with operate is refused, so it can't forge a call from a bot. The receiving
   Spade takes a `contract_call` only from another machine (never ace's own thread asks), with
   the calling bot's id and name both given; an id naming one of its own bots is refused, and the
   callee reads the sending machine on the call (`<contract_call … machine="Laptop">`), as that
   machine's daemon stamped and signed it (0132 §8).
5. **A restart resumes from what was stored.** A `contract_call` job run again finds its
   `contract_called` and carries on with the bot (and machine) it pinned, its delivery and its
   outcome, before any name lookup or admission check. A rename, or a new bot with the old name,
   never gets a second delivery.
6. **Callers read output leniently.** The market signs a new optional output field as
   compatible, so a caller holding the older contract passes fields its schema doesn't name and
   still checks every field it names. The callee's own check stays strict.

Tests: `contracts_security.rs` and `contracts_fleet_security.rs` in `spade-server`, the folds in
`spade_core::contract`, and `spade-remote.test.ts` in the daemon. Each fails with its fix turned
off.
