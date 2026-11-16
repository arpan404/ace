# 0168: ace's marketplace

Status: proposed, amended by [ADR 0173](0173-market-publishers-discovery-and-scanning.md)
(publishers, discovery, publishing from the app, the scan pipeline and account-only writes).
Date: 2026-11-15. Decided by: the owner (2026-11-15: one general marketplace
for ace rather than one for Spade, holding Suits, Spade's skills, plugins and bots, and later
ace's own plugins; then, the same day: the marketplace is hosted, at its own domain
`market.acehq.dev`). Builds on [ADR 0014](0014-plugins.md) (plugins and git catalogs),
[ADR 0103](0103-skill-library.md) (the skill library), ADR 0150 (Suits, `0150-suits.md` on
main), [ADR 0151](0151-spade-skills-and-plugins.md) (Spade's skill store and plugins),
[ADR 0132](0132-spade-teams.md) (bot templates and bot files),
[ADR 0131](0131-spade-connectors.md) (connectors),
[ADR 0161](0161-spade-orchestration-trees.md) (grants as subsets),
[ADR 0163](0163-spade-auto-review-only.md) (one access level), ADR 0167 (what the person grants
a bot), and [ADR 0110](0110-cloudflare-relay.md), [ADR 0111](0111-account-machine-access.md),
ADR 0155 (`0155-relay-connect-in-one-round-trip.md` on main) and
[ADR 0141](0141-ace-cloud.md) (ace cloud, accounts and the relay).

## Context

People can already make things ace runs, but each kind has its own way in, and none of them helps
anyone find what others made:

- **Suits** (ADR 0150) are folders in `~/.ace/suits/`. An agent makes one; nothing installs one
  from elsewhere yet, though the ADR says a Suit can be shared and that scenes are trusted per
  version.
- **Plugins** (ADR 0014) install from a git catalog (`marketplace.json`) through a review bound
  to a commit and a content hash. The catalog lists plugins only.
- **Spade's skills** live in Spade's store (ADR 0151) with origins `ace`, `spade` and `plugin`.
  There is no way to add a skill someone else wrote, short of copying a folder by hand.
- **Spade's bots** start blank, from one of the ten templates built into Spade, or from a bot
  file another machine exported (ADR 0132, format `spade-bot` version 1). A bot file carries
  connector choices as grants, which is fine between a person's own machines and wrong for a
  file from a stranger.

The owner wants one place to find all of these, with one review before anything installs, run
by ace as a hosted service people can browse and publish to.

**A hosted marketplace doesn't conflict with ADR 0002.** That ADR is about providers: ace
reaches them only through the person's own installed, logged-in CLIs and never collects,
stores or proxies provider credentials. The marketplace touches no provider and holds no
credential of the person's. ace already runs `cloud.acehq.dev` for accounts and the relay
(ADR 0110, 0111, 0141); a second hosted service for listings is the same kind of thing.

## Decision

### 1. One marketplace, five entry types

The marketplace lists entries of these types:

| Type           | What it is                                                     | Phase |
| -------------- | -------------------------------------------------------------- | ----- |
| `suit`         | A Suit folder (ADR 0150)                                       | 1     |
| `spade-skill`  | A skill folder: `SKILL.md` and its files                       | 1     |
| `spade-plugin` | An ADR 0014 plugin, offered to Spade's bots (ADR 0151)         | 1     |
| `spade-bot`    | A bot recipe (decision 5)                                      | 1     |
| `ace-plugin`   | A plugin that extends ace itself; needs its own ADR before use | 3     |

A `spade-plugin` is an ordinary ADR 0014 plugin. Installing it accepts it in ace, as every
plugin is, so it reaches the coding agents too unless the person turns them off in the plugin's
availability; the review page says which agents and bots will have it. `ace-plugin` is reserved
for the capability ADR 0150 left out ("new panes and behaviour"). A build that doesn't support a
type lists its entries as "Needs a newer ace" and never installs them.

### 2. market.acehq.dev: its own Worker and domain

- **A separate service.** `market.acehq.dev` is its own Cloudflare Worker (`apps/market`,
  package `@ace/market`, script `ace-market`) on its own domain. `cloud.acehq.dev` keeps
  accounts and the relay (ADR 0110, 0111, 0155) and gains nothing here, so a marketplace deploy
  or fault never touches sign-in or a live relay connection, and the two keep separate secrets
  and limits.
- **Listings live in D1** (`ace-market`): publishers, entries, versions, review marks,
  categories, the featured list, withdrawals and anonymous download totals.
- **Entry bytes live in R2** (`ace-market-objects`). Each version is one archive of its folder
  (regular files and folders only), stored at `objects/<content hash>`, where the hash is ADR
  0014's content hash (sorted paths, executable bits, framed bytes). An object is written once
  and never overwritten or changed; a published version number is never reused for other
  bytes. Removing a version from the listings leaves its object, so a person who installed it
  can reinstall the same bytes.
- **The Worker serves two things:**
  - **the catalog API** the daemon reads (decision 3);
  - **a public web page** for browsing: the same entries, categories and featured list, each
    entry with its description, versions, publisher and a link that opens it in ace. The page
    follows the design language: words, not chrome.
- **Built like ace cloud.** Zod 4 schemas at every boundary, clock, randomness and fetch
  injected, pure modules for every decision. The checks (decision 7) are pure modules shared
  with the daemon and the CLI, so the Worker imports no Node code, as ADR 0110 did for the
  relay's wire.
- **Deploying the Worker is the owner's step**, with its own Wrangler configuration and
  secrets, as ace cloud's is.

### 3. The catalog API

Read routes need no sign-in and set no cookie. All live under `/v1`:

| Route                                     | Answers                                                                                                                                                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/index` (`?since=<stamp>`)        | Every listed entry's summary: type, name, title, one line, publisher, categories, keywords, latest version, reviewed, updated, download total. `ETag`; `since` sends changes |
| `GET /v1/search?q=&type=&category=`       | Ranked summaries, for the web page and any client without the index                                                                                                          |
| `GET /v1/categories`, `GET /v1/featured`  | The category list and the featured entries                                                                                                                                   |
| `GET /v1/entries/{type}/{name}`           | The entry page: description, its versions, publisher, preview                                                                                                                |
| `GET /v1/entries/{type}/{name}/{version}` | The signed version manifest, its signature and, if reviewed, the signed review mark (decision 6)                                                                             |
| `GET /v1/objects/{hash}`                  | The version's archive, `Cache-Control: immutable`                                                                                                                            |
| `GET /v1/withdrawn`                       | The signed list of withdrawn versions, with reasons                                                                                                                          |

- **The daemon keeps the index.** It reads `/v1/index` when the marketplace opens and its copy
  is over an hour old, when the person asks, and once a day for update checks, sending only
  `since` and its `ETag`. Search, categories and filters run on that copy on the machine, so a
  query never leaves it and works offline. A small delta also suits slow links.
- **Every request is https** to `market.acehq.dev` (a different origin only through a
  development setting). A fetch that fails keeps the last index and says when it was read.

### 4. Two sources

- **market.acehq.dev**, on by default. The person can turn it off.
- **Person-added git catalogs** (ADR 0014), for private or company catalogs. An https git
  address, fetched with ADR 0014's fetcher (shallow bare fetch, isolated config, no hooks,
  nothing checked out or run). ADR 0014's `marketplace.json` gains an optional `entries` list
  beside `plugins`, each `{type, name, source, hash?, title?, description?, version?,
keywords?}` with `source` a folder in that repository, as 0014 has it. A catalog with only
  `plugins` reads as before, each as a `spade-plugin`. Git catalogs carry no signatures, no
  review marks, no categories and no featured list; their entries say "From <address>".

Both sources produce the same entry model in a new `@ace/marketplace` package (the index cache,
the git catalog reader, search ranking, verification and reviews, as pure modules around thin
fetch and git shells). It reuses `@ace/plugins`' fetcher, path rules and hashing, and adds no
second git path. Schemas live in `@ace/protocol/marketplace`. Unknown types and fields from
either source are kept as raw data and listed as unsupported, never dropped and never fatal.

### 5. Entry formats

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
- `routines` arrive paused, unless the person turns them on in the review (decision 8).
- `skills` name `spade-skill` entries from the same source, or folders inside the recipe
  (`skills/<name>/`); `plugins` name `spade-plugin` entries from the same source. A recipe
  can't name another source's entries, so one review covers everything it brings.
- `needs.connectors` name a catalogue connector by id (`spade/config/connectors.json`) or a
  server by https address, each with a reason and whether the bot works without it. `needs.tools`
  can only narrow the bot's built-in tools (ADR 0161: unset means all); it can't add any.
- Never a key, token, webhook secret, model id, endpoint, conversation, knowledge entry or
  grant. A recipe holding anything named like a secret is refused whole, as ADR 0137 does.
- A version 1 bot file still imports as ADR 0132 says, between the person's own machines. In
  the marketplace it is read as a recipe: its connector choices become needs.

### 6. Trust stays on the device

The Worker is a distributor, not a trust root. What a person installs is decided by checks the
daemon runs itself:

- **A signed version manifest.** Each listed version has a manifest: `{format, type, name,
version, publisher {id, name}, hash, files: [{path, bytes, executable, sha256}], size,
published, key}`, signed with Ed25519 by an ace marketplace key. Builds ship the public keys
  (two at a time, so a key can rotate; `key` names which one signed). The daemon verifies the
  signature, then that the archive's content hash and every file match the manifest. Anything
  that fails is refused, whatever the Worker says. Signing uses `@noble/ed25519`, already
  shipped in `@ace/account-grant`.
- **The signing key is kept off the Worker.** It lives with the signer, a maintainer tool
  (`ace market sign`) run on a maintainer's machine. The signer pulls versions that passed the
  Worker's checks, runs the same checks again on the bytes from R2, signs the manifests and
  uploads the signatures. A version is listed only once signed. The review mark (decision 7) is
  signed the same way, as `{hash, reviewed, key}`, so "Reviewed by ace" on a device is the
  signer's word, not the Worker's.
- **Withdrawals are signed too.** `GET /v1/withdrawn` is a signed list of content hashes and
  reasons. An installed entry on that list is turned off, never deleted (a Suit stops being
  worn, a skill leaves search, a plugin is off for every agent and bot) and shows the reason;
  the person can turn it back on or remove it. A bot made from a withdrawn recipe is the
  person's and is left alone.
- **Pinned on acceptance.** What the person accepts is the review's content hash. The daemon
  keeps the accepted bytes in its marketplace registry and checks the hash on every read, so a
  compromised Worker can't change what a person already accepted: at most it can offer a new
  version, which needs a new signature, a new review and a new acceptance.
- **Nothing runs during fetch, review or install** (ADR 0014's rules, for every type). A Suit's
  scene runs only when the Suit is worn, in its sandbox (ADR 0150). A plugin's hooks and servers
  run only after acceptance, for agents and bots it is allowed for. A skill's scripts run only
  when a bot runs them under the gate (ADR 0151 point 5). A recipe's routines start paused.
- **Git catalogs** have hashes and reviews but no signature: ace vouches only for what it
  signed.

### 7. Publishing and official review

- **Publishers sign in with their ace account**, the same WorkOS sign-in `cloud.acehq.dev` uses
  (ADR 0111). The account backend mints a grant for the market (`aud: "market.acehq.dev"`,
  `purpose: "market-publish"`), which the Worker verifies with `@ace/account-grant` against the
  backend's published keys; `cloud.acehq.dev` refuses that grant, and the market refuses relay
  and machine grants. On the web page, signing in sets a short session cookie scoped to the
  publishing routes only. On first publish, the account picks a publisher name, unique across
  the market. Browsing and installing never need an account.
- **Uploading a version.** `POST /v1/publish/{type}/{name}/versions` takes the folder's archive
  and a version number. The Worker runs the server-side checks before anything is listed, the
  same ones `ace marketplace check <path>` runs on a publisher's machine:
  - format: the type's schema, archive layout, paths (ADR 0014's containment rules), no links;
  - limits: the type's file, size and count caps;
  - Suits: ADR 0150's static checks (contrast on every surface, accent fit, the glass floor,
    `suit.css` rules); a Suit's live check needs a rendered app and runs on the device;
  - recipes and skills: no secrets (patterns for keys and tokens, and anything named like one),
    recipe rules (`needs.tools` only narrows, no foreign references).

  A version that fails gets its problems back, line by line, and is never listed. One that
  passes is stored in R2 under its hash, waits for the signer, then is listed. A publisher can
  withdraw their own version; the signer signs the withdrawal.

- **Official review.** ace's maintainers mark entries reviewed after reading them; the signer
  signs the mark. Only reviewed entries appear in Featured and in the categories. Entries not
  reviewed are still found by search and by link, and say "Not reviewed by ace" on their review
  page. ace's own entries say "By ace".
- **Export.** A Suit's ⋯ menu gains "Export"; a store skill's gains "Export"; a bot's profile
  gains "Export as recipe", which writes a version 2 recipe: grants become needs, notes are
  included only if the person ticks them, and nothing secret is written. An export is a folder
  (or a zip of it) that `ace marketplace check` accepts, ready to publish or to commit to a git
  catalog. From phase 2, each export also offers "Publish".

### 8. Install, update and remove

The daemon is the one fetcher and reviewer for every type and source. Each type then lands with
the part of ace that already owns it:

| Type           | Lands in                                                                                                       | Removed by                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `suit`         | The daemon's Suit library, `~/.ace/suits/<id>/`, through a new `install`                                       | Suit `remove`; a device wearing it goes back to ace's theme                          |
| `spade-skill`  | A pinned copy in the daemon's marketplace registry; Spade copies it into its store with a new origin, `market` | Dropped from the registry; Spade drops the copy and the workspace files on next sync |
| `spade-plugin` | ADR 0014's plugin manager (accept), then allowed for the bots the person picked (ADR 0151 point 8)             | ADR 0014 removal, which also ends every bot's allow                                  |
| `spade-bot`    | A new bot, made by Spade from the recipe (`POST /v1/agents` with `recipe`)                                     | Nothing to remove: the bot is the person's, deleted like any bot                     |

- **Installing.** `prepare` fetches the version (from R2 by hash, or a git catalog at its
  commit), verifies it (decision 6), runs the type's checks again and returns a review.
  `install` needs that review's id and content hash, as ADR 0014's accept does, plus the
  person's choices (which bots get a plugin, which grants a recipe gets). A recipe installs its
  skills and plugins first, each under its own record, then makes the bot; a step that fails
  undoes the steps before it and nothing is half installed.
- **The review page** names the entry, publisher, source, version and hash, whether ace
  reviewed it, then what it can do, in plain sentences, by type:
  - a Suit: whether it passes ace's checks, whether it has scenes ("Runs its own animation,
    sandboxed"), its fonts and file count. A Suit that fails can't be installed;
  - a skill: `SKILL.md` as text, its files, each script or binary flagged;
  - a plugin: ADR 0014's review (hook commands, server commands with arguments, environment and
    folder, remote addresses), and which coding agents and which bots will have it;
  - a bot recipe: its face, name, task in full, model kind, routines with their schedules, the
    skills and plugins it brings (each with its own section above), and every need.
- **A recipe's needs are asked for, never granted by the file.** Each needed connector and
  plugin is a row with a switch: required ones start on, optional ones off, and nothing is
  granted until the person presses Install with the switches as they set them. That press is the
  person's grant, recorded as ADR 0167 records grants. A connector the person hasn't connected
  shows "Connect after install". Grants never exceed what ADR 0161 allows (a bot made from a
  recipe is a top-level bot), and the access level is ADR 0163's one level, so there is nothing
  to choose. "Start its routines" is a switch, off by default.
- **Market skills in Spade.** Spade lists the daemon's market skills and fetches each skill's
  files the way it copies ace's library (ADR 0151 point 2): replaced whole on a hash change,
  last copy kept with ace away. They are read only and, like every store skill, serve every bot.
  **Add to ace's library** (ADR 0151 point 3) is offered on each, for a person who wants the
  coding agents to have it too.
- **Updates.** The daily check compares each installed entry with its source. A newer version
  shows as "Update" on the entry and in Installed, never applied on its own (ADR 0014: there is
  no automatic update path). Updating shows what changed (added, changed and removed files,
  executables flagged, `SKILL.md` or `suit.json` before and after; for a plugin, 0014's full
  review again) and needs a new acceptance.
- **Bots don't update.** A bot made from a recipe belongs to the person from then on. It
  records `from_recipe {source, name, version}`, shown in its profile. A newer recipe never
  changes the bot; its skills and plugins update as their own entries.
- **Spade Cloud** (ADR 0140) has no marketplace in phase 1: it never reaches a daemon. Spade on
  the person's machine installs a recipe only while Spade runs; otherwise the review says
  "Spade isn't running".

### 9. Offline and signed out

- Browsing and installing need no sign-in.
- The daemon keeps the last index it read and the accepted bytes of everything installed, so
  the marketplace browses offline (installing a new entry needs its bytes, so it waits for a
  connection) and installed entries never need the network.
- The ten built-in templates still ship in Spade, so New bot from a template works with no
  network. They are also the market's first recipes.
- Nothing else in ace waits on `market.acehq.dev`: not start, not sign-in, not a thread, not a
  Suit already worn.

### 10. Privacy

- No per-person install tracking. Reads carry no account, device or machine id and no cookie,
  and the Worker stores no address. Rate limits use Workers rate-limit bindings, which keep
  counters in memory only.
- No logs of who searched. The daemon searches its own copy of the index, so its queries never
  reach the Worker. The web page's search is answered and forgotten; request logs for read
  routes are off.
- **Download totals are kept, anonymously.** Each version has one counter in D1, incremented
  when its object is fetched, with nothing about who fetched it. Entry pages show it as a meta
  fact. It never decides Featured, which is chosen by maintainers.
- Publishing is tied to an ace account, because a publisher's name must mean the same account
  every time. The market stores that account's id and publisher name and nothing else from it.

### 11. Discovery

- **Search** on the device ranks name, then title, then description and keywords, rarer words
  counting more, forgiving a typo, as a pure function in `@ace/marketplace`. Results narrow by
  type, category and source.
- **Categories** are the market's list (a dozen or so, kept by maintainers); an entry names up
  to three. Only reviewed entries are listed under them.
- **Featured** is a short list maintainers pick from reviewed entries, shown first when nothing
  is searched.
- **No ratings in phase 1.** Ratings need moderation and protection from gaming that the first
  version shouldn't carry, and the review mark, publisher and download total already say a
  good deal. With accounts in place, ratings can come later on the hosted service under their
  own decision.

### 12. Where it lives in the app

The marketplace is one surface for every type, with a type filter. Its layout, at the level of
places (no mockup here):

- **A place in the rail**, after Skills, named Marketplace (a new glyph in `@ace/icons`, ADR
  0156). Its panel follows DESIGN.md's panel pieces: the title row with a filter menu in words
  ("Everything", then Suits, Skills, Plugins, Bots); "Search marketplace"; then panel rows:
  Featured, the categories, Installed, Updates (its count as a trailing word), Sources.
- **The main column** lists entries as rows: title, one line, and the type and publisher in meta
  ink. A bot recipe's row shows its face; a Suit's its preview. No stars, no badges, no icons on
  buttons. An entry opens a full page in the main column (as pull requests do): its description,
  what it brings, publisher, source, version, whether ace reviewed it, and one action at the
  title row's right: Install, Update or Installed. Install opens the review, whose last action is
  Install.
- **Entry points elsewhere**, each opening the marketplace with the filter set, as one text
  action: Settings › Spade › Apps (which Spade's list top button opens) gains "Browse the
  marketplace", filtered to skills, plugins and bots; Spade's new-bot flow gains "From the
  marketplace" beside the templates; Settings › Appearance gains "Find Suits"; the Skills
  place's Add menu gains "From the marketplace". A link from the public web page opens the entry
  here.
- **Phones.** Suits stay off the phone apps (ADR 0150). The iPhone gets the Spade types later,
  through the daemon, in the phone's own grammar.

### 13. Wire and modules

- `marketplace.request {requestId, operation}` / `marketplace.result {requestId, result}` in
  `@ace/protocol/marketplace`, beside ADR 0014's plugin envelopes. Operations: `sources`,
  `addSource`, `removeSource`, `refresh`, `search`, `read`, `prepare`, `readReview`, `install`,
  `cancel`, `installed`, `prepareUpdate`, `remove`, and from phase 2 `publish`. Reads need the
  device read scope; the rest need admin, as plugin mutations do.
- `publish` has the daemon mint the market grant with the machine's ace session (as it does for
  the relay and Spade Cloud), so the app never handles a market credential itself.
- `marketplace.spade` for Spade: the installed market skills with hashes, and one skill's files,
  in the shape of `skills.request` `files` (ADR 0151 point 4).
- The Suit library gains `install`. Spade's `POST /v1/agents` gains `recipe` (the parsed recipe
  and the person's choices), made through the daemon's link to Spade.
- Reviews are bounded and paged as ADR 0014's are; pending reviews are in memory and expire
  after 30 minutes or on restart, as ADR 0103's do.

## Open for the owner

Each has a recommendation, which this ADR assumes until the owner says otherwise:

1. **Where the marketplace opens: a rail place after Skills, a Settings page, or inside the
   Skills place (renamed Library)?** Recommended: a rail place, since Suits and bots aren't
   skills and Settings is for settings.
2. **Market skills: Spade only, or also offered to the coding agents at install?** Recommended:
   Spade only, with ADR 0151's "Add to ace's library" for the person who wants both.
3. **A recipe's required needs: switches start on, or everything starts off?** Recommended: on
   for required, off for optional; nothing is granted until Install either way.
4. **Spade Cloud bots from recipes,** with no daemon there: later, through a recipe the person's
   own Spade sends to the cloud, or never? Recommended: later, not in phase 1.
5. **Where the signer runs** (new with the hosted market): on a maintainer's machine, so a new
   version waits for the next signing run, or as a separate small service holding the key away
   from the market Worker? Recommended: a maintainer's machine in phase 1, while volume is low.

## Phases

1. **The service, the client and the UI.** The `market.acehq.dev` Worker (D1, R2, the catalog
   API, the web page, the publish API with its checks), the signer, the daemon's client and
   verification, git catalogs as the second source, and the marketplace in the app. Maintainers
   seed it with ace's own Suits, the ten templates as recipes and a first set of skills, through
   `ace marketplace publish`. Deploying the Worker is the owner's step.
2. **Publishing from the app**: Export and Publish on Suits, skills and bots, and the web page's
   upload for any signed-in publisher. The iPhone's Spade types follow in this phase.
3. **ace plugins**, once an ADR defines what a plugin may add to ace itself.

## Options considered

- **A Spade-only marketplace.** The first plan. Rejected by the owner: Suits and future ace
  plugins need the same review and discovery, and two stores would duplicate the logic.
- **Git catalogs only.** The first draft of this ADR: no hosted service, an official catalog in
  a git repository taking pull requests. Superseded by the owner's choice of a hosted market:
  publishing by pull request asks too much of most people, and a hosted index gives search,
  categories and a public page. Git catalogs stay as the second source.
- **Serving the market from `cloud.acehq.dev`.** One Worker fewer, but a marketplace deploy or
  fault would share a script with sign-in and the relay, whose Durable Objects must never be
  disturbed (ADR 0141 decision 3). Its own Worker and domain keep the blast radius apart.
- **Trusting the Worker's answers.** Simpler, but anyone who took the Worker or its Cloudflare
  account could serve anything. The signed manifest, a key off the Worker and hash pinning on
  the device mean they can't.
- **Signing on the Worker.** Faster listing, but the key would sit with the thing it protects
  against. Rejected.
- **Searching on the Worker for every query.** Rejected for the daemon: it would send every
  query out and fail offline. The daemon keeps the index; the web page uses the search route.
- **Auto-updating Suits and skills, which run no code by themselves.** Rejected for one rule
  everywhere: a skill's scripts and a Suit's scenes are code, and a person reviews each version.

## Consequences

- One place to find, install and publish what people make for ace, with one review and one
  trust rule.
- A new hosted service, `market.acehq.dev`, with D1 and R2 and its own deploy, kept apart from
  `cloud.acehq.dev`.
- A signing key and a signer to keep, off the Worker; listing waits on the signer.
- Existing plugin catalogs keep working; git catalogs gain typed entries.
- Spade's skill store gains the `market` origin; bot files gain version 2; the Suit library
  gains `install`.
- The checks become pure modules shared by the Worker, the daemon and the CLI.
- Without ratings, quality rests on the review mark, the publisher's name and the download
  total.

## Tests

Pure tables in `@ace/marketplace` and the shared checks: index and catalog parsing (unknown
types and fields kept, unusable display values dropped, duplicate names refused), manifest
verification (bad signature, unknown key, hash or file mismatch all refused), withdrawals,
search ranking, recipe parsing (secrets refused, `needs.tools` only narrows, foreign references
refused), Suit static checks. Worker tests through its HTTP API on local D1 and R2:

- an upload that fails a check is never listed and returns its problems; one that passes waits
  unlisted until signed;
- a stored object is never overwritten, and a version number can't be reused for other bytes;
- only reviewed entries appear in Featured and categories;
- read routes store no address and set no cookie; a download raises only the version's total;
- a publish without a market grant, or with a relay or machine grant, is refused.

Daemon process tests against a real local HTTP server standing in for the market, and real
local git repositories:

- a version whose archive doesn't match its signed manifest is refused at review and at
  install;
- with the server down, the marketplace browses from the last index and installed entries work;
- a withdrawn entry turns off and is not deleted;
- a Suit that fails ace's checks can't be installed; one that passes lands in the library and
  isn't applied;
- a market skill reaches Spade's store with its files, is replaced on update and gone on remove;
- a bot recipe installs its skills and plugins, then makes a bot with routines paused and only
  the grants the person left on; a failure making the bot leaves nothing installed;
- an update is listed and not applied until accepted;
- nothing from an entry runs during prepare or install (a planted hook, script and scene record
  nothing).
