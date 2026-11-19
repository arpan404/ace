# 0193: Work carries on when the laptop leaves

Date: 2026-11-19. Status: proposed (design, version one, revised after two reviews; before the
build). Decided by: the owner (the outline, 2026-11-18; no automatic takeover after silence and no
automatic hand-over in version one, 2026-11-19), this ADR (how). Builds on
[ADR 0191](0191-continue-a-working-thread-on-another-machine.md) (live continue) and
[ADR 0192](0192-transfers-over-every-machine-route.md) (transfers over every route). Amends ADR
0191's ownership record.

## Context

A person works on a laptop, closes the lid or the battery dies, and the agent stops with it. ADR
0191 moves a working thread, but only while both machines can talk. The owner wants the work to
be able to carry on on another of the person's machines, usually a server, after the laptop has
gone.

Two drafts of this ADR let ace move the thread by itself. The first used a lease: the server took
over after silence. The second used proof that the laptop's tree had stopped. Both failed review
for the same reason: ace can't know that an agent's work has stopped. On macOS nothing contains an
agent's processes. `env -i nohup … &`, or a tmux server the agent asks to launch work, leaves no
trace ace can follow. A stalled daemon, a VM migration, a runtime clock that pauses in sleep, and
children that thaw before any timer runs each break a timing argument. Priority 1 in AGENTS.md
(never two owners) leaves one sound design for now: **only the person moves a thread.** ace
prepares the copy so that moving is one press, says plainly what pressing risks, and makes the
laptop stop the moment it learns it was taken over.

## Decision

### 1. Opt in, per thread, with a project default

