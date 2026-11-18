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
2. **Only the person and a move change it.** Nothing elects a host any more: the app's election
   and its automatic switch-offs are removed. While the chosen machine is offline, Spade shows as
   away, as any bot on an offline machine does (ADR 0127 decision 2), and comes back with it.
3. **The first record is today's Spade.** A window that reads every machine and finds no record
   on any writes one, once, naming the machine that shows Spade now (the oldest main if several
   do, else the window's own machine). It then copies the newest record to every machine it
   reaches that holds an older one, so the fleet agrees without a coordinator.
4. **Old switch-offs heal once.** `PUT /v1/main {"enabled": false}` was only ever sent by the
   election, so a stored switch-off is dropped the first time the machine learns a record, and the
   record alone decides from then on. A deliberate switch-off is a new, separate field
   (`{"enabled": false, "by": "person"}`), kept until the person turns Spade back on there; an
   old app that still sends the plain form changes nothing once a record exists.

### Moving a bot

5. **Any bot can move, Spade too, to an online machine of the fleet that runs Spade.** The
   person starts it from the bot's profile (Move to…, or Move Spade to this machine); the CLI has
   `ace spade move <bot> --to <machine>`. The machine the bot is on does the work.
6. **What moves.** The bot and the worker bots it made (ADR 0161), each with its conversation and
   its helpers' hidden conversations (ADR 0152): every event, so its history, goals, plans, wakes
   and decision log come along; its notes, knowledge base and links, episodes and digests;
   routines and their past runs; the skills it used and how; its read marks, pins, face (a picture
   face's image, and every image its conversation shows), spending ledger, model choices per role,
   oversight, security and digest settings, plugin choices; the clubs (groups, ADR 0132) it leads,
   with their transcripts; and its workspace folder, file by file.
7. **What stays.** Endpoint API keys (they live in each machine's keychain, ADR 0119; the bot keeps
   its model choice and the result names each endpoint to add there), connected apps' sign-ins,
   the computer's browser profile and sign-ins, plugin approvals to run outside the sandbox, and
   workspace checkpoints (snapshots of this machine's files). Links in the workspace are not
   followed and stay behind, named in the result.
8. **Copy, check, then commit.** The source freezes the bot (messages to it are refused with "It is
   moving to Studio", nothing of it starts), writes the export as numbered parts with a manifest
   (format `spade-move`, version 1, Spade's schema version, and per table and per file a count and
   a SHA-256), then sends it to the target Spade through its daemon as inbox requests (`op:
   "move"`, steps `begin`, `part`, `commit`, `status`, `abort`), one part per request, at most 384
   KiB each, so a large workspace streams in bounded pieces and neither daemon holds more than one
   part. The target keeps the parts in a staging folder, checks each against the manifest, and on
   `commit` writes every row in one database transaction and verifies the counts and hashes
   against what it stored before it answers. Only then does the source finish: it archives its
   copy to `<data>/moved/<move>/` (the parts it sent, which hold everything, and the workspace
   folders) and removes the bot from its roster. For the main Spade the source keeps its main bot,
   quiet; the target's own quiet main is archived the same way, since the incoming one replaces it.
9. **A failure leaves the bot where it was.** Any refusal or check that fails before the commit
   undoes the move on both sides: the target drops its staging, the source unfreezes the bot,
   untouched. An unreachable target is retried with backoff while the person watches; they can
   cancel up to the commit. Once the commit is sent the source waits for the target's answer (or
   asks for the move's state), because only the target knows whether it committed; the bot stays
   frozen meanwhile and the app says so.
10. **Idempotent and self-healing.** Every step is keyed by the move's id: a part sent twice is
    stored once, a second `begin` answers which parts are already there, a second `commit` answers
    the first commit's result. Both sides store the move's state, so a restart resumes it: the
    source sends what is missing or asks for the commit's outcome, the target finishes placing
    the workspace it had staged. A staging folder whose move the source abandoned is removed.
11. **One move at a time, and only when the bot is still.** A bot (or one of its workers) that is
    working, waiting on the person, sleeping or running a service can't start moving; the person
    stops it or waits. A second move of the same bot is refused while one is open.
12. **Its id stays.** The bot keeps its id, and its conversation's, on every machine, so links,
    other bots' references and club membership still resolve. A club on the source that lists it
    now lists it on the target; a club it leads moves with it; the target lists it as its own. An
    ask from another machine that reaches the old machine is answered with where the bot went, and
    the asking Spade sends it there.
13. **On arrival.** Routines arrive paused until the person resumes them, and a webhook routine
    gets a new secret (its address is the new machine's). Folder grants are checked again on the
    target: one whose folder exists there, as a folder, is kept; any other is dropped and named so
    the person can grant it again. Sandbox and security settings take what the target can do
    (ADR 0167). The bot's profile shows one result line naming what needs the person: routines to
    resume, folders to grant again, endpoints to add (the bot keeps its model, which runs once the
    endpoint is there), apps to connect, plugins to install. It goes when the person dismisses it.
14. **Moving the main Spade moves the choice with it.** The commit on the target stores a new host
    record naming the target (one version above the newest either side holds), and the source
    stores the same record as it finishes, so the old machine's main goes quiet, kept, in the
    same step. Windows copy the newer record to the rest of the fleet.

### What the person sees

15. **Profile.** Details' Machine row carries Move to…, a menu of the fleet's other machines that
    run Spade (offline ones named and not choosable). The main Spade's profile, read through a
    machine that isn't its host, offers Move Spade to this machine. Progress is one sentence in the
    profile and as the bot's line in the list ("Moving to Studio", "Copying files, 12 of 40",
    "Waiting for Studio to come online"), with Cancel as a text button until the commit; a failure
    is one sentence saying the bot is still here, with Try again and Dismiss. No icons, tints or
    progress bars.
16. **iPhone.** Its Spade tab lists bots with their state line, so a moving bot reads as moving
    there; the move action lives in the profile, which the iPhone does not have yet.

## Consequences

- Spade no longer flips between machines; an offline host shows Spade as away instead.
- A bot's whole memory moves with it; the person re-adds keys and sign-ins on the new machine,
  as the result line lists.
- The source keeps an archive of each bot it moved away until the person removes it; it is
  never read again.
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
- Routines arrive paused; a folder grant whose folder is missing on the target is named.
- API keys never leave the machine: no part of a move carries a stored key.
- The main Spade moved to another machine shows there and goes quiet on the old one; the host
  record is the same on both.
- Web: the main Spade stays on the chosen machine when that machine goes offline and comes back;
  a window copies the newest record to stale machines; no window switches a main off.
