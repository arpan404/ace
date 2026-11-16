# 0168: ace's marketplace

Status: proposed. Date: 2026-11-15. Decided by: the owner (2026-11-15: one general marketplace
for ace rather than one for Spade, holding Suits, Spade's skills, plugins and bots, and later
ace's own plugins). Builds on [ADR 0002](0002-local-cli-providers.md) (ace is never hosted),
[ADR 0014](0014-plugins.md) (plugins and git catalogs), [ADR 0103](0103-skill-library.md) (the
skill library), ADR 0150 (Suits, `0150-suits.md` on main), [ADR 0151](0151-spade-skills-and-plugins.md)
(Spade's skill store and plugins), [ADR 0132](0132-spade-teams.md) (bot templates and bot files),
[ADR 0131](0131-spade-connectors.md) (connectors), [ADR 0161](0161-spade-orchestration-trees.md)
(grants as subsets), [ADR 0163](0163-spade-auto-review-only.md) (one access level), ADR 0167
(what the person grants a bot) and [ADR 0141](0141-ace-cloud.md) (ace cloud). Amends ADR 0014's
catalog rules (decision 2).

## Context

People can already make things ace runs, but each kind has its own way in, and none of them helps
anyone find what others made:

- **Suits** (ADR 0150) are folders in `~/.ace/suits/`. An agent makes one; nothing installs one
  from elsewhere yet, though the ADR says a Suit can live in a git repo and that scenes are
  trusted per version.
- **Plugins** (ADR 0014) install from a git catalog (`marketplace.json`) through a review bound
  to a commit and a content hash. The catalog lists plugins only.
- **Spade's skills** live in Spade's store (ADR 0151) with origins `ace`, `spade` and `plugin`.
  There is no way to add a skill someone else wrote, short of copying a folder by hand.
- **Spade's bots** start blank, from one of the ten templates built into Spade, or from a bot
  file another machine exported (ADR 0132, format `spade-bot` version 1). A bot file carries
  connector choices as grants, which is fine between a person's own machines and wrong for a
  file from a stranger.

The owner wants one place to find all of these, with one review before anything installs. ace
is never hosted (ADR 0002), with narrow exceptions for the relay, accounts and connector
sign-in, all now served by ace cloud at `cloud.acehq.dev` (ADR 0110, 0111, 0140, 0141). A
marketplace tempts a store with accounts, ratings and a server that decides what people see.
This ADR keeps it to what git and the daemon already do.

## Decision

### 1. One marketplace, five entry types

The marketplace lists entries of these types:

| Type           | What it is                                                     | Phase |
| -------------- | -------------------------------------------------------------- | ----- |
| `suit`         | A Suit folder (ADR 0150)                                       | 1     |
| `spade-skill`  | A skill folder: `SKILL.md` and its files                       | 1     |
| `spade-plugin` | An ADR 0014 plugin, offered to Spade's bots (ADR 0151)         | 1     |
| `spade-bot`    | A bot recipe (decision 4)                                      | 1     |
| `ace-plugin`   | A plugin that extends ace itself; needs its own ADR before use | later |

A `spade-plugin` is an ordinary ADR 0014 plugin. Installing it accepts it in ace, as every
plugin is, so it reaches the coding agents too unless the person turns them off in the plugin's
availability; the review page says which agents and bots will have it. `ace-plugin` is reserved
for the capability ADR 0150 left out ("new panes and behaviour"). A build that doesn't support a
type lists its entries as "Needs a newer ace" and never installs them.

### 2. Where listings come from: git catalogs (chosen)

Three options were weighed:

- **(a) Git catalogs.** An official catalog repository, plus any catalog repository the person
  adds by its https address. The daemon fetches each with ADR 0014's fetcher (shallow bare
  fetch, isolated config, no hooks, nothing checked out or run) and reads its catalog file.
- **(b) A hosted index on ace cloud** that crawls git catalogs and serves search over them. It
  would hold only names, descriptions and git coordinates, and the daemon would still fetch,
  verify and review from git, so the index could never change what gets installed.
- **(c) Both:** git catalogs as the source of truth, the index for search across many catalogs.

**Chosen: (a).** It needs no new hosted service, works with ace cloud unreachable or the person
signed out, matches ADR 0002, and reuses the fetcher, pinning and review ADR 0014 already ships.
A catalog of a few thousand entries is a small fetch and searches fast on the machine.
**Kept as an option: (b)**, as a later addition if catalogs outgrow local search or the owner
wants discovery across catalogs the person hasn't added. It would be one more read-only route
on ace cloud's Worker, needing no sign-in, storing nothing about who searched, and would never
be required to install anything.

Catalog rules:

- **The official catalog** is one repository beside ace's own, under the same owner
  (`ace-marketplace`). Every build ships its address and its signing keys (decision 6). It is on
  by default; the person can remove it.
- **Person-added catalogs** are https git addresses (the same restricted protocols as ADR
  0014). Each is listed under its address. There is no limit on how many, beyond ADR 0014's
  caps per catalog.
- **Refresh.** The daemon fetches a catalog when the marketplace opens and the last fetch is
  over an hour old, when the person asks, and once a day to check installed entries for updates.
  A fetch that fails keeps the last good catalog and says when it was read. Nothing else in ace
  waits on a fetch.

### 3. The catalog file

The catalog file stays ADR 0014's root `marketplace.json`, which gains an optional `entries`
list beside `plugins`. A catalog with only `plugins` reads as before, each plugin as a
`spade-plugin` entry, so every existing catalog keeps working.

```json
{
  "name": "ace-marketplace",
  "format": 2,
  "categories": [{ "id": "writing", "title": "Writing" }],
  "featured": ["suit/dusk", "spade-bot/inbox"],
  "entries": [
    {
      "type": "suit",
      "name": "dusk",
      "title": "Dusk",
      "description": "Warm greys and an evening sky behind the sidebar.",
      "version": "1.2.0",
      "source": "suits/dusk",
      "hash": "sha256-…",
      "categories": ["calm"],
      "keywords": ["sunset", "warm"],
      "publisher": { "name": "ace", "account": "arpan404" },
      "requires": { "ace": ">=0.0.23" }
    }
  ]
}
```

- `type` and `name` identify an entry within its catalog (`<type>/<name>`); names are ADR 0014
  slugs. `title`, `description`, `version`, `categories`, `keywords` and `publisher` are shown,
  never trusted: an unusable value is dropped, not fatal.
- `source` is either a folder in the catalog repository (as ADR 0014 has it) or, new here, a
  pinned outside source: `{ "repo": "https://…", "commit": "<full SHA>", "path": "…" }`. ADR
  0014 refused outside sources because a branch or tag can move under a review. A full commit
  SHA with the entry's `hash` cannot, so this amends 0014 to accept outside sources pinned that
  way, and only that way. A publisher keeps their entry in their own repository; listing a new
  version is a catalog change that names the new commit.
- `hash` is the content hash ADR 0014 defines (sorted paths, executable bits, framed bytes). It
  is required for outside sources and checked on every fetch, review and install.
- `categories` and `featured` are read only from the official catalog; elsewhere they are
  ignored, so a person-added catalog can't push itself to the top.
- Unknown types and fields are kept as raw data and listed as unsupported, never dropped and
  never fatal.

The schema lives in `@ace/protocol/marketplace` (schema only). Catalog parsing, merging and
search live in a new `@ace/marketplace` package that reuses `@ace/plugins`' fetcher, path rules
and hashing; it adds no second git path.

### 4. Entry formats

Each type reuses the format that already owns it:

- **`suit`**: the Suit folder of ADR 0150 (`suit.json`, optional `suit.css`, scenes, ornaments,
  `assets/`), unchanged. An optional `assets/preview.png` (at most 1 MB) is the listing's
  picture; without one, the listing draws the Suit's palette.
- **`spade-skill`**: an ADR 0103 skill folder (`SKILL.md` with frontmatter, plus files), held to
  0103's limits (512 files, 4 MiB per file, 16 MiB in all, no links or submodules).
- **`spade-plugin`** and later **`ace-plugin`**: an ADR 0014 plugin folder, any manifest 0014
  imports.
- **`spade-bot`**: a **bot recipe**, `bot.json` in a folder, defined below.

A bot recipe is ADR 0132's bot file at `version: 2`, changed so that it asks rather than grants:

```json
{
  "format": "spade-bot",
  "version": 2,
  "name": "Inbox",
  "blurb": "Sorts your mail each morning and drafts the replies that matter.",
  "task": "You look after the person's inbox. …",
  "face": { "kind": "character", "body": "fox", "pair": "ember", "…": "…" },
  "model": "fast",
  "routines": [{ "name": "Morning sort", "instruction": "…", "schedule": "weekdays at 8:00" }],
  "skills": ["spade-skill/triage-mail", "skills/house-style"],
  "plugins": ["spade-plugin/mail-tools"],
  "needs": {
    "connectors": [
      { "id": "<catalogue id>", "why": "Reads and drafts mail.", "required": true },
      { "url": "https://mcp.example.com/mcp", "why": "Files receipts.", "required": false }
    ],
    "tools": ["web_search", "shell"]
  },
  "notes": ["Never send a reply without the person's word."]
}
```

- `task` becomes the bot's standing task (ADR 0126). `face` is the eight stored fields of
  `spade_core::face`, repaired by its rules if a value is unknown.
- `model` is `fast` or `capable`, as templates have it, never a model id: the person's own
  models are used (ADR 0162).
- `routines` arrive paused, unless the person turns them on in the review (decision 6).
- `skills` name `spade-skill` entries in the same catalog, or folders inside the recipe
  (`skills/<name>/`); `plugins` name `spade-plugin` entries in the same catalog. A recipe can't
  name another catalog's entries, so one review covers everything it brings.
- `needs.connectors` name a catalogue connector by id (`spade/config/connectors.json`) or a
  server by https address, each with a reason and whether the bot works without it. `needs.tools`
  can only narrow the bot's built-in tools (ADR 0161: unset means all); it can't add any.
- Never a key, token, webhook secret, model id, endpoint, conversation, knowledge entry or
  grant. A recipe holding anything named like a secret is refused whole, as ADR 0137 does.
- A version 1 bot file still imports as ADR 0132 says, between the person's own machines. In
  the marketplace it is read as a recipe: its connector choices become needs.

Spade's ten built-in templates become the official catalog's first recipes. The binary keeps its
copies, so New bot from a template works with no network.

### 5. Install, update and remove

The daemon is the one fetcher and reviewer for every type, so one git path and one review cover
everything. Each type then lands with the part of ace that already owns it:

| Type           | Lands in                                                                                                       | Removed by                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `suit`         | The daemon's Suit library, `~/.ace/suits/<id>/`, through a new `install`                                       | Suit `remove`; a device wearing it goes back to ace's theme                          |
| `spade-skill`  | A pinned copy in the daemon's marketplace registry; Spade copies it into its store with a new origin, `market` | Dropped from the registry; Spade drops the copy and the workspace files on next sync |
| `spade-plugin` | ADR 0014's plugin manager (accept), then allowed for the bots the person picked (ADR 0151 point 8)             | ADR 0014 removal, which also ends every bot's allow                                  |
| `spade-bot`    | A new bot, made by Spade from the recipe (`POST /v1/agents` with `recipe`)                                     | Nothing to remove: the bot is the person's, deleted like any bot                     |

- **Installing.** `prepare` fetches the entry at its pinned commit, checks its hash, runs the
  type's checks and returns a review (decision 6). `install` needs that review's id, commit and
  hash, as ADR 0014's accept does, plus the person's choices (which bots get a plugin, which
  grants a recipe gets). A recipe installs its skills and plugins first, each under its own
  record, then makes the bot; a step that fails undoes the steps before it and nothing is half
  installed.
- **Market skills in Spade.** Spade lists the daemon's market skills and fetches each skill's
  files the way it copies ace's library (ADR 0151 point 2): replaced whole on a hash change,
  last copy kept with ace away. They are read only. Like every store skill, they serve every
  bot. **Add to ace's library** (ADR 0151 point 3) is offered on each, for a person who wants the
  coding agents to have it too.
- **Updates.** The daily check compares each installed entry's pinned commit and hash with its
  catalog. A newer one shows as "Update" on the entry and in Installed, never applied on its own
  (ADR 0014: there is no automatic update path). Updating shows a review of what changed (added,
  changed and removed files, executables flagged, `SKILL.md` or `suit.json` before and after;
  for a plugin, 0014's full review again) and needs a new acceptance.
- **Bots don't update.** A bot made from a recipe belongs to the person from then on. It
  records `from_recipe {catalog, name, version}`, shown in its profile. A newer recipe never
  changes the bot; its skills and plugins update as their own entries.
- **Spade Cloud** (ADR 0140) has no marketplace in phase 1: it never reaches a daemon. Spade on
  the person's machine installs a bot recipe only while Spade runs; otherwise the review says
  "Spade isn't running".

### 6. Trust and review

- **Nothing runs before or during install.** Fetching, reading, checking and installing execute
  nothing from an entry (ADR 0014's security rules apply to every type). A Suit's scene runs
  only when the Suit is worn, in its sandbox (ADR 0150). A plugin's hooks and servers run only
  after acceptance, for agents and bots it is allowed for. A skill's scripts run only when a bot
  runs them under the gate (ADR 0151 point 5). A recipe's routines start paused.
- **Trust is per version.** What the person accepts is the review's commit and content hash.
  Every read checks the stored hash; a mismatch refuses use, as in ADR 0014.
- **A review page before every install.** It names the entry, its publisher and catalog, the
  version, commit and hash, then what the entry can do, in plain sentences, by type:
  - a Suit: whether it passes ace's checks (ADR 0150's static checks, run at review), whether it
    has scenes ("Runs its own animation, sandboxed"), its fonts and file count. A Suit that fails
    lists its problems and can't be installed; the official catalog refuses such Suits before
    listing them;
  - a skill: `SKILL.md` as text, its files, each script or binary flagged;
  - a plugin: ADR 0014's review (hook commands, server commands with arguments, environment and
    folder, remote addresses), and which coding agents and which bots will have it;
  - a bot recipe: its face, name, task in full, model kind, routines with their schedules, the
    skills and plugins it brings (each with its own section above), and every need.
- **A recipe's needs are asked for, never granted by the file.** Each needed connector and
  plugin is a row with a switch: required ones start on, optional ones off, and nothing is
  granted until the person presses Install with the switches as they set them. That press is the
  person's grant, recorded as ADR 0167 records grants. A connector the person hasn't connected
  shows "Connect after install"; the bot asks for it the usual way if it needs it later. Grants
  never exceed what ADR 0161 allows (a bot made from a recipe is a top-level bot), and the access
  level is ADR 0163's one level, so there is nothing to choose. "Start its routines" is a switch,
  off by default.
- **The official catalog is signed.** Beside `marketplace.json` it carries `marketplace.sig`: an
  Ed25519 signature over the catalog file's bytes by an ace marketplace key. Builds ship the
  public keys (two at a time, so a key can be rotated). Since the file holds every entry's
  pinned commit and hash, the signature covers everything installable from it. A fetched
  official catalog whose signature doesn't verify is not used; the last good one stays.
  Signing uses `@noble/ed25519`, already shipped in `@ace/account-grant`.
- **Publisher identity.** Each official entry names a publisher and their account on the
  catalog's git host. When the
  entry is added, the maintainers confirm that account controls the source repository (the pull
  request comes from it, or the repository's owner approves it). The review says "By <name>";
  the project's own entries say "By ace". Entries from a person-added catalog say "From
  <address>" and nothing more: ace vouches only for what it signed.

### 7. Discovery

- **Search** runs on the daemon over every catalog the person has: name, then title, then
  description and keywords, rarer words counting more, forgiving a typo. Ranking is a pure
  function in `@ace/marketplace`. Results can be narrowed by type, category and catalog.
- **Categories** come from the official catalog's list (a dozen or so, kept by its maintainers);
  an entry names up to three.
- **Featured** is a short hand-picked list in the official catalog, shown first when nothing is
  searched.
- **No ratings, reviews or install counts.** Ratings need accounts and a hosted store of votes,
  which ADR 0002 rules out, are easy to game, and would be the only fact on the page not drawn
  from what the entry is. Install counts would need ace to report what people install; it
  doesn't. What a person judges by is on the page: publisher, catalog, when it was last updated,
  and the review itself.

### 8. Where it lives in the app

The marketplace is one surface for every type, with a type filter. Its layout, at the level of
places (no mockup here):

- **A place in the rail**, after Skills, named Marketplace (a new glyph in `@ace/icons`, ADR
  0156). Its panel follows DESIGN.md's panel pieces: the title row with a filter menu in words
  ("Everything", then Suits, Skills, Plugins, Bots); "Search marketplace"; then panel rows:
  Featured, the categories, Installed, Updates (its count as a trailing word), Catalogs.
- **The main column** lists entries as rows: title, one line of description, and the type and
  publisher in meta ink. A bot recipe's row shows its face; a Suit's its preview. No stars, no
  badges, no icons on buttons. An entry opens a full page in the main column (as pull requests
  do): its description, what it brings, publisher, catalog and version, and one action at the
  title row's right: Install, Update or Installed. Install opens the review, whose last action is
  Install.
- **Entry points elsewhere**, each opening the marketplace with the filter set, as one text
  action: Settings › Spade › Apps (which Spade's list top button opens) gains "Browse the
  marketplace", filtered to skills, plugins and bots; Spade's new-bot flow gains "From the
  marketplace" beside the templates; Settings › Appearance gains "Find Suits"; the Skills
  place's Add menu gains "From the marketplace".
- **Phones.** Suits stay off the phone apps (ADR 0150). The iPhone gets the Spade types later,
  through the daemon, in the phone's own grammar.

### 9. Publishing

- **Anyone can publish without asking anyone.** A git repository with a `marketplace.json` is a
  catalog. Sharing its address lets another person add it and install from it.
- **Export.** A Suit's ⋯ menu gains "Export"; a store skill's gains "Export"; a bot's profile
  gains "Export as recipe", which writes a version 2 recipe: grants become needs, notes are
  included only if the person ticks them, and nothing secret is written. Each export writes a
  folder (or a zip of it) with a starter `marketplace.json`, ready to commit.
- **The official catalog** takes entries by pull request: the entry's lines in
  `marketplace.json`, pointing at the publisher's repository by commit, or a folder in the
  catalog for small things. Before merging, the maintainers run `ace marketplace check <path>`
  on it, which runs every check the daemon runs at review (schema, limits, paths, hashes, Suit
  checks, secret patterns, recipe rules) plus the catalog's own rules (unique names, known
  categories, publisher confirmed). Publishers run the same command before opening the request.
  It runs on a maintainer's machine, not on a hosted build service. A merge signs the new
  catalog file with the marketplace key.

### 10. Wire and modules

- `marketplace.request {requestId, operation}` / `marketplace.result {requestId, result}` in
  `@ace/protocol/marketplace`, beside ADR 0014's plugin envelopes. Operations: `catalogs`,
  `addCatalog`, `removeCatalog`, `refresh`, `search`, `read`, `prepare`, `readReview`, `install`,
  `cancel`, `installed`, `prepareUpdate`, `remove`. Reads need the device read scope; the rest
  need admin, as plugin mutations do.
- `marketplace.spade` for Spade: the installed market skills with hashes, and one skill's files,
  in the shape of `skills.request` `files` (ADR 0151 point 4).
- The Suit library gains `install`. Spade's `POST /v1/agents` gains `recipe` (the parsed recipe
  and the person's choices), made through the daemon's link to Spade.
- Reviews are bounded and paged as ADR 0014's are; pending reviews are in memory and expire
  after 30 minutes or on restart, as ADR 0103's do.

## Open for the owner

Each has a recommendation, which this ADR assumes until the owner says otherwise:

1. **Listings: (a) git catalogs only, or (c) git plus a hosted index on ace cloud?**
   Recommended: (a) now, (b)'s index added later only if needed.
2. **Where the marketplace opens: a rail place after Skills, a Settings page, or inside the
   Skills place (renamed Library)?** Recommended: a rail place, since Suits and bots aren't
   skills and Settings is for settings.
3. **Market skills: Spade only, or also offered to the coding agents at install?** Recommended:
   Spade only, with ADR 0151's "Add to ace's library" for the person who wants both.
4. **A recipe's required needs: switches start on, or everything starts off?** Recommended: on
   for required, off for optional; nothing is granted until Install either way.
5. **Spade Cloud bots from recipes,** with no daemon there: later, through a recipe the person's
   own Spade sends to the cloud, or never? Recommended: later, not in phase 1.

## Phases

1. **Suits, Spade skills, Spade plugins and bot recipes.** The official catalog opens with ace's
   own Suits, the ten templates as recipes, and a first set of skills.
2. **Publishing** (exports, `ace marketplace check`, contribution notes in the catalog repo),
   and the iPhone's Spade types.
3. **ace plugins**, once an ADR defines what a plugin may add to ace itself.
4. **The hosted index (option b)**, only if the owner chooses it.

## Options considered

- **A Spade-only marketplace.** The first plan. Rejected by the owner: Suits and future ace
  plugins need the same review and discovery, and two stores would duplicate the logic.
- **A hosted store with accounts, uploads and ratings.** Rejected: it makes ace hosted in
  exactly the way ADR 0002 refuses, and it would be the authority on what people may install.
- **Outside sources by branch or tag.** Rejected: a moving ref changes under a review. Only full
  commits with a content hash.
- **Signing each entry instead of the catalog.** More keys to manage for the same guarantee; the
  catalog file already pins every entry.
- **Auto-updating Suits and skills, which run no code by themselves.** Rejected for one rule
  everywhere: a skill's scripts and a Suit's scenes are code, and a person reviews each version.

## Consequences

- One place to find and install everything people make for ace, with one review and one trust
  rule.
- No new hosted service. The official catalog is a git repository; ace cloud is untouched unless
  option (b) is chosen.
- Existing plugin catalogs keep working; ADR 0014 gains pinned outside sources.
- Spade's skill store gains the `market` origin; bot files gain version 2; the Suit library
  gains `install`.
- The official catalog needs maintainers and a signing key kept off the daemon's machines.
- Without ratings, quality rests on the official catalog's review and the publisher's name.

## Tests

Pure tables in `@ace/marketplace`: catalog parsing (version 1 and 2, unknown types and fields
kept, unusable display values dropped, duplicate names refused), outside sources refused
without a full commit and hash, categories and featured ignored outside the official catalog,
search ranking, recipe parsing (secrets refused, `needs.tools` only narrows, foreign references
refused). Process tests on real local git repositories and temp SQLite:

- an entry from a pinned outside source installs; the same entry with its hash changed is
  refused at review and at install;
- an official catalog with a bad signature is not used and the last good one stays;
- a Suit that fails ace's checks can't be installed; one that passes lands in the library and
  isn't applied;
- a market skill reaches Spade's store with its files, is replaced on update and gone on
  remove;
- a bot recipe installs its skills and plugins, then makes a bot with routines paused and only
  the grants the person left on; a failure making the bot leaves nothing installed;
- an update is listed and not applied until accepted;
- nothing from an entry runs during prepare or install (a planted hook, script and scene
  record nothing).