A thread runs on one machine (the **runner**) and names one other of the person's machines (the
**standby**). The person turns it on from the thread's menu: "Keep a copy on omarchy". A project
can make it the default for its new threads (Settings › the project: "Keep a copy of new threads
on omarchy"). It is a person's command (`thread.keepGoing`, the person's standing per ADR 0190),
never an agent's.

It is offered only when:

- the standby is linked with `operate` and `projects` allowed (ADR 0101), and answers
  `keepGoing: true` in `begin` (an older ace answers `target_too_old`);
- the standby has a signed-in account for the thread's provider ("omarchy has no Claude sign-in");
- the thread is a root thread (ADR 0191, `thread_is_child`);
- both machines have a host incarnation (section 7).

Turning it off goes through the same fence as a takeover (section 3), so it ends only once the
standby answers: "Stops keeping a copy once omarchy answers."

### 2. Warm copies: checkpoints at turn ends

The standby holds a recent copy of the thread to start from. Each copy is a **generation** of the
thread's keep-going **stream**, which is one stream per thread and standby, with its own id.

- **Generation 1** is ADR 0191's bulk (code, branch, ignored files). It goes only over a direct
  route or the person's own relay, never over ace's hosted relay. Until it lands, the line says
  "Getting omarchy ready · 312 MB of 1.2 GB" and Take over isn't offered.
- **Later generations** each hold a capture commit of the checkout (`captureChanges`, in ADR
  0191's temporary index, so the checkout and its index are untouched), an incremental bundle
  that excludes the last pinned generation, and a fresh `@ace/handoff` summary with the thread's
  title, mode, provider, model and queue count. Native session files aren't copied in version one.
  A takeover starts from the summary.

**When.** Only at the end of the root's turn, and at the sleep notice (section 4). Captures don't
run during a turn in version one.

- **Coalesced.** Each thread has at most one generation waiting. A newer turn end replaces the
  waiting one before its capture starts.
- **A minimum interval.** A thread makes at most one generation every 2 minutes. A turn end inside
  that window makes its generation when the window ends, so ten short turns make one copy.
- **A cancellable capture budget.** A capture runs as Git child processes under an abort signal,
  with a 10-second budget. Past the budget it is killed and its temporary index and objects are
  removed. The thread's next try waits twice as long (up to an hour), and the line says how old
  the standby's copy is. A checkout over 100,000 files doesn't capture at all: "This project is too
  large to keep a copy of."
- **Fair.** Each standby takes one generation at a time, oldest copy first across its threads, so a
  busy thread never starves a quiet one.
- **Routes.** A generation is `part=warm` under ADR 0192's hosted-relay policy, the same as
  `final`: up to `HOSTED_RELAY_TRANSFER_BYTES` (8 MiB) on ace's relay. A larger one waits for a
  route that can take it.

**On the standby:**

- **Pinned whole.** A generation's bundle is fetched into the project's landing repository under
  `refs/ace/keep/<stream>/g<N>`, and its summary is written and synced to disk. Then one
  transaction records `pinned = N`. A partial generation is never pinned.
- **Byte quotas.** Each stream may use 2 GiB of the standby's disk beyond its generation 1, and all
  streams together 20 GiB (both changeable in Settings on the standby). Over quota, new
  generations are refused and the runner says "omarchy is out of room for copies".
- **Pruning and Git GC.** Once a newer generation is pinned, refs older than the last two pinned
  generations are dropped. A generation held by a takeover is never dropped (section 5).
  `git maintenance run --task=gc` runs on a landing repository when the daemon is idle, at most
  once a day per repository and after at least 20 dropped generations, as idle, bounded work (ADR
  0170).
- **Nothing runs.** No thread row exists for a stream on the standby, and nothing goes into a
  provider's home, so nothing there can dispatch, recover or resume it.

### 3. Who owns the thread: one fence on the standby

ADR 0191's `thread_ownership` gains two states:

| state     | on      | meaning                                                          |
| --------- | ------- | ---------------------------------------------------------------- |
| `kept`    | runner  | owns the thread; a standby holds generations                     |
| `standby` | standby | owns nothing; holds generations; may be taken over by the person |

Both rows carry `stream`, `epoch` (one more with every change of owner), the runner's registered
`holder` (section 7) and the standby's `pinned`.

**Ownership of a kept thread changes in only three ways**, all started by the person:

1. **Take over** on the standby (section 5).
2. **ADR 0191's live move**, which the person starts, to the standby or to any other machine.
   Bringing a thread back is one of these.
3. **Turning keep-going off**, which retires the stream.

Each one is a compare-and-set on the standby row's epoch, one at a time per stream, in one
transaction. A live move of a kept thread first claims the stream (`keep.claim`, epoch E to E+1,
recorded as "moving with transfer T"). Only after that does it write `handing` and send its commit.
A takeover pressed meanwhile meets epoch E+1 and is answered "MacBook is moving this to Studio".
A live move whose claim can't be made, because the standby can't be reached, is refused with "Can't
reach omarchy, which keeps a copy of this thread". When the person needs to move without it, they
turn keep-going off, which waits for omarchy too. A claim whose live move fails before `handing`
is released in a second compare-and-set (E+1 to E+2, back to `standby`). The laptop learns the new
epoch from the answer.

**Answers are never assumed.** Every message of a stream carries `stream`, `epoch`, `holder` and,
where it applies, `generation`, and every obligation is written down before its message goes. A
missing, late or ambiguous answer never lets the laptop take back or keep a thread whose ownership
it can't confirm: it asks again (section 6).

### 4. The sleep notice: stop and checkpoint

When the system says it is about to sleep, the runner, for each kept thread that is working:

1. **Stops the tree** with ace's ordinary Stop (`thread.interrupt` with `cascade`, and the tree's
   terminals, ADR 0191 section 2). The interrupted turn is owed ADR 0191's carry-on message, held
   behind the barrier (section 6).
2. **Sends one last generation, if there's time.** The capture's budget is whatever remains of the
   notice's time, less one second. If the capture or the send doesn't finish in time, it is
   cancelled, and the last pinned generation stands.
3. **Sends `keep.sleeping`** (a few bytes), so other clients can say "asleep" instead of "went
   quiet".
4. **Lets the system sleep.**

Nothing is handed over and nothing is frozen. The Stop is ordinary, so a process that escaped it
keeps running exactly as after the person's own Stop (ADR 0191's known gap). Ownership doesn't
depend on it, because ownership never changes without the person. A missed notice (no helper, or a
helper that died) changes nothing except that the tree wasn't stopped and the last generation is
older.

**The power helper** only tells the daemon about sleep, so the laptop can stop and checkpoint.
`ace-power-helper` is a small native program separate from the screen helper. It ships beside the
daemon's entry bundle in every daemon release, in both the CLI's archive and the app's bundled
daemon, and is versioned with the daemon.

- **Versioning.** At start, the daemon refuses a helper whose version differs from its own. A daemon
  update replaces the helper with it, and a helper still running from the old version is ended
  first.
