# 0187: A Spade bot moves between machines, and the person chooses where Spade lives

Status: accepted. Date: 2026-11-18. Decided by: the owner (2026-11-18: any bot, the main Spade
included, can be moved to another machine of the fleet with its memory copied, and the person
chooses which machine hosts the main Spade; that choice never moves by itself). Amends
[ADR 0127](0127-spade-main-bot-and-chat.md) decision 2 ("Spade, the main bot, lives on the first
machine where Spade was turned on"). Builds on [ADR 0132](0132-spade-teams.md) (bots on other
machines, through the daemons' `spade` machine call), [ADR 0119](0119-spade-endpoint-keys.md)
(keys stay in each machine's keychain), [ADR 0167](0167-spade-security-boundaries.md) (grants and
sandbox) and [ADR 0170](0170-daemon-never-blocks-on-history-sized-work.md).

## Context

ADR 0127 put a bot on the machine the person picks when they make it, and Spade, the main bot, on
the first machine where Spade was turned on. With several machines in the fleet the app had to
find that machine, and it did so by election: every window kept the oldest main bot it could read
and sent `PUT /v1/main {"enabled": false}` to every other machine (`spadeHostPlan`,
`useOneSpade`). The switch-off was stored, so the iPhone lost that machine's Spade too, and the
election moved Spade on its own: with the oldest machine offline another machine's Spade was
turned back on, and when the oldest returned that one was switched off again.

People also outgrow a machine: a bot made on a laptop should be able to live on the always-on
desktop. Export and import (ADR 0132 decision 13) make a new bot from a file with its task, face,
routines and notes, but never its conversation, knowledge, workspace or anything it learned.

## Options considered

- **Keep the election, add stickiness.** Still decided by whichever window reads first, still
  moves Spade when a machine is offline at the wrong moment.
- **Export to a file, import there, delete here.** The person carries the file, nothing checks
  the copy, and a failure halfway leaves two bots or none.
- **The app copies the bot between the two Spades.** Dies with the window: a closed laptop lid
  leaves a half-copied bot that nobody finishes.
- **Chosen: the source Spade moves the bot itself, over the same machine call bots already use
  (ADR 0132), as a copy then a commit,** stored as it goes so a restart on either side carries on
  or undoes it. The host of the main Spade is a stored choice that the person makes and that only
  a move changes.

## Decision

### Where the main Spade lives

1. **A fleet-wide choice, stored on each machine.** Spade's host is a record
   `{host, version, at, by}` (`host` is the machine's ace host id). Each Spade keeps the newest
   record it has seen; a record replaces another only when it is newer: a higher `version`, then
   a later `at`, then the higher `host`. A Spade shows its main bot only while the record names
   its own machine. A machine that holds no record yet keeps its old behaviour until it hears
   one, so nothing changes before the person's fleet has a choice.
2. **Only a move changes it.** Nothing elects a host any more: the app's election and its
   automatic switch-offs are removed, and there is no host choice by hand: the person moves
   Spade. A main move is started only by the current host (the record names it and its Spade is
   in use) and taken only by a machine that holds no newer record than the one the move began
   with; the record it produces is exactly one version on. While the chosen machine is offline,
   Spade shows as away, as any bot on an offline machine does (ADR 0127 decision 2), and comes
   back with it.
3. **The first record is today's Spade, and records travel only as their host holds them.** A
   window that reads every machine and finds no record on any writes one, once (`by: "seed"`),
   naming the machine that shows Spade now (the oldest main if several do, else the window's own
   machine), on that machine first. Every `PUT /v1/main/host` needs the person's stamp (the
   daemon adds it, over the whole record). A machine takes a seed naming itself only while it
   holds no record; it takes any record naming another machine only once that machine, asked
   over this machine's own link (`op: "host"`), holds exactly that record. So the window copies
   the newest record on to the rest, and no caller can assert a host the host itself doesn't.
4. **Old switch-offs heal once.** `PUT /v1/main {"enabled": false}` was only ever sent by the
   election, so a stored switch-off is dropped the first time the machine learns a record, and the
   record alone decides from then on. A deliberate switch-off is a new, separate field
   (`{"enabled": false, "by": "person"}`), kept until the person turns Spade back on there; an
   old app that still sends the plain form changes nothing once a record exists.

### Moving a bot

5. **Any bot can move, Spade too, to an online machine of the fleet that runs Spade, only with
   the person's say on both machines.** The person starts it from the bot's profile (Move to…, or
   Move Spade to this machine); the CLI has `ace spade move <bot> --to <machine> --target-remote
<profile>`. The machine the bot is on reserves, freezes and packs it, asks the other machine
   which device its daemon knows this one by (`whoami`, the authenticated `x-ace-from-host`), and
   says what to accept: the manifest's SHA-256 and that device. Then the person accepts exactly
   that on the machine it goes to, `PUT /v1/moves/{move}/accept {bot, from, via, to, digest,
replaces}`: the bot, the machine it comes from and the device it speaks as, the machine it goes
   to, the manifest by its hash, and whether it replaces Spade (`main`) or nothing (`bot`). It is
   a change only they may make: that machine's daemon forwards it only from a caller with their
   standing and stamps it as theirs over all of it (the person stamp of ADR 0163 amendment 2,
   `x-ace-person`, over `move:<move>` and `accept:<bot>:<from>:<via>:<to>:<digest>:<replaces>`,
   single use); Spade refuses it unstamped, for another machine, or to replace a Spade in use
   there. The app does both in one click; until the say arrives the move waits, saying so. Every
   step of the move (`begin`, `part`, `commit`, `status`, `abort`) must come from the accepted
   device, as the daemon authenticated it: another paired machine that learns the move's id and
   even its manifest can neither claim, feed, read nor abort it.
6. **What moves.** The bot and the worker bots it made (ADR 0161), each with its conversation and
   its helpers' hidden conversations (ADR 0152): every event, so its history, goals, plans, wakes
   and decision log come along; its notes, knowledge base and links, episodes and digests;
   routines and their past runs; the skills it used and how; its read marks, pins, face (a picture
   face's image, and every image its conversation shows), spending ledger, and its own settings
   from a fixed list (oversight, digests, model roles, the recipe it came from, security, its
   knowledge limit); the clubs (groups, ADR 0132) it leads, with their transcripts; and its
   workspace folder, file by file.
7. **What stays.** Endpoint API keys (they live in each machine's keychain, ADR 0119; the bot keeps
   its model choice and the result names each endpoint to add there), webhook secrets (never
   exported, never in the archive; the target makes new ones), connected apps' sign-ins, the
   computer's browser profile and sign-ins, plugin approvals to run outside the sandbox, workspace
   checkpoints (snapshots of this machine's files), and the bytes of documents and recordings
   attached to its messages (the messages keep their words; images move). Links in the workspace
   are not followed and stay behind, named in the result. **The person's consent never crosses
   machines**: every grant (folders, toolchains, pushes, pull request comments, tools, apps and
   sites it may drive), Full access (every arriving bot is set to the auto-review explicitly,
   unconfirmed, never left to follow the target's default, which may be Full access), the apps
   and plugins it may use (they arrive at none), every Always allow and every kept answer for a
   tool that declares nothing. History still moves, but the target closes each moved conversation
   with an `arrived` event, and the gate counts only answers given after it. What stayed is
   named for the person to give again.
8. **Copy, check, then commit.** The source reserves the move before anything is awaited: the
   database holds a bot to one open move each way, and the move claims (`move_claims`) every bot,
   worker, conversation and club it carries, in one transaction, so two moves never share any of
   them; an ended move lets go of its claims. It freezes the bot for that move only (messages to
   it are refused with "It is moving to Studio", nothing of it starts; only that move lets it go),
   writes the export as numbered parts with a manifest (format `spade-move`, version 2, Spade's
   schema version, per table a count and a SHA-256, and the hash and count of an inventory naming
   every file and image with its size and SHA-256), then sends it to the target Spade through its
   daemon as inbox requests (`op: "move"`), one part per request, at most 448 KiB each, so a large
   workspace streams in bounded pieces and neither daemon holds more than one part.
9. **The target trusts nothing it is sent, and changes nothing of its own.** A move's id and
   every bot id are plain names (`[a-z0-9][a-z0-9_-]{0,79}`), parsed where they arrive, since they
   name folders; every folder a move writes in or removes is checked to sit where it should, never
   through a link. `begin` is taken only for the manifest the person accepted (by hash), from the
   device they accepted, replacing only what they accepted, within the hour; and only once the
   machine the move names, asked over this machine's own link to it (`vouch`), says it sends that
   move through that device. Without that, the pairing that speaks could claim any machine's
   name; the name shown for it is the one this machine knows that machine by. An arrival is
   **insert-only**: before any row of this machine is touched, every row it brings is looked for
   by its own key (its id, or its conversation and number, …), one index probe each, and any key
   already taken here refuses the move. Each batch that copies rows in records each inserted
   row's key (`move_rows`) in the same transaction, so what a move inserted is known exactly
   through any crash; undoing deletes only those rows. Nothing of this machine is ever deleted by
   an arrival. A staged worker's link must name a maker that came with it (by its id and its
   conversation), the bot itself is no one's worker, and links make one tree, never a circle: a
   link to a bot of this machine would make it the arriving bot's maker and open its knowledge.
   The one replacement is Spade's own: an incoming main retires this machine's quiet main,
   intact, in the cutover transaction, never one in use (checked at the acceptance, at `begin`,
   and again in that transaction).
10. **Bounded on both sides (ADR 0170).** A move carries at most 100,000 parts of 448 KiB, 12 GB
    of parts, 250,000 files and images, 8 GB of them, and rows of 64 MB. The source checks every
    file's size before it copies one, and its parts as it writes them. The target refuses a
    manifest that declares more, or more than its free disk holds, before staging anything, and
    counts every part, inventory entry, row piece and file against what was declared before it
    is written or held; past it the move is given up and its staging removed. At most two moves
    arrive at once, and together they must fit the free disk. Staging nobody sends to for a day,
    and an acceptance nobody began within the hour, are removed by the hourly sweep while Spade
    runs, not only at start. Copies go in batches of 500 rows or 4 MB, whichever comes first.
11. **Checked apart, written in batches, behind one gate.** On `commit` the target joins the
    staged files and checks them against the inventory (none missing, twice or unexpected, none
    larger than its entry, each of its hash, each flushed to disk). It writes the rows into a
    staging database of the move's own, never Spade's connection: each row must have exactly its
    table's columns with their types and be one of the moving bots' own (its id, its agent, its
    club, one of its listed settings, never a setting of the machine or of another bot); then
    every table must hold exactly the bots' rows with the manifest's counts and hashes, and nothing
    may point at a conversation, knowledge entry or routine that didn't come with it. **One
    durable gate**, held inside the store, in SQLite itself for writes: in the same transaction that moves the arrival
    to `activating`, before any row lands, the move claims every bot, conversation and club it
    carries `hidden` (`move_claims`). Every store read and write leaves out what a hidden claim
    names, by each row's owner (its bot, its conversation, its club, or the bot a per-bot
    setting is keyed by): reads in each query, and writes by triggers on every moved table that
    refuse any insert, change or delete of such a row on every connection, whatever store
    operation makes it (so no operation can change a key an undo deletes by), unless the arrival
    itself writes. So no message, routine,
    club, club run, note, knowledge entry, file, conversation list or API request reaches an
    arriving bot or acts as it, and no worker link of it reaches the index; no caller can forget
    the check. The claims are rows, so the gate holds through a restart with nothing to rebuild.
    Then the rows are copied a batch per transaction (500 rows or 4 MB), insert-only, the bots
    stored as `arriving` and their routines paused. Nothing holds Spade's connection for more than
    one batch, so the other bots' requests go on. The source reads its rows a page at a time too,
    and removes them in batches once the move took.
12. **Taken only once it is all there, then in one transaction, nothing acknowledged that a
    power loss can undo.** With the rows still behind the gate (`placing`), the target places the
    workspace folders and images. Files have the same journal as rows: each placement (a bot's
    folder, a folder already there set aside, an image this machine didn't have) is recorded
    durably (`move_files`) before it is done, and undoing puts back exactly what was recorded,
    each record going only once that is on disk; the gate and the claims stay until every file
    is back. Every folder made for the files, nested ones included, and every folder a rename
    touched, is flushed to disk before anything acts on it. An image a move brings reads as none
    until the move is this machine's; one the machine already had stays its own and is never
    touched. Then the moved bots' app access is set to none in the person's apps (the hub's own
    record) and, again, in one transaction that makes the move this machine's: the bots get
    their kinds, the gate opens, routines and webhooks, clubs, consent and `arrived` markers
    change, app access is none, Spade's host choice is written and this machine's quiet main
    retired, the person's result line is kept and the move reads `committed`, all together; it
    runs only from `placing`, so a cutover run twice does nothing. Every write a move answers on
    (its state, its claims, the file journal, the cutover) is committed with SQLite's full sync,
    so an answered commit or abort survives a power loss; the source archives its copy only
    after that answer. If placing fails it answers `503` and stays `placing`; the source asks
    again, and the bot stays frozen on the source until the target confirms. A retried commit,
    or a restart, finishes placing. A cutover refused (Spade in use here, a stale host choice)
    takes out exactly what the move inserted and placed. **One lock per move**: every step of a
    move to here (`begin`, `part`, `commit`, `status`, `abort`), its recovery and the sweep take
    it, and every change of its state is made only from the state it expects, in the same
    transaction, so an abort or an expiry never removes staging or lets claims go while a commit
    uses them. An abort before the cutover takes out what was inserted and placed; after it, it
    is refused. A copy cut off (an error, a crash) is undone as soon as the next step, the sweep
    or a restart finds it, and the source's next commit writes it afresh.
13. **A failure leaves the bot where it was, and a move never holds a bot forever.** Any refusal
    or check that fails before the commit undoes the move on both sides: the target drops its
    staging, the source unfreezes the bot, untouched. Before its commit a move has a stored
    deadline (two hours, retries and disconnects included): past it the move gives up and the bot
    carries on where it is. An unreachable target is retried with backoff while the person
    watches; they can cancel up to the commit. Once the commit is sent only the target knows
    whether it took, so the source keeps the bot, frozen, and its profile says "Waiting for Studio
    to finish the move. Research stays here until Studio answers." with **Check again**, which asks
    at once. The way out if that machine is gone for good: remove it from your machines (ace's
    Machines); the move then gives up and the bot carries on here. If that machine had taken it,
    it shows there too when it comes back, and the person deletes the copy they don't want.
14. **Idempotent and self-healing.** Every step is keyed by the move's id: a part sent twice is
    stored once, a second `begin` (with the same manifest) answers which parts are already there,
    a second `commit` answers the first commit's result. Both sides store the move's state, so a
    restart resumes it; a move cut off while it was being reserved never began. Staging the source
    abandoned, and an acceptance nobody used, is dropped after a day.
15. **One move at a time, and only when the bot is still.** A bot (or one of its workers) that is
    working, waiting on the person, sleeping or running a service can't start moving; the person
    stops it or waits.
16. **Its id stays.** The bot keeps its id, and its conversation's, on every machine, so links,
    other bots' references and club membership still resolve. A club on the source that lists it
    now lists it on the target; a club it leads moves with it; the target lists it as its own. An
    ask from another machine that reaches the old machine is answered with where the bot went, and
    the asking Spade sends it there.
17. **On arrival.** Routines arrive paused until the person resumes them, and every webhook
    routine gets a new secret. Its security settings keep what only narrows it (its network,
    where its commands run), lose the person's consent and read the auto-review (decision 7),
    including a bot that brought no security settings at all. The bot's profile shows
    one result line naming what needs the person: routines to resume, webhooks with new addresses,
    what to allow again, endpoints to add (the bot keeps its model, which runs once the endpoint
    is there), apps and plugins to allow again. It goes when the person dismisses it.
18. **The archive.** The source keeps its copy in `<data>/moved/<move>/` (the parts it sent, which
    hold no secret, and the workspace folders) for 30 days after the move ended. A sweep running
    every hour while Spade runs, never at start, removes at most five expired archives each time.
    The source's cleanup after the move took replays exactly the selection it froze at the start
    (its bots, conversations, helpers' and clubs' included), kept with the move, never one rebuilt
    from rows already half removed; any step of it that fails keeps the move `finishing` and the
    bot frozen, and it runs again, until all of it is done: only then is the move done.
19. **Moving the main Spade moves the choice with it, fenced by where it began.** The manifest
    carries the host record the source held as it packed, which must name the source; the target
    refuses the move at `begin`, and again at its cutover, if it holds a newer record (chosen
    since: stale). The target makes the new record itself, in the cutover transaction, never from
    what the commit carries: it names the accepted destination (this machine), exactly one
    version above the record the move began with. Until the cutover this machine's quiet main
    and its host record stay as they are. The source refuses to commit a stale move before it
    first sends the commit, and takes the record from the commit's answer only if it is exactly
    that one (`by: "move"`, naming the target, one version on); any other answer it asks again,
    and it never makes one up. Once the commit is sent a main move never gives up for a machine
    it can't reach or that left the fleet: giving up then could leave two Spades in use, so it
    waits. The source stores the record as it finishes, so the old machine's main goes quiet;
    its copy there is archived like any moved bot's and its rows removed, and a new, quiet main
    takes its place.

### What the person sees

20. **Profile.** Details' Machine row carries Move to…, a menu of the fleet's other machines that
    run Spade (offline ones named and not choosable). The main Spade's profile, read through a
    machine that isn't its host, offers Move Spade to this machine. Progress is one sentence in the
    profile and as the bot's line in the list ("Moving to Studio", "Copying files, 12 of 40",
    "Waiting for Studio to come online"), with Cancel as a text button until the commit; a failure
    is one sentence saying the bot is still here, with Try again and Dismiss. No icons, tints or
    progress bars.
21. **iPhone.** Its Spade tab lists bots with their state line, so a moving bot reads as moving
    there; the move action lives in the profile, which the iPhone does not have yet.

## Consequences

- Spade no longer flips between machines; an offline host shows Spade as away instead.
- A bot's whole memory moves with it; the person re-adds keys and sign-ins on the new machine,
  as the result line lists.
- The source keeps an archive of each bot it moved away for 30 days; it is never read again.
- The person gives a moved bot its grants, Full access, apps and plugins again on the new
  machine: consent is given per machine.
- A move whose rows would collide with this machine's own is refused, never merged.
- Moving needs the person stamp of ADR 0163 amendment 2 (PR #2300), which this builds on.
- The app waits for the source to pack before it can ask the target for the person's say, so a
  very large bot takes a moment to reach "Waiting for your say".
- Both machines must run the same Spade schema; a move between different versions is refused
  with "Update Spade on Studio first".
- ace learns nothing new: the move travels as Spade inbox requests in the existing `spade`
  machine call (ADR 0132), whose bodies the daemons pass through unread.

## Tests

- A bot moved to another machine keeps its history, notes, knowledge, routines, files and id, and
  is gone from the old machine's roster (two Spades and a fake daemon between them).
- A move that fails halfway (the target refuses, or goes away and the person cancels) leaves the
  bot where it was, unfrozen and complete, and the target holds nothing.
- A commit whose answer was lost is not sent twice in effect; a source restart mid-move finishes
  the move.
- Routines arrive paused; webhook secrets never travel or stay in the archive; grants, Full
  access, apps and earlier answers stay behind and are named.
- Adversarial: ids that name paths, a push the person never accepted, steps from another
  machine, a swapped manifest, a planted file, rows for another bot or the machine's settings,
  two starts at once, files that can't be placed yet, a first `begin` from another machine,
  replacing a Spade in use, a Full access target, a move past its limits or past what it
  declared: each is refused or waits, and nothing of it is kept.
- A large bot arriving never holds up the target's other bots' requests; an expired archive goes
  without a restart.
- A machine stopped just before or just after the cutover (its answer lost) ends with the bot on
  one machine, its nested folders in place; Spade arriving across a stop before its cutover
  starts with no apps; a move given up after its files were placed puts back exactly those (a
  folder set aside returns, an image the target had stays) and none of its images is read
  meanwhile; mid-copy, no store operation writes an arriving club's rows and an abort takes all
  it brought; an undo keeps the gate until the files it placed are back; only a stamped record
  the named host holds, or the first seed, is kept, and nothing but a handoff makes a host.
- A crash before the collision check, or between batches, takes out nothing the target had;
  rows copied in are found by no store read or write until the cutover; a worker linked to a bot
  outside the move is refused; a move the named machine never sent is refused, and its sender is
  named as the target knows it; an abort or the sweep waits for a commit in hand.
- Insert-only and the gate: a colliding conversation or club id refuses the move and leaves the
  target's rows untouched; an arriving bot held mid-copy, and again after a restart mid-copy, is
  reached by nothing; every step from another device is refused, byte-identical manifest
  included; a worker never moves apart from its maker; a move past its deadline gives up; Check
  again asks at once; at most two moves arrive at once; stale staging goes while Spade runs.
- API keys never leave the machine: no part of a move carries a stored key.
- The main Spade moved to another machine shows there and goes quiet on the old one; the host
  record is the same on both.
- Web: the main Spade stays on the chosen machine when that machine goes offline and comes back;
  a window copies the newest record to stale machines; no window switches a main off.
