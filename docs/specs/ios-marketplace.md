# The marketplace on the iPhone

Status: draft, 2026-11-21. Builds on [ADR 0168](../adr/0168-ace-marketplace.md) (the
marketplace), [ADR 0174](../adr/0174-market-publishers-discovery-and-scanning.md) (discovery and
the scan), [ADR 0178](../adr/0178-one-cli-grammar-interactive-home-and-market.md) §11 and §12.8
(the market through the daemon, content-only installs), [ADR 0190](../adr/0190-a-machine-keeps-a-machine-credential.md)
(the person's standing), [ADR 0150](../adr/0150-suits.md) (Suits),
[ADR 0074](../adr/0074-native-ios-client.md) (the iPhone app) and
[ADR 0184](../adr/0184-iphone-actions-are-controls.md) (actions are controls).

## Problem

The marketplace lives only in the desktop and web app. Someone away from their computer can't
find a bot, skill, plugin or Suit, can't install one onto their machine, and can't see that an
update is waiting or that a skill they installed is still off for their bots. The iPhone already
has Skills and plugins and Spade's bots, but nothing that reaches the market.

## Solution

A Marketplace on the iPhone that browses, searches and installs onto the paired machine through
that machine's daemon, the same way the web does. It follows the web's store layout (PR #2473:
shelves of rows, each with its own button, one search, an entry page with one action) and does
the phone's version of each part: sheets for the review, swipe actions on installed rows,
haptics on install and remove, and ace's own icons only.

### What comes in v1

- Discover: the hero, Featured, Trending this week, New and notable, collections and top
  publishers, as the daemon's `discover` answers them, with the device's own listings as a
  fallback (`home`).
- Search across every type, with a type filter (Everything, Bots, Skills, Plugins, Suits) and
  categories.
- Sources: the market and any person-added git catalogs, listed with when each was last read,
  turned on or off, refreshed, added and removed.
- The entry page: picture or face, title, one line, publisher with the verified or "By ace" mark,
  one action (Get, Update, Installed, or why it can't), then what it may do, the review mark,
  versions, download total and source. A publisher's public page, read only.
- Install through the review, for every type the daemon installs (`suit`, `spade-skill`,
  `spade-plugin`, `spade-bot`); remove; restore a withdrawn or turned-off entry.
- Installed and updates: everything installed, updates first, each update through its review.
- Bots approval: a skill installed without the person's standing shows "Installed · Turn on for
  your bots", and the person turns it on from the phone.
- The person's standing on the iPhone (ADR 0190 §7), which installing a bot or a plugin and
  turning a skill on for bots both need.

### What waits

Publishing, managing listings and their signals, editing a profile, reports, transfers and
verification. Apps (Spade's connectors) stay in Settings › Spade; the web's Apps shelf comes
when the phone can connect a new app.

## Behaviour

### Reaching the market

1. Every marketplace call goes to the paired machine's daemon as `marketplace.request`, over the
   bridge. The phone never calls `market.acehq.dev`, holds no market credential, and never
   sends a provider credential anywhere (ADR 0002). Search runs on the machine's copy of the
   index, so a query never leaves the machine.
2. The phone shows the marketplace of the machine it is looking at. With more than one machine
   paired, the Marketplace's title menu names the machine and switches it, and every install
   says which machine it lands on ("Install on arpan-mbp").
3. When the daemon reports `marketplace.changed`, the home, Installed and any open entry page
   read again. A review the phone holds is not re-read.

### Offline and errors

4. With the machine unreachable, the Marketplace shows the last answers the phone kept, with
   the connection banner, and Get, Update, Remove and Turn on are disabled with one line saying
   the machine is offline. Nothing is queued to run later.
5. With the machine online but the market unreachable, the daemon's last index still browses
   and searches, and the home says when the listings were last read ("Listings from 2 hours
   ago"). Install waits for the market; its sentence says so.
6. Each failure is one sentence from the daemon's error code (the web's `failureSentence`
   rules, shared, not copied), in the problem row's colour, with its way out as a button: Try
   again, Confirm it's you, or Open on your computer.
7. A review older than the daemon's 30 minutes (`expired`) or replaced (`conflict`) is dropped,
   and the sheet offers to read it again. Any other refusal keeps the review open so Install
   can run again.
8. An entry of a type this build can't install reads "Needs a newer ace" and has no Get.

### Install, update and remove

9. Get on a row or an entry page opens the review as a sheet (medium detent, growing to large),
   titled "Get <title>". The review is prepared on the daemon and every page of it is read
   before Install is enabled.
10. The review shows, in order: who published it, signed or not, ace's review mark or "Not
    reviewed by ace", what it can do in plain sentences (the web's `canDoSentences`), every
    finding of the device scan as a sentence with its level, then by type: a Suit's check
    result and scenes; a skill's `SKILL.md` and its files with scripts and binaries flagged; a
    plugin's commands, servers and remote addresses, and which agents and bots will have it; a
    bot's face, task, model kind, routines, the skills and plugins it brings and each need.
11. A bot's needs and a package's effects are switches as the daemon starts them (required on,
    optional off). "Start its routines" is off. A plugin asks which bots it is allowed for.
    Nothing is granted until Install is pressed.
12. A review with `blocked` set shows that sentence and no Install.
13. Install sends the review's id and hash with the choices. On success the phone plays a
    success haptic, the sheet closes, the row's button becomes Open or Installed, and Installed
    gains the entry. On failure the sheet stays open with the sentence (item 6).
14. Installing a bot or a plugin, and turning a skill on for bots, need the person's standing.
    A phone that has proved it installs them like the web. One that hasn't gets Confirm it's
    you, which proves standing (item 22) and retries once; until the phone can prove it, the
    row says "Install this from your computer" and offers Open on your computer.
15. A Suit installs onto the machine. The phone doesn't wear Suits, so the entry page says
    "Installed on arpan-mbp. Wear it from ace on your computer."
16. Swiping an installed row offers Remove (destructive, with a confirmation dialog naming what
    goes: "Remove Inbox's skills and plugins? The bot stays yours."). A withdrawn or turned-off
    row offers Turn back on. Removing plays a warning haptic.
17. Update opens the same review sheet in update mode, which also lists what changed (added,
    changed and removed files, executables flagged, text before and after). A bot made from a
    package updates or rolls back per bot.

### Installed and updates

18. Installed lists updates first, then everything else, each row with its type, version and
    machine. A withdrawn entry shows the publisher's reason and is off. The Marketplace's entry
    point shows the update count as a trailing word ("2 updates").
19. Pull to refresh asks the daemon to read its sources again, with the pull-to-refresh haptic.

### Bots approval

20. A Spade skill installed without the person's standing shows "Installed · Turn on for your
    bots" on its Installed row and its entry page, with Turn on as a button. It turns on exactly
    that version's hash.
21. An update to a new hash is unapproved again and shows the same row.

### The person's standing

22. Pairing from a person's link names a standing key: a P-256 key the phone makes in the Secure
    Enclave, never exportable, kept for that machine. On every socket the phone answers the
    daemon's challenge with `device.standing`, signed by that key over the channel binding.
23. A phone paired before this has no standing; Settings › Machines says so on the machine's
    row with Pair again, and the marketplace's Confirm it's you leads there.

### Where it lives

24. Marketplace is a place: a tile in Search's Places grid after Skills, and a row in Settings'
    tools after Skills and plugins. Both open the same page, pushed in Search and in a sheet
    from Settings, as the other places do.
25. Spade's New bot sheet gains "From the marketplace", which opens it filtered to bots, and
    Skills and plugins gains "Browse the marketplace", filtered to skills and plugins.
26. A web `?market=` link opened on the phone, and a new `ace://market?at=<type>/<name>` link,
    open the entry page.

### Phone-specific UX

27. Shelves scroll sideways; rows are full width with the button at the trailing edge, at least
    44 points tall. A long press on a row offers Share link, Open publisher and, when installed,
    Remove, as a context menu.
28. Icons are ace's own set only (generated from `@ace/icons`), never SF Symbols. The Marketplace
    is `@ace/icons`' storefront glyph, added to the phone's generated set (it isn't there yet).
    Bots draw their own face.
29. Haptics: success on install, update and turn on; warning on remove; selection on the type
    filter. Nothing else.
30. At accessibility text sizes, rows stack and shelves become vertical lists. VoiceOver reads
    a row as title, type, publisher, then its button.

## Decisions

- **The bridge owns the words.** A new bridge service answers native market requests and sends
  Swift rows and pages with their words already written, as the skill library and plugins
  services do. Swift draws and does not decide.
- **One set of word rules.** The pure rules in the web's market model and package words (type
  names, install blocks, the entry action, failure sentences, scan finding sentences, need
  defaults, can-do sentences, effect defaults) move to `@ace/ui-core` behind a `market` export.
  The web imports them from there; the bridge does too. Duplicating them is a bug (AGENTS.md).
- **No new daemon or protocol work** for browse and install: every operation in v1 already
  exists in `MarketOperation` and the publish-ops `discover`, `publisher` and `picture`. The
  standing work uses ADR 0190's existing `standingKey` and `device.standing`.
- **Pictures** come through `picture` by hash, cached on the phone by hash, since a hash never
  changes its bytes.
- **The review stays on the daemon.** The phone holds the review id and hash only while the sheet
  is open, and cancels it when the sheet is dismissed without installing.

## Testing

- Bridge: vitest tests in `apps/ios/bridge` against the fake daemon's market, as
  `skill-plugins.test.ts` does: rows and words for discover, search, review pages, install,
  update, remove, turn on, each error code, and the offline answer.
- Shared words: unit tests move with the rules into `@ace/ui-core`; the web's market tests keep
  passing unchanged.
- Swift: model tests in `apps/ios/Tests` for decoding the bridge's rows and for the review sheet's
  state (Install disabled until every page is read, kept on refusal, dropped on expiry).
- Standing: a bridge test for the proof text and a process test that a re-paired phone's socket
  installs a plugin while an old pairing gets `reauth`.
- One combined iPhone UI run on main after the slices land, not per PR.

## Plan

Six slices, one PR each. Slice 1 and slice 5 start now. Slices 2, 3 and 4 start when slice 1
merges and run in parallel. Slice 6 needs 1 and 5.

Slice 1 creates every Swift file the later slices fill, as small stubs with their final
initialisers, so slices 2, 3, 4 and 6 each own their files outright and don't edit each other's.
The bridge is split the same way, one file per area, so a later slice that needs a word changed
touches only its own area's file.

Paths below are under `apps/ios/` unless they say otherwise; Swift views are in
`Sources/Views/Market/`, models in `Sources/Models/`.

1. **Foundations** (#2498). Blocked by nothing. Owns: `packages/ui-core/src/market/` (a new `market`
   export holding the rules moved out of the web's `market-model.ts` and
   `market-package-words.ts`, which then import them); `bridge/market.ts`, `market-home.ts`,
   `market-review.ts` and `market-installed.ts` with their tests; the market lines in
   `bridge/native-services.ts` and `bridge/read-policy.ts`; `NativeMarket.swift` and
   `ClientModel+Market.swift`; `MarketplaceView.swift`, `MarketRoute.swift` and stubs of
   `MarketHomeView`, `MarketEntryView`, `MarketReviewSheet`, `MarketInstalledView` and
   `MarketBotsApproval`; the Marketplace entries in `SearchPlaces.swift` and
   `SettingsTools.swift`; the storefront glyph in the phone's generated set.
2. **Browse** (#2500). Blocked by 1. Discover, search, the type filter, categories, sources and the
   publisher page. Owns `MarketHomeView`, `MarketShelf`, `MarketRow`, `MarketSearch`,
   `MarketCategoryView`, `MarketSourcesView`, `MarketPublisherView` and `bridge/market-home.ts`.
3. **Entry page and install** (#2501). Blocked by 1. The entry page, the review sheet, install, remove
   and restore. Owns `MarketEntryView`, `MarketReviewSheet`, `MarketReviewSections`,
   `MarketChoices` and `bridge/market-review.ts`, plus the links in from Spade's New bot sheet,
   Skills and plugins, and `ace://market`.
4. **Installed and updates** (#2502). Blocked by 1; its Update opens slice 3's sheet, so it merges after 3. Owns `MarketInstalledView`, `MarketInstalledRow` and `bridge/market-installed.ts`.
5. **The person's standing on the iPhone** (#2499). Blocked by nothing. The Secure Enclave key, naming
   it at pairing, answering `device.standing` on every socket, and Pair again on the machine's
   row. Owns the pairing and socket code it changes in `Sources/Bridge`, `Sources/Relay`,
   `Sources/Views/Pairing`, `Sources/Views/Machines` and the bridge's pairing module. Touches no
   marketplace file.
6. **Bots approval and Confirm it's you** (#2503). Blocked by 1 and 5. Owns `MarketBotsApproval`,
   `MarketConfirmPerson` and the person-only paths in `bridge/market.ts`.

## Out of scope

Publishing, manage, profile editing, reports, transfers, verification, Apps (connectors),
organization registries, wearing a Suit on the phone, and the iPad's split layout beyond what
the system gives.

## Open questions

- **Navigation.** Recommended: a place (Search tile and Settings row), not a tab. The bar already
  holds Projects, Chats, Spade, Code review, Search and New thread, and the market is visited,
  not lived in. The owner may want it in the bar instead.