- **macOS:** `IORegisterForSystemPower` on a run loop. **Linux** (Ubuntu, Fedora, Debian, Omarchy):
  `zbus` to logind, with a delay inhibitor for `sleep`, held only while a kept thread works, and
  `PrepareForSleep`. **Windows:** none in version one.
- **Protocol.** JSON lines on stdin and stdout: `will-sleep {id, deadlineMs}`, which the daemon
  answers with `allow {id}`; `did-wake`; `can-sleep {id}` (idle sleep), allowed at once and never
  cancelled.
- **A deadline of its own.** The helper allows sleep at its deadline whether or not the daemon
  answered. On macOS that is 20 seconds, inside the system's 30. On Linux it is logind's
  `InhibitDelayMaxUSec` less one second; logind's default 5 seconds leaves about 4. The helper never
  holds sleep for a daemon that has stalled.
- **When the daemon goes.** The helper exits when its stdin closes or its parent process changes
  (checked every 2 seconds), releasing the inhibitor. It never outlives the daemon.
- **Reported on its own.** Sleep support is a separate fact: Settings › Fleet and `ace doctor` say
  "Sleep notice: working", or why not ("helper missing", "no login session", "logind refused the
  inhibitor"). Keep-going works without it, and the thread's line says "omarchy's copy is from the
  last turn end" either way.

### 5. Take over

**What other clients show.** The standby lists each kept thread to every client of the person's
that reaches it: the phone, the standby's own window, another machine. When the runner isn't
answering, the list reads:

- "MacBook is asleep · omarchy's copy is from 13:58" after a `keep.sleeping`;
- "MacBook went quiet at 14:02 · omarchy's copy is from 13:58" otherwise. "Went quiet" counts from
  the last message of any kind once the standby's `keep.status` probe goes unanswered for 2 minutes.

Both lines come with **Take over on omarchy**. These words are the only thing silence drives.

**The confirmation**, which must be pressed: "Take over on omarchy? If MacBook is still running
this, both will run it until MacBook reconnects; then MacBook stops at once and keeps its changes
on a branch. omarchy starts from the copy of 13:58, with a summary instead of the agent's full
history." **Take over** · **Cancel**.

`keep.takeOver` is a person's command with the person's standing (ADR 0190), sent to the standby,
never offered to agents. It carries the epoch the client saw and a command id.

**The fence and the setup record.** One transaction on the standby:

- **The fence:** a compare-and-set of the epoch, E to E+1, which fails if the stream moved
  meanwhile.
- **The setup row**, `keep_takeover`: the stream, the new epoch, the command id, and the
  generation started from (the pinned one at that moment). It also holds identities derived from
  the stream and the new epoch: the thread id, the landing worktree path and the continue
  message's command id. Its stage is `landing`.
- **The listing:** the row goes into its side table `keep_takeover_open` (ADR 0170).
- **Ownership:** the standby row becomes `owned`.
- **The receipt**, keyed by the command id.

The setup row pins the generation's ref, its summary and generation 1's ignored files. Pruning and
GC skip anything a setup row holds until it reaches `started` or `failed`.

**Setup has its own replayable path.** It is not ADR 0191's incoming recovery: that path expects a
transfer that imported or landed, and a takeover has neither. Each stage is idempotent and advances
the row in the same transaction as its own durable effect:

| stage                | does                                                                                                                | done when (checked on replay)                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `landing`            | `git worktree add` at the derived path, checked out at the generation's capture; ignored files copied in            | the worktree exists at that commit              |
| `thread`             | inserts the thread with the derived id (title, mode, provider, model, the summary as its handoff, the link back)    | a row with that id exists                       |
| `enqueue`            | admits the continue message under its derived command id                                                            | the engine's receipt for that command id exists |
| `starting`           | watches the message to its first turn with ADR 0191's pure rule (`live/turn-start.ts`) and its backoff, on this row | the rule says running or held unsent            |
| `started` / `failed` | final; the pins are released                                                                                        |                                                 |

A restart drains `keep_takeover_open` in batches of 64, a turn of the event loop between them, and
carries each row on from its stage. A landing left half made is removed and made again. A stage
that keeps failing is tried 8 times with backoff, then ends `failed` with the reason on the thread
("omarchy took this over but couldn't start it: <reason> · Try again"), and Try again starts the
stage again. A resent command with the same id gets its receipt. A new command under the old epoch
is answered "already taken over" with the same thread.

The continue message: "This thread moved here from MacBook, which went quiet at 14:02. The project
is as of 13:58, and files Git ignores are as of when the copy began. Anything MacBook did after
13:58 is still there and may still be running. Check what already happened before you repeat it:
fetch before pushing, never force-push, and check a deploy's state before deploying again."

Ownership, setup and running are three facts, shown apart:

| fact      | read from                     | words                             |
| --------- | ----------------------------- | --------------------------------- |
| ownership | the `owned` row and its epoch | "omarchy took this over at 14:10" |
| setup     | the `keep_takeover` stage     | "Getting the project ready"       |
| running   | the `starting` rule           | "Running on omarchy since 14:11"  |

### 6. The laptop's resume barrier

**When it closes.** At every daemon start, and at every wake. Wakes are learned from the helper's
`did-wake`. Without a helper, a wake is detected by the wall clock moving more than 30 seconds
ahead of the monotonic clock between two 5-second checks; a wall clock set forward only closes
the barrier needlessly, never wrongly opens it. Each closing draws a new **barrier id**.

**While closed**, nothing automatic runs for a kept thread: no queued message, owed carry-on,
recovery, automation, delegation result or provider session. A tree still running at the barrier
(the notice was missed) is stopped with ordinary Stop, and its turn is owed the carry-on message.

**Asking.** The laptop sends `keep.status` (stream, its highest seen epoch, the barrier id) to the
standby. It is retried automatically, 1 second doubling to 1 minute, forever, and again at once
whenever a route changes or the network comes back. The barrier never opens because time passed.

**Only a fresh, unambiguous answer counts.** The answer must carry the request's barrier id (one
from an earlier wake is dropped), an epoch no lower than the highest the laptop has seen, and a
pinned generation no lower than the last one the laptop had acknowledged. It must also come from
the standby's registered incarnation (section 7). Anything else, including "no such stream", is
treated as no answer, and the line says why ("omarchy answered from an older copy of itself").

| answer                          | the laptop                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------- |
| still `standby` at this epoch   | opens the barrier: held work runs, an interrupted turn gets the carry-on message |
| taken over, or moved by a claim | goes `moved` and runs the cleanup journal below                                  |
| none, stale or ambiguous        | stays closed and keeps asking                                                    |

**Run here anyway.** While the barrier is closed the line reads "Checking with omarchy before
carrying on." with **Run here anyway**. That is a person's command, with its own confirmation: "Run
here without checking? If omarchy took this over, both will run it until they reconnect; then this
Mac stops and keeps its changes on a branch." It opens the barrier for this barrier id only. A
message the person types doesn't open it: it waits in the queue like any other.

**The cleanup journal.** `moved`, with `continuedOn`, and a `keep_cleanup` row are written in one
transaction, and the row is listed in `keep_cleanup_open`. Its stages run in order, and each is
replayed at start until done:

1. **stop**: ordinary Stop with its close fallback forced at once, and the tree's terminals;
2. **cancel**: the cascade to children on other machines, with ADR 0052's bounded resends;
3. **rescue**: the checkout as it is now, captured onto `ace/kept/<thread>-<yyyymmdd-hhmm>`, a
   local branch that is never pushed (the branch name is derived from the row, so a replay finds
   it);
4. **done**: the thread reads "Moved to omarchy at 14:10. MacBook's work after 13:58 is on branch
   ace/kept/… here." with **Open** · **Send to omarchy**. Send to omarchy sends the branch as a
   parcel (ADR 0182) and tells the agent there; it never merges.

The checkout itself is left as it is, and so are the laptop's native session files and transcript.

**Residual risk, plainly.** A tree that thawed after a missed notice, or a laptop that was awake
but cut off when the person pressed Take over, runs until the daemon looks. A process that escaped
Stop runs on regardless. ace's own records end with one owner. But a push, a deploy or a message can
escape from the laptop, and the standby, starting from an older copy, may repeat one the laptop
already made. ace can't fence systems it doesn't own. The confirmation says so, and so does the
continue message. Work kept this way should use downstream effects that refuse duplicates: a push
without force, a deploy with an expected version or idempotency key, records keyed by id.

### 7. Clones, restores and restarts

**A host incarnation** is a key pair made at opt-in on each machine. Its private key lives outside
the ace home, in a store that a copy of the home doesn't carry:

- macOS: the login keychain, accessible `AfterFirstUnlockThisDeviceOnly`, not synchronizable, so it
  restores to no other Mac;
- Linux: the Secret Service when there is one, else `$XDG_STATE_HOME/ace/incarnation`, with mode
  0600 and the machine's `/etc/machine-id`;
- Windows: DPAPI with the machine's `MachineGuid` (Windows doesn't keep copies in version one, but
  the key is ready).

Each key is bound to the hardware id (`IOPlatformUUID`, `/etc/machine-id` or `MachineGuid`) and the
home's path. The public key is registered with the other side when the stream is made.

**Execution and status are gated on it.**

- The runner dispatches a kept thread only when its own incarnation opens the key and matches the
  row. Otherwise the barrier never opens on its own, and the thread reads "Kept by another copy of
  ace. Re-pair to keep a copy here."
- The standby answers status and takes over only under its own matching incarnation, and its
  answers are signed. A restored or copied standby on another machine can't sign, and the laptop
  rejects it.

**A normal restart replaces the holder.** Each daemon start draws a run nonce and registers
`(incarnation, nonce, counter)`, signed, with the standby. The daemon-lock already allows one live
daemon per home, so a new run under the same incarnation and path means the old run is gone. The
standby retires the old nonce. A message under a retired nonce afterwards means two live copies
(for example a VM clone that kept its disk, keychain and machine id). The standby then refuses both
and freezes the stream ("Two copies of MacBook are running this. Re-pair to keep a copy."), and
nothing automatic runs on either.

**A standby restored from a backup** answers from an old epoch or generation. The laptop compares
with the highest it has seen and refuses it (section 6). A restored standby's own rows fail the
incarnation check when restored onto other hardware. `ACE_MAINTENANCE=1` daemons take no part.

**Re-pairing retires the old authority.** Re-pairing makes a new stream with new keys on both
sides. The old stream's id and keys are tombstoned on each side and refused forever.

### 8. Words

One sentence, text buttons, no icons on buttons (design-language.md, DESIGN.md). The words live in
`@ace/ui-core`.

| when                    | the line                                                                            | buttons                |
| ----------------------- | ----------------------------------------------------------------------------------- | ---------------------- |
| opted in                | Keeps a copy on omarchy · from 13:58                                                |                        |
| first copy going        | Getting omarchy ready · 312 MB of 1.2 GB                                            |                        |
| copy failing            | omarchy's copy is from 13:58: <reason>                                              |                        |
| standby out of room     | omarchy is out of room for copies.                                                  |                        |
| asleep (seen elsewhere) | MacBook is asleep · omarchy's copy is from 13:58                                    | Take over on omarchy   |
| quiet (seen elsewhere)  | MacBook went quiet at 14:02 · omarchy's copy is from 13:58                          | Take over on omarchy   |
| taking over             | omarchy took this over at 14:10 · Getting the project ready                         |                        |
| couldn't start          | omarchy took this over but couldn't start it: <reason>                              | Try again              |
| running there           | Running on omarchy since 14:11.                                                     | Open · Bring it back   |
| laptop barrier          | Checking with omarchy before carrying on.                                           | Run here anyway        |
| stale standby           | omarchy answered from an older copy of itself. Still checking.                      | Run here anyway        |
| moved on reconnect      | Moved to omarchy at 14:10. MacBook's work after 13:58 is on branch ace/kept/… here. | Open · Send to omarchy |
| live move refused       | Can't reach omarchy, which keeps a copy of this thread.                             |                        |
| clone                   | Kept by another copy of ace. Re-pair to keep a copy here.                           |                        |

**Bring it back** is ADR 0191's live move from the standby to the laptop, landing through ADR
0101's landing reuse. Uncommitted work in the laptop's checkout goes onto an `ace/kept/` branch
first. It is never automatic.

### 9. Wire

These are calls on the transfer protocol (ADR 0192: every route, idempotent by id, never parcels):

- `keep.register`: holder, signed;
- `keep.status`: the barrier's question, and the standby's probe;
- `keep.sleeping`;
- `part=warm`: a generation;
- `keep.claim` and `keep.release`: a live move's fence;
- `keep.takeOver`: the person's command;
- `keep.retire`: off.

All of them except generation 1 fit ace's relay. `TransferBegin.keepGoing` asks for a stream
instead of a thread.

### 10. Convergence

| case                                     | runner                                                                               | standby                     | ends with                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------- | --------------------------------------- |
| lid closes, notice heard                 | stops, sends a last generation if time, sleeps                                       | shows asleep                | the laptop's, until the person acts     |
| notice missed                            | tree keeps going until sleep; on wake, barrier stops it                              | shows quiet                 | the laptop's, until the person acts     |
| laptop silent for hours, nobody presses  | —                                                                                    | idle, shows quiet           | the laptop's                            |
| Take over, laptop asleep                 | on wake, barrier; the answer says taken over; cleanup                                | setup to started            | standby; laptop moved, work on a branch |
| Take over, laptop awake but cut off      | runs (the accepted risk) until an answer reaches it; cleanup                         | setup to started            | standby; laptop moved, work on a branch |
| Take over's answer lost                  | —                                                                                    | receipt on resend           | one takeover                            |
| two clients press Take over              | —                                                                                    | first wins; second answered | one takeover                            |
| Take over races the person's live move   | claim first: the move goes on / takeover first: the claim fails, the move is refused | epoch fence                 | one owner                               |
| standby restarts during setup            | —                                                                                    | replays from the stage      | started or failed, once                 |
| laptop crashes right after `moved`       | cleanup journal replays stop, cancel, rescue                                         | —                           | moved, branch written                   |
| laptop wakes, standby unreachable        | barrier closed, retrying forever                                                     | —                           | waits, or the person runs here anyway   |
| answer from an earlier wake arrives late | dropped (old barrier id)                                                             | —                           | barrier holds                           |
| standby restored from a backup           | old epoch or generation refused                                                      | —                           | barrier holds; re-pair                  |
| cloned laptop home                       | can't open the key, or two holders freeze the stream                                 | refuses both                | nothing automatic; re-pair              |

### 11. Costs and bounds

- **Idle threads cost nothing.** Generations happen only at turn ends, and the standby's status
  probe happens only while the runner is unreachable and a client is looking.
- **Captures** happen at most once every 2 minutes per thread, cut off after 10 seconds, never on
  checkouts over 100,000 files, and always cancellable.
- **Bytes.** A generation's bundle is usually kilobytes and its summary a few kilobytes. On 3G (400
  kbit/s) that is well under a second. Generation 1 never crosses ace's relay.
- **The standby's disk** is held to its quotas (2 GiB per stream, 20 GiB in all), with refs pruned
  to two generations and Git GC run in idle time, once a day at most per repository.
- **The helper** runs only while a thread is kept, and holds the logind inhibitor only while a kept
  thread works.
- **Startup** (ADR 0170): rows are found through the ownership table and the two `_open` side
  tables. The barrier sends one `keep.status` per standby, batched across its threads.

## Rejected

- **Automatic hand-over when the laptop leaves, on proof its tree stopped** (the second draft). On
  macOS nothing contains an agent's processes (`env -i nohup … &`, or work a tmux server
  launches), so no proof is reliable there. A hand-over that might leave a process running is a
  takeover nobody chose. With it go the `ACE_TREE` marker scan, cgroup containment, the freeze
  before an unproven sleep, and the hand-overs on low battery and on quit or shutdown.
- **Automatic takeover after silence, under a lease** (the first draft). Its safety needed a daemon
  that never stalls, a Stop that always ends every process, clock rates that hold through VM
  migration, a sleep-counting clock in the shipped runtime (Bun 1.4.4's `performance.now()` pauses
  in macOS sleep), and a daemon that acts before thawed children run. Each can fail.
- **Any heartbeat-driven automatic path.** Silence only changes words.
- **Periodic captures during a turn**, for now. They cost a scan of the checkout each time, and that
  cost hasn't been measured.
- **Native session copies**, for now: the files can be rewritten in place, so a cheap tail misses
  changes, and whole copies haven't been measured.
- **Just start the work on the server.** It already works, but the choice has to be made before the
  work starts. Most work starts on the laptop, and the need to leave comes later, often unplanned.
- **Clearing the barrier after a while.** Elapsed time says nothing about whether the person took
  over.
- **An arbiter in ace's cloud** (ADR 0002), **wall clocks compared across machines**, **keeping the
  Mac awake**, **bringing it back automatically on wake**, and **Electron's `powerMonitor`** (the
  daemon runs with no app, ADR 0186).

## Follow-ups

- **Automatic hand-over on Linux with cgroup containment.** A tree in its own cgroup can be proven
  empty, so a Linux laptop could hand over at the sleep notice. It would need the hand-over to go
  through this ADR's fence, and its own review.
- Native session copies and in-turn captures, once measured.
- Windows sleep notices.
- Moving children with their parent.

## Review findings (second review, at e9253358cd) and how version one answers them

1. **Stop proof is unreliable on macOS: nothing contains an agent's processes.** Moot. Version one
   has no automatic hand-over, so nothing depends on proof. Linux with cgroups is a follow-up.
2. **Lost replies and races.** Resolved. The laptop never takes a missing or ambiguous answer as
   permission (section 6). A takeover and the person's live move meet at one epoch fence, through
   `keep.claim` (section 3). Takeover receipts are keyed by command id (section 5).
3. **Clones and restores.** Resolved. Execution and status are bound to a host incarnation whose
   key isn't copied with the home. A normal restart replaces the holder by a signed registration
   under the daemon-lock, and a second live copy freezes the stream. Re-pairing tombstones the old
   authority, and a restored standby's old epoch or generation is refused (section 7).
4. **The barrier's bypass for ordinary messages.** Resolved. It is replaced by the explicit, warned
   **Run here anyway** for one barrier id. The barrier fails closed, drops answers from earlier
   wakes, retries forever and never clears on time (section 6).
5. **Takeover setup assumed ADR 0191's incoming recovery, which expects an import or a landed
   result.** Resolved. Setup has its own persisted, staged, replayable record with its artifacts
   pinned until it ends (section 5). The laptop's cleanup is journalled too (section 6).
6. **The power helper.** Resolved. It only learns of sleep. It ships and is versioned with the
   daemon in CLI and app installs, is replaced on upgrade, has its own deadline, exits with its
   parent, and its support is reported separately (section 4).
7. **Warm-copy cost.** Resolved. Version one makes coalesced turn-end checkpoints only, with a
   minimum interval, cancellable capture budgets, byte quotas and Git GC on the standby (section 2).

## Verification

**Pure** (`transfers/keep/*-rules.ts` and their tests):

- the epoch fence: takeover against claim, two takeovers, claim and release, retire, a stale epoch;
- the identities derived from the stream and epoch;
- each setup stage's done-when check and its replay;
- the cleanup journal's order and replay;
- the barrier's answer rules: an old barrier id, a lower epoch or generation, an unsigned or
  unknown incarnation, "no such stream";
- holder replacement and the two-holder freeze;
- the scheduler: coalescing, the 2-minute interval, oldest first, backoff after a cancelled
  capture;
- quota and prune decisions, with a takeover's pins kept;
- the wake detector from wall and monotonic clocks.

**Two real daemons** over their pinned link, with real Git, scripted providers (including one that
starts `env -i nohup` work), a fake power helper, and a proxy on every route that can drop, hold or
replay traffic. A partition and a SIGKILL of either daemon are injected at each step:

- a generation half-written;
- the claim, before and after;
- the takeover transaction, before and after;
- each setup stage;
- `moved` and each cleanup stage.

Cases:

- a sleep notice with a last generation, and one where the capture is cancelled;
- a missed notice, with the barrier stopping the thawed tree;
- silence for hours with nobody pressing (the standby stays idle);
- a takeover with its answer lost and resent;
- two takeovers at once;
- a takeover racing a live move both ways;
- the standby restarting three times during setup;
- the laptop crashing right after `moved`;
- a wake with the standby unreachable, then **Run here anyway**;
- a late answer from an earlier wake;
- a standby restored from an older copy of its home;
- a cloned laptop home on the same machine id;
- over-quota refusals, and GC keeping pinned refs;
- twenty kept threads, with one busy.

**The split-brain test:** the laptop awake and cut off with its tree running, the person pressing
Take over on the standby. The test asserts that the laptop runs only until an answer reaches it,
then stops, writes its branch and reads moved, and that the standby started exactly once.

**On the shipped binaries:**

- the helper installed and upgraded from the CLI archive and from the app, on macOS and Linux;
- the helper exiting when the daemon is killed;
- macOS lid close and `pmset sleepnow`, and Ubuntu, Fedora and Omarchy `systemctl suspend`;
- the barrier closing on each wake, with and without the helper;
- the keychain item not restoring to another Mac.

**Measured before in-turn captures or native session copies come back**, with the slow-link
harness (#2038), on ace's repository and a 200,000-file one: the CPU and time per capture, bytes per
generation, standby disk and GC time per stream, and the time from Take over to the continue
message running, on 3G and on a LAN.
