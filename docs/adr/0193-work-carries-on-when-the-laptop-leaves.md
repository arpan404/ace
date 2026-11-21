# 0193: Work carries on when the laptop leaves

Date: 2026-11-19. Status: proposed (design, version one, revised after four reviews; before the
build). Decided by: the owner (the outline, 2026-11-18; no automatic takeover after silence and no
automatic hand-over in version one, 2026-11-19), this ADR (how). Builds on
[ADR 0191](0191-continue-a-working-thread-on-another-machine.md) (live continue) and
[ADR 0192](0192-transfers-over-every-machine-route.md) (transfers over every route). Amends ADR
0191's ownership record.

## Context

A person works on a laptop, closes the lid or the battery dies, and the agent stops with it. ADR
0191 moves a working thread, but only while both machines can talk. The owner wants the work to be
able to carry on on another of the person's machines, usually a server, after the laptop has gone.

Two earlier drafts let ace move the thread by itself, first on a lease, then on proof that the
tree had stopped. Both failed review for one reason: ace can't know that an agent's work has
stopped. On macOS nothing contains an agent's processes: `env -i nohup … &`, or a tmux server
launching work, leaves no trace ace can follow. Priority 1 in AGENTS.md (never two owners) leaves
one sound design: **only the person moves a thread.** ace keeps a copy ready so that moving is one
press, says plainly what pressing risks, and makes the laptop stop the moment it learns it was
taken over.

A third review showed that this is only as strong as ace's idea of _which_ laptop and _which_
standby it is talking to. A VM clone, a restored backup, a migrated Mac or a delayed answer can each
pose as the real machine, and none of them involves the person pressing anything. This version
makes every such case either provably impossible on the host, or a decision the person makes
knowingly.

## Decision

### 1. Opt in, per thread, with a project default

A thread runs on one machine (the **runner**) and names one other of the person's machines (the
**standby**). The person turns it on from the thread's menu with "Keep a copy on omarchy". A
project can make it the default for its new threads (Settings › the project: "Keep a copy of new
threads on omarchy"). It is a person's command (`thread.keepGoing`, the person's standing per ADR
0190), never an agent's.

It is offered only when:

- the standby is linked with `operate` and `projects` allowed (ADR 0101), and answers
  `keepGoing: true` in `begin`. An older ace answers `target_too_old`;
- the standby has a signed-in account for the thread's provider ("omarchy has no Claude sign-in");
- the thread is a root thread (ADR 0191, `thread_is_child`);
- both machines run macOS or Linux (Windows is a follow-up) and have an identity (section 7);
- the project's first copy fits the standby's room (section 2).

Opting in records, on both machines, each one's identity and its **tier** (section 7). The words
say what the tier means: "omarchy can prove it isn't a copy of itself", or "omarchy can't prove it
isn't a copy of itself, so ace asks you before trusting a restart" (section 7).

Turning it off goes through the same fence as a takeover (section 3), so it ends only once the
standby answers: "Stops keeping a copy once omarchy answers."

### 2. Warm copies: checkpoints at turn ends, inside a hard cap

The standby holds a recent copy of the thread to start from. Each copy is a **generation** of the
thread's keep-going **stream** (one stream per thread and standby, with its own id).

**Generation 1** is ADR 0191's bulk: the code, the branch and the files Git ignores. It goes only
over a direct route or the person's own relay, never over ace's hosted relay. Until it lands, the
line reads "Getting omarchy ready · 312 MB of 1.2 GB" and Take over isn't offered.

**A later generation** holds:

- a capture commit of the checkout (`captureChanges`, in ADR 0191's temporary index, so the
  checkout and its index are untouched);
- an incremental bundle that leaves out the last pinned generation;
- a fresh `@ace/handoff` summary, with the thread's title, mode, provider, model and queue count.

Native session files aren't copied in version one. A takeover starts from the summary.

#### When the runner captures

Only at the end of the root's turn, and at the sleep notice (section 4):

- **Coalesced.** Each thread has at most one generation waiting. A newer turn end replaces the
  waiting one before its capture starts.
- **A minimum interval.** A thread gets at most one generation every 2 minutes. A turn end inside
  that window makes its generation when the window ends.
- **One capture at a time** across all of the runner's threads. Captures queue oldest-copy first,
  so a busy thread never starves a quiet one.
- **A cancellable budget.** A capture runs as Git child processes under an abort signal, with a
  10-second budget. Past it, the capture is killed, and its temporary index and loose objects are
  removed. The thread's next attempt waits twice as long, up to an hour. A checkout over 100,000
  files never captures ("This project is too large to keep a copy of").
- **One send at a time** per standby. A generation is `part=warm` under ADR 0192's hosted-relay
  policy, the same as `final`: up to 8 MiB on ace's relay. A larger one waits for a route that can
  take it.
- **On the runner,** capture refs (`refs/ace/keep/<stream>/…`) are kept only for the last two
  generations the standby acknowledged. The repository's own Git maintenance reclaims their
  objects.

#### Room on the standby

The standby keeps one hard cap for everything keep-going puts on its disk: 20 GiB by default,
changeable in Settings on the standby. The cap covers:

- generation 1 baselines, ignored files included;
- every later generation's objects, packed and loose;
- **unreclaimed objects** of pruned generations;
- the staging folders of uploads in flight;
- the worktrees and pinned inputs of takeovers in setup.

Usage is the bytes actually on disk. It is measured per landing repository when intake starts and
after each reclamation, and kept current between measurements by adding every byte written.

**Space is reserved at its peak, before intake.** Wire bytes understate what intake writes. A
generation's `begin` carries the sender's figures: its pack bytes, and the tree and ignored-file
bytes of the checkout it captures (from `git ls-tree -l` and the ignored files' sizes). The standby
reserves the **peak** that intake can reach:

- **generation 1:** staging (pack bytes), plus `index-pack`'s working copy (pack bytes), plus the
  ignored files;
- **a later generation:** twice its pack bytes.

Each figure is multiplied by this standby's **measured factor**: the ratio of bytes actually
written to bytes estimated, over its last 20 intakes. The factor starts at 1.25 and is never below
1.1.

One **landing headroom** is reserved for the whole standby: the largest stream's tree plus ignored
bytes, times the factor. It means a takeover never fails for room while the other streams' copies
fit. Takeovers land one at a time, so one headroom is enough.

Reservations are taken in one transaction, against the cap and against the stream's own limit (4
GiB, including its baseline). They are also checked against the filesystem's real free space
(`statvfs`), keeping 5% of the disk spare. A reservation that doesn't fit is refused before a byte
is sent.

On completion, the reservation is replaced by the measured usage, and the factor is updated. An
intake that writes more than it reserved is stopped at the reservation and refused, and its staging
is removed. A reservation whose upload goes silent for an hour is abandoned the same way.

Where the person has set up a filesystem quota for the landing folder (an XFS or ext4 project quota,
or a btrfs qgroup; setting one up needs root), ace treats the quota as the hard limit, reads usage
from it, and keeps its own cap as well.

**Reclamation under pressure.** When usage plus reservations passes 80% of the cap, or a
reservation is refused, the standby reclaims space:

1. It drops refs older than each stream's last two pinned generations. A ref held by a takeover's
   setup is never dropped (section 5).
2. It picks the landing repository with the most unreclaimed bytes. A repack writes the new pack
   before it deletes the old ones, so the standby first reserves that repository's pack bytes times
   1.1. If that reservation doesn't fit, it uses the smaller step instead: it runs
   `git prune --expire=now`, which deletes loose objects and needs no extra room, and puts off the
   repack.
3. The repack, `git gc --prune=now`, runs one repository at a time, at idle CPU and I/O priority,
   with a 5-minute budget, and its reservation is released when it ends.
4. It measures again, then retries the refused reservation once.

The same reclamation also runs once a day when the standby is idle (ADR 0170: bounded, never at
open). If reclamation can't free enough, the refusal stands: the runner says "omarchy is out of
room for copies", and the standby's Settings lists each stream's share.

#### When the thread is settled, the other copy goes

A kept thread lives on one machine; the other holds only a warm copy, or, after a takeover or a
move, the old thread. Once the thread is **settled** where it now lives (the person settles it,
or it is archived or deleted there), nothing should be left behind on the other machine:

- **Warm copies are deleted.** Settling the thread retires its stream, exactly as turning
  keep-going off does: the standby removes every generation's ref, its landing worktree and its
  pinned inputs, and gives the space back under the cap. The runner drops its capture refs. A
  standby that is offline at the time is told when it is next reached; until then its stream is
  marked retired and never offered for Take over.
- **A takeover's leftovers are deleted the same way.** If the thread was taken over and then
  settled on the standby, the laptop's moved thread and its `ace/kept/` cleanup state are removed
  once the laptop next answers, after the rescue branch is written, so no work is lost: the
  branch stays in the repository, and only the thread record and keep-going state go.
- **Nothing is deleted while the thread is still live anywhere.** A retirement is a fenced change
  like the others (section 3): it needs the current epoch, and a thread that is working,
  waiting on the person, or still moving is never settled by this.

### 3. Who owns the thread: one fence on the standby

ADR 0191's `thread_ownership` gains two states:

| state     | on      | meaning                                                      |
| --------- | ------- | ------------------------------------------------------------ |
| `kept`    | runner  | owns the thread; a standby holds generations                 |
| `standby` | standby | owns nothing; holds generations; the person may take it over |

The standby's row is the stream's **authority**. It carries:

- `epoch`: one more with every change of owner;
- the admitted `holder` (section 7);
- `pinned`, the generation the standby last pinned;
- `counter`: one more with every change to the stream, including each pinned generation;
- `chain`: a hash chain over every change (the previous head and the change itself).

Every answer the standby gives carries `epoch`, `counter`, `chain`, `pinned` and an **outcome**
(below).

#### Signed outcomes

The laptop never infers what happened from an epoch alone. Every answer names one outcome, signed,
and each outcome has exactly one durable transition on the laptop. That transition is written in
the same transaction that advances the laptop's authority record (section 6).

| outcome       | means                                                                                                    | the laptop's durable transition                                                                                                                                                                   |
| ------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `standby`     | the laptop owns the thread at epoch E, and this run is the admitted holder                               | none for ownership; the barrier may open                                                                                                                                                          |
| `released`    | ownership came back to the laptop at epoch E′: a claim was released, or a takeover was given up          | the claim row goes `released`, or `moved` goes back to `kept` (only from the takeover or claim the answer names); the barrier stays closed until the person presses **Carry on here** (section 5) |
| `moved`       | another machine owns it (a takeover, or a committed claim), named in the answer                          | `moved` and the cleanup journal (section 6)                                                                                                                                                       |
| `quarantined` | the stream is frozen: two copies, a rollback, or a clone signal (section 7)                              | dispatch closes at once: the tree is stopped and a `quarantined` row is written; nothing reopens it except the person's confirmation on the standby, or re-pairing                                |
| `revoked`     | this run's holder or key was retired (Carry on here or Rebind on another copy, a burned run, re-pairing) | the tree is stopped; the cleanup journal writes the rescue branch; the thread reads "This copy of ace was replaced"                                                                               |

Whatever the epoch says, an outcome the laptop's state doesn't allow (a `released` naming a claim
it never made, say) is no answer: it is logged, and the barrier stays closed.

**Ownership of a kept thread changes in only these ways**, each started by the person:

1. **Take over** on the standby (section 5).
2. **ADR 0191's live move**, which the person starts, to the standby or to any other machine.
   Bringing a thread back is one of these.
3. **Turning keep-going off**, which retires the stream.
4. **Recovery after an unclean restart or a lost key**, on the runner (section 7).

Each is a compare-and-set on the authority's epoch, run one at a time per stream, in one
transaction.

#### A live move claims the stream first

A live move of a kept thread is fenced through the standby. Each step is written down before its
message is sent, and is keyed by the move's transfer id, so a lost answer is settled by asking
again under the same id.

1. **The laptop records its intent.** A `keep_claims` row (transfer id, stream, from-epoch,
   destination, state `intent`) is written in the same transaction as ADR 0191's `stopping`.
2. **It sends `keep.claim`.** The standby compares-and-sets epoch E to E+1 and records the claim by
   transfer id, state `pending`. A repeated claim with the same transfer id gets the same answer.
3. **While a claim is pending**, the stream is fenced:
   - Take over is refused, with "MacBook is moving this to Studio";
   - a status answer says "claimed by your transfer T". It never says moved.
4. **The laptop never reads a pending claim as a move.** It records `claimed`, then drives ADR
   0191 as usual: `handing`, commit, and the destination's answer.
5. **Commit.** When ADR 0191 settles that the destination owns the thread, the laptop sends
   `keep.claim.commit T`. The standby marks the claim `committed`. The stream is then retired if
   the destination is another machine, or `owned` if it is the standby itself. In that case the
   commit and the landing are one transaction on the standby. Only after the standby's answer does
   the laptop record `moved`.
6. **Release.** A confirmed failure of either kind, under ADR 0191's rules, sends
   `keep.claim.release T`:
   - before `handing`, any failure or cancel;
   - after `handing`, the destination's own answer of `failed`, `cancelled` or "no such transfer".

   The standby compares-and-sets E+1 to E+2 back to `standby`, answers the signed outcome
   `released` naming T, and offers Take over again. The laptop reads `released`, never the higher
   epoch, as its cue. It returns to `kept` at E+2, with ADR 0191's owed resume. A lost link after
   `handing` is never a failure: the laptop keeps asking the destination, as ADR 0191 does.

7. **A restart** on either side reconciles from its own rows. The laptop re-sends the claim, the
   commit or the release that its `keep_claims` row says is owed, under the same transfer id. The
   standby answers each from the claim's recorded outcome.

If the laptop goes quiet with a claim still pending, the standby lists the thread as "MacBook was
moving this to Studio when it went quiet". The destination is the one that may own it, so Take
over isn't offered. The only choice is **Take over anyway**, with its own warning: "If Studio
already has this thread, both will run it."

**How Take over anyway settles the claim.** It is a person's command. In one transaction, it moves
the pending claim T to `overridden` and compares-and-sets E+1 to E+2, owned by the standby, with
the same setup record as any takeover. The claim never goes back to pending. When the laptop later
reports T's outcome:

- **A late release** (the move failed): the standby answers `moved`, naming itself. The laptop goes
  `moved` and runs its cleanup. One owner, the standby.
- **A late commit** (Studio did take the thread): two machines own it, which the person was warned
  of. The standby answers `moved`, naming Studio, because the laptop's own ADR 0191 record already
  says moved, so there is nothing to clean up. The standby then marks its own taken-over thread
  with "Studio also has this thread: MacBook's move there finished before it went quiet." and
  **Stop it here**, and holds its dispatch until the person chooses. Its stopped turn and its
  checkout are kept.

A live move whose claim can't be sent because the standby can't be reached is refused: "Can't reach
omarchy, which keeps a copy of this thread." Turning keep-going off waits for omarchy the same way.

**No answer is assumed.** Every message carries `stream`, `epoch`, `holder`, a challenge (section 6)
and, where it applies, `generation`. A missing, late or ambiguous answer never lets the laptop
resume, keep running a thread the standby says it doesn't hold, or record `moved`.

### 4. The sleep notice: stop and checkpoint

When the system says it is about to sleep, the runner does this for each kept thread that is
working:

1. It stops the tree with ace's ordinary Stop (`thread.interrupt` with `cascade`, and the tree's
   terminals; ADR 0191 section 2). The interrupted turn is owed ADR 0191's carry-on message, held
   behind the barrier (section 6).
2. It sends one last generation, if there's time. The capture's budget is what remains of the
   notice's time, less one second; whatever hasn't finished by then is cancelled.
3. It sends `keep.sleeping`, so that other clients say "asleep" rather than "went quiet".
4. It lets the system sleep.

Nothing is handed over and nothing is frozen. A missed notice changes nothing except that the
tree wasn't stopped and the last generation is older; the barrier deals with the rest (section 6).

**The host helper.** `ace-host-helper` is a small native program, separate from the screen helper.
It has two jobs: to learn of sleep and wake, and to hold the machine's hardware-bound key (section
7). It ships beside the daemon's entry bundle in every daemon release and is versioned with the
daemon: the daemon refuses a helper whose version differs from its own, and an update replaces it
after ending the old helper.

**macOS packaging.** A Secure Enclave key, and any key that uses the data-protection keychain, needs
a process whose code signature carries a keychain access group from a provisioning profile. So
the helper ships as an app bundle, `ace Host Helper.app`: Developer ID–signed, notarized, with its
embedded provisioning profile and the `keychain-access-groups` entitlement.

- The desktop app carries it inside its own bundle.
- The CLI's macOS archive carries the same bundle, installed under the daemon's folder. That is the
  supported packaging path for a CLI-only install.
- The daemon starts it in the person's login session: as its own child when the daemon runs as the
  app's child or as a user LaunchAgent, and through a user LaunchAgent (`gui/<uid>`) when the
  daemon was started from SSH.
- A system LaunchDaemon can't use the data-protection keychain, and ace never installs one.

When the bundle is missing, its signature or profile doesn't check, or there is no login session,
the helper runs without a keychain group. The identity then falls to the software tier, and the
reason is reported.

- **macOS:** `IORegisterForSystemPower` on a run loop, and the Secure Enclave.
- **Linux** (Ubuntu, Fedora, Debian, Omarchy):
  - `zbus` to logind: a delay inhibitor for `sleep`, held only while a kept thread works, plus the
    `PrepareForSleep` signal;
  - the TPM, through `/dev/tpmrm0`;
  - the kernel's uevent socket, for `vmgenid` changes (section 7).

**Linux probes**, run by the helper from inside the daemon's real context (the systemd user service,
with and without linger, or the terminal it was started from), at opt-in and at every start. Being
in the `tss` group and having a TPM present doesn't count; each step has to work:

1. open `/dev/tpmrm0`;
2. create or load the identity key under the storage hierarchy;
3. sign a challenge and verify the signature;
4. on a standby, define (once), read and increment the NV counter (section 7). This needs the
   owner hierarchy's authorization, which is often empty and sometimes not.

The tier, and whether the counter is there, come from the probe's results alone. A probe that fails
is reported with its step ("TPM present, but this service can't open /dev/tpmrm0").

- **Protocol:** JSON lines on stdin and stdout.
  - `will-sleep {id, deadlineMs}`, which the daemon answers with `allow {id}`;
  - `did-wake {wakeId}`;
  - `vm-generation {changed}`, from the clone signals of section 7;
  - `can-sleep {id}` for idle sleep, allowed at once and never cancelled;
  - `sign {challenge}`, which returns a signature from the hardware key.
- **Its own deadline.** The helper allows sleep at its deadline whether or not the daemon has
  answered. That is 20 seconds on macOS, inside the system's 30, and logind's `InhibitDelayMaxUSec`
  less one second on Linux (about 4 seconds by default).
- **It never outlives the daemon.** It exits when stdin closes or when its parent process changes
  (checked every 2 seconds), and releases the inhibitor as it goes.
- **Its own status line.** Settings › Fleet and `ace doctor` report "Sleep notice: working" or
  why not ("helper missing", "no login session", "logind refused the inhibitor"), and the
  identity's tier, separately.

### 5. Take over

#### What other clients show

The standby lists each kept thread to every client of the person's that reaches it: the phone, the
standby's own window, another machine. When the runner isn't answering, the thread reads one of:

- "MacBook is asleep · omarchy's copy is from 13:58", after `keep.sleeping`;
- "MacBook went quiet at 14:02 · omarchy's copy is from 13:58", counted from the last message of
  any kind, once the standby's own probe (`keep.status`, sent to the runner) has gone unanswered
  for 2 minutes.

Each comes with **Take over on omarchy**. These words are all that silence changes.

#### The confirmation

The person must press **Take over** to go ahead (the other button is **Cancel**). The text says
what pressing risks: "Take over on omarchy? If MacBook is still running this, both will run it
until MacBook reconnects; then MacBook stops at once and keeps its changes on a branch. omarchy
starts from the copy of 13:58, with a summary instead of the agent's full history."

When the runner checked in lately, the confirmation adds: "MacBook checked in 40 seconds ago and
may still be running this." That comes from the time of the standby's last answer to the runner.

`keep.takeOver` is a person's command with the person's standing (ADR 0190), sent to the standby,
never offered to agents. It carries the epoch the client saw and a command id.

#### The fence and the setup record

One transaction on the standby:

- **The fence:** compare-and-set E to E+1. It fails if the stream moved, is claimed or is
  quarantined.
- **The setup row** (`keep_takeover`), holding:
  - the stream, the new epoch and the command id;
  - the generation it starts from (the pinned one at that moment);
  - the identities derived from the stream and the new epoch: the thread id, the landing path, and
    the base of the continue message's attempt ids;
  - its stage, `landing`.
- **The listing** of the setup row in its side table `keep_takeover_open` (ADR 0170).
- **The authority** set to `owned`, with `counter` and `chain` advanced.
- **The receipt**, keyed by the command id.

**Pins.** The setup row pins everything setup reads: the generation's ref, its summary, and
generation 1's ignored files. Pruning and reclamation skip pinned inputs. They stay pinned until
the setup ends `started`, or the person gives up (below). A setup that failed and can be retried
keeps them.

**Telling the runner.** Once the transaction is written, the standby sends `keep.takenOver` (epoch,
counter, chain, the new thread) to the runner on every route. It goes out again at 1 second,
doubling up to a minute, until the runner acknowledges it. So a runner that only reached some
other copy of the standby still learns of the takeover once anything carries the message through.

#### Setup, its own replayable path

Setup isn't ADR 0191's incoming recovery: that recovery expects a transfer that imported or landed,
and a takeover has neither. Each stage is idempotent, and its row moves on in the same transaction
as its own durable effect.

**`landing`**

- **Does**, with Git's own worktree commands throughout, so that Git's registration always matches
  the folder:
  1. reserves the landing headroom (section 2);
  2. `git worktree add --lock <path>.partial <capture>`;
  3. copies in the ignored files and syncs everything to disk;
  4. writes the marker `.ace-landing-complete` (the stream, epoch, commit, and a digest of the
     ignored files' list) and syncs it;
  5. `git worktree move <path>.partial <path>`, which updates the registration with the folder;
  6. `git worktree unlock <path>`.
- **Done when**, read from `git worktree list --porcelain` and the folder together:
  - the worktree registered at `<path>` exists;
  - its marker matches;
  - `HEAD` is at the commit.
- **Replay** goes by what it finds:
  - a registration at `.partial`, or a `.partial` folder without a marker:
    `git worktree remove --force`, then `git worktree prune`, then land again;
  - a folder at `<path>` with a matching marker whose registration is missing or points elsewhere
    (a crash inside `move`): `git worktree repair <path>`, then check again;
  - anything that still doesn't match: removed with `git worktree remove --force` and landed again.

  A plain `rm` or `mv` is never used on a landing.

**`thread`**

- **Does:** inserts the thread under the derived id, with its title, mode, provider and model, the
  summary as its handoff, and the link back.
- **Done when:** a row with that id exists.

**`enqueue`**

- **Does:** asks admission to take the continue message under attempt id `<base>:<n>`. The row
  stores `n` before the request is sent.
- **Done when:** admission _accepted_ the message.
  - An ambiguous reply (a lost answer, a timeout, a restart) is sent again with the **same**
    attempt id; the engine's receipts make that safe.
  - A confirmed refusal that may pass (the engine is full, starting, or shutting down) moves to
    `n+1`, a fresh id, as merged `live/target.ts` does, after ADR 0191's backoff.
  - Any other refusal fails the stage.

**`starting`**

- **Does:** watches the accepted message to its first turn with ADR 0191's pure rule
  (`live/turn-start.ts`).
- **Done when:** the rule says running or held unsent.

**`started`**: final. The pins are released.

**Failure.** A stage that fails is recorded as one of two kinds:

- **Retryable** (a Git error, a disk that filled up, the engine refusing repeatedly, the stage's
  8 attempts used up). Its inputs stay pinned, and the setup stays in `keep_takeover_open`.
- **Final** (the generation turns out damaged; the person deleted the thread).

Both kinds are shown in three places, whether or not a thread exists yet:

- on the standby's list: "omarchy took this over but couldn't start it: <reason>" with **Try
  again** and **Give up**;
- on the thread there, once one exists;
- on the source thread, once the laptop hears `keep.takenOver`: "omarchy took this over but
  couldn't start it."

**Try again** restarts the failed stage.

**Give up** is a person's command, and it runs one at a time with the stream's other changes and
with the engine's admission for the derived thread. The target is fenced before ownership goes back:

1. **Fence.** In one transaction the setup goes `giving_up`. Its worker is cancelled, and any
   thread already made is held by an ownership hold (ADR 0191's `stopping`), so admission refuses
   it from that moment. A continue message the engine already accepted is taken back if it is still
   queued. If its turn has begun, that turn is stopped with ordinary Stop, and the standby waits for
   the tree to read at rest by ADR 0191's rule.
2. **Return.** Only then does a compare-and-set from E+1 to E+2 return the stream to `standby`. In
   the same transaction, the thread (if one was made) is marked given up and kept read-only, never
   deleted, and the pins and the partial landing are released. The laptop is answered with the
   outcome `released`.
3. **The laptop**, which may already have written `moved` and run its cleanup, goes back from
   `moved` to `kept`, but only for this takeover's epoch. Its rescue branch stays. Its checkout is
   untouched, because cleanup never changes it. Nothing restarts by itself: the thread reads
   "omarchy gave this back; it couldn't start it." with **Carry on here**.

Take over is offered again. Give up isn't offered once the setup reached `started`; from then on,
the way back is **Bring it back**.

**Restarts.** A restart drains `keep_takeover_open` in batches of 64, with a turn of the event loop
between them, and carries each row on from its stage. A resent `keep.takeOver` with the same
command id gets its receipt; one with a new id under the old epoch is answered "already taken
over", with the same thread.

#### The continue message

"This thread moved here from MacBook, which went quiet at 14:02. The project is as of 13:58, and
files Git ignores are as of when the copy began. Anything MacBook did after 13:58 is still there and
may still be running. Check what already happened before you repeat it: fetch before pushing, never
force-push, and check a deploy's state before deploying again."

#### Three facts, shown apart

| fact      | read from                       | words                             |
| --------- | ------------------------------- | --------------------------------- |
| ownership | the authority's epoch and state | "omarchy took this over at 14:10" |
| setup     | the `keep_takeover` stage       | "Getting the project ready"       |
| running   | the `starting` rule             | "Running on omarchy since 14:11"  |

### 6. The laptop's resume barrier

#### When it closes

The barrier closes at every daemon start and at every wake. Each closing draws a new **barrier id**.

**The wake signal:**

- **the helper's `did-wake`**, from IOKit on macOS and logind on Linux;
- **without a helper, a kernel record:**
  - macOS: `kern.waketime` (sysctl), read every 5 seconds; any change is a wake;
  - Linux: the boot-time clock (`/proc/uptime`, which counts suspend) minus the monotonic clock
    (which doesn't), read every 5 seconds; growth of more than 1 second is a wake.

  Neither depends on the wall clock. A wake detected this way is seen within 5 seconds; a tree that
  thawed runs that long at most before the barrier stops it. The two fallbacks differ in what they
  can see:
  - **macOS** records every sleep, whatever its length.
  - **Linux** sees only a sleep longer than 1 second. A shorter one is below what the two clocks
    can tell apart through scheduling noise, so it passes unseen without the helper.

- **a VM generation change or a guest agent's revert report**, as a clone signal (section 7). It
  closes the barrier the same way, burns the run, and asks for recovery.

**On a platform with neither**, keep-going isn't offered.

#### While it's closed

Nothing automatic runs for a kept thread: no queued message, no owed carry-on message, no
recovery, no automation, no delegation result, no provider session. A tree that is still running
when the barrier closes (because the notice was missed) is stopped with ordinary Stop. Its turn is
owed the carry-on message.

#### Asking, and what counts as an answer

The laptop sends `keep.status` carrying the stream, its holder, the barrier id, and a **fresh
random challenge**. It also signs the request with its identity (section 7). Each retry carries a
new challenge, and the laptop keeps the challenges outstanding for the current barrier. It retries
on its own: 1 second, doubling up to a minute, forever, and again at once when a route changes or
the network comes back. The barrier never opens because time passed.

An answer counts only if all of these hold:

- it is signed by the standby's recorded identity, over the challenge, the barrier id, and the
  answer's `epoch`, `counter`, `chain` and `pinned`;
- its challenge is one still outstanding in the current barrier. Once any answer is accepted, the
  others are dropped, and answers to earlier barriers are never accepted;
- it is no older than the laptop's **authority record** for the stream. That record holds the
  highest `epoch`, `counter`, `chain` and `pinned` the laptop has ever accepted or sent.
  - A lower counter, epoch or generation is refused.
  - So is an equal counter with a different chain.
  - The record is advanced in the same transaction that acts on the answer.
- it names this run as the admitted holder (section 7).

Anything else is no answer, including "no such stream", a quarantined standby, or a refused holder.
The barrier stays closed, and the line says why: "omarchy answered from an older copy of itself.
Still checking."

**What a challenge proves:** the answer was made after the request, by whoever holds the standby's
key. It's fresh, and it isn't a replay.

**What it doesn't prove:** that the standby's state survived intact. A standby restored from a
backup to the moment of the laptop's last contact answers freshly from old state. The authority
record catches any rollback to a point _before_ the laptop's last contact. Section 7 covers the
rest.

#### What the laptop does with an answer

The laptop acts on the answer's signed outcome (section 3), never on its epoch alone:

- **`standby`:** opens the barrier. Held work runs, and an interrupted turn gets the carry-on
  message.
- **`released`:** back to `kept`; the barrier stays closed until **Carry on here**.
- **`moved`:** runs the cleanup journal below.
- **`quarantined`:** stops and stays closed.
- **`revoked`:** stops and writes the rescue branch.
- **A pending claim of its own:** reconciled (section 3).
- **No answer:** the barrier stays closed and the laptop keeps asking.

Every request also carries the run's **sequence number**, which starts at 1 for each run and goes up
by one with every request. Two live copies of one run, such as a VM resumed twice from one
snapshot, therefore send the same numbers. Section 7 explains how the standby sees that.

#### After it opens: checking again

While the barrier is open and a kept thread has work running or queued, the laptop asks again
with a fresh challenge:

- every 60 seconds;
- at once, on every reconnect and every route change;
- on every `keep.takenOver` it receives.

An accepted `moved`, `quarantined` or `revoked` stops the tree at once and takes the transition for
that outcome. On physical hardware, an unanswered check doesn't close the barrier: a laptop cut off
from its standby keeps working, which is the risk the takeover's confirmation names.

**In a virtual machine** the rule is stricter. A running VM can be cloned live, so a copy can't be
told apart while it is cut off. A runner that detects it is in a VM (`systemd-detect-virt`;
`kern.hv_vmm_present` on macOS) therefore keeps a kept thread dispatching only while a check has
been answered in the last 5 minutes. Past that, the tree is stopped with ordinary Stop and the
barrier closes. That bounds how long an undetected live clone that can't reach the standby runs.

A late answer to an older challenge can never undo a newer one, because the authority record only
moves forward.

#### Run here anyway

While the barrier is closed, the line reads "Checking with omarchy before carrying on." with **Run
here anyway**. That button is a person's command with its own confirmation: "Run here without
checking? If omarchy took this over, both will run it until they reconnect; then this Mac stops
and keeps its changes on a branch." It opens the barrier for this barrier id only. A message the
person types doesn't open it; it waits in the queue.

#### The cleanup journal

`moved` (with `continuedOn`) and a `keep_cleanup` row are written in one transaction, and the row is
listed in `keep_cleanup_open`. Its stages run in order, and each one is replayed at start until it
is done:

1. **stop**: ordinary Stop, with its close fallback forced at once, and the tree's terminals.
2. **cancel**: the cascade to children on other machines, with ADR 0052's bounded resends.
3. **rescue**: the checkout as it is now, captured onto `ace/kept/<thread>-<yyyymmdd-hhmm>`, a local
   branch that is never pushed. Its name is derived from the row, so a replay finds it.
4. **done**: the thread reads "Moved to omarchy at 14:10. MacBook's work after 13:58 is on branch
   ace/kept/… here." with **Open** and **Send to omarchy**. Send to omarchy sends the branch as a
   parcel (ADR 0182) and tells the agent there; it never merges.

The checkout itself is left as it is, and so are the laptop's native session files and its
transcript.

#### Residual risk, plainly

Four cases still let the agent run on the laptop for a while:

- a tree that thawed after a missed notice, for up to 5 seconds;
- a laptop that was awake but cut off when the person pressed Take over, until an answer reaches it;
- a process that escaped Stop, which runs on regardless;
- an action that escapes from the laptop before it stops: a push, a deploy, a message.

In every case ace's own records end with one owner. The standby, starting from an older copy, may
repeat an action the laptop already took. ace can't fence systems it doesn't own. The confirmation
and the continue message say so. Work kept this way should use effects that refuse duplicates: a
push without force, a deploy with an expected version or an idempotency key, records keyed by id.

### 7. Identity: which machine, which run

Every runner and standby has an **identity key**. Its signature is required on registrations,
status requests, answers, takeovers and recoveries. What the key can prove depends on where it
lives. That is its **tier**.

#### The hardware tier: a key a copy can't carry

| platform                               | non-clonable key                                                                                                                                                                                                      | not available on                                                                                                                                                                                                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS, Apple silicon or a T2 Intel Mac | a P-256 key in the Secure Enclave (`kSecAttrTokenIDSecureEnclave`), created and used only by the Developer ID–signed host helper                                                                                      | Intel Macs without T2; any Mac in a VM (Virtualization.framework, Parallels, VMware: no Secure Enclave); an unsigned development build                                                                                                                                           |
| Linux on a physical TPM 2.0            | a signing key created under the TPM's storage hierarchy with `fixedTPM` and `fixedParent`, used through `/dev/tpmrm0`; the person needs to be in the `tss` group (Ubuntu, Fedora, Debian and Arch/Omarchy all use it) | a virtual TPM, whose state travels with a VM clone. ace treats the TPM as virtual when `systemd-detect-virt` names a hypervisor, or the TPM's manufacturer is a known virtual one (swtpm's `IBM`/"SW TPM", Microsoft's Hyper-V, Google, Amazon, VMware); no TPM; no access to it |
| Windows                                | the TPM through the Microsoft Platform Crypto Provider                                                                                                                                                                | not used in version one (keep-going isn't offered on Windows)                                                                                                                                                                                                                    |

A hardware key can't leave its chip. A VM clone, a restored backup, or a home copied to another
machine can hold the key's handle, but can't sign with it. A second daemon on the same OS instance,
at the same home path, is already excluded by the daemon-lock. A different home path is a
different identity, because the key is bound to the path at opt-in. One residual: a container on
the same host, given the host's TPM device and a copy of the home at the same path in its own
filesystem, would hold the key and its own daemon-lock. Granting a container that is an
administrator's act, and ace doesn't defend against it.

On macOS the hardware tier also needs the provisioned helper bundle (section 4). Without it, the
Mac is on the software tier.

#### The TPM counter, through a durable intent

On the Linux hardware tier, where the probe could define one, the standby keeps a **TPM NV monotonic
counter** (`TPM_NT_COUNTER`, not orderly, so it never jumps after an unclean shutdown). The counter
mirrors the standby's **ownership counter**, which goes up by one with every change of who owns or
may own a stream:

- an epoch change;
- a claim and its outcome;
- a Give up;
- a quarantine;
- a retirement.

Generations don't touch it: rolling one back loses a copy, never an owner. That also keeps TPM
writes to a few a day.

Each ownership change goes in four steps:

1. **Write the intent.** One DB transaction writes an intent row: the target value C+1 and the
   change. It is synced to disk.
2. **Increment the TPM counter** to C+1, and only after the intent is on disk.
3. **Apply.** One DB transaction applies the change, sets the stored counter to C+1 and deletes the
   intent.
4. **Answer.** Only now does the standby answer anyone about the change.

At every start, the standby compares the TPM's value `t` with the stored counter `c` and the intent:

| found                       | explained by                                   | the standby                         |
| --------------------------- | ---------------------------------------------- | ----------------------------------- |
| `t = c`, no intent          | nothing in flight                              | carries on                          |
| `t = c`, intent for `c+1`   | a crash between steps 1 and 2                  | does steps 2 and 3, then carries on |
| `t = c+1`, intent for `c+1` | a crash between steps 2 and 3                  | does step 3, then carries on        |
| anything else               | nothing a recorded intent explains: a rollback | quarantines every stream            |

"Anything else" includes `t = c+1` with no intent, which is a restore exactly one change behind,
possibly a takeover the laptop never saw. It also includes `t > c+1` and `t < c`. Nothing about a
change is answered before step 3, so an answer can never describe a state the counter doesn't hold.

#### The software tier: everything else

The key is a P-256 key outside the ace home:

- **macOS, with the provisioned helper:** the data-protection keychain,
  `AfterFirstUnlockThisDeviceOnly` and not synchronizable, so it restores to no other Mac.
- **macOS without it:** the file-based login keychain. Its accessibility attributes mean nothing,
  and it moves with the user's home in a backup or a migration. That is still the software tier,
  and it is reported as "keychain key can move with a backup".
- **Linux:** the Secret Service when there is one, else `$XDG_STATE_HOME/ace/identity` (mode 0600).

It is bound to the hardware id (`IOPlatformUUID`; `/etc/machine-id`). A copy of the whole machine,
such as a VM clone that kept its disk, machine id and keychain, carries this key. **So on this tier
ace never trusts a restart by itself.** Exactly:

- **Holder replacement needs a verified clean end.** A daemon that stops cleanly (Quit ace
  completely, `ace stop`, a system shutdown) publishes a **clean-end record** only after all of
  these, in this order:
  1. **Stop.** Its kept trees are stopped with ordinary Stop.
  2. **Verified quiescence.** No process ace started is still alive. That covers providers, their
     sessions, terminals and their shells, every process ace recorded at spawn (pid and start time,
     never pid alone), and every descendant of those still in their process groups and sessions.
     It is checked against the process table for up to 30 seconds. If anything is still alive at
     the end, no record is written.
  3. **Burn the run.** One transaction, synced to disk, writes `run_burned` for this run's nonce.
     From then on the dispatch gate refuses every kept thread for this run, in memory and on disk.
     A daemon that hangs or crashes after this point can't start anything for a kept thread, and
     neither can anything that copies its home.
  4. **Write the record**, single use: the run nonce, the holder's last sequence number, the
     standby's last answered counter, and a random record id, signed. It is sent to the standby if
     the standby can be reached.

  The next run presents the record when it registers. The standby admits the new run silently only
  if the record names the currently admitted holder and its record id has never been presented
  before. Used ids are kept in the stream's authority; a second presentation means a copy, and
  quarantines the stream. A run that finds no clean-end record for the run before it (a crash, a
  power loss, a failed quiescence check, a snapshot taken mid-run) is never admitted silently.

  What quiescence can't see: a job the agent itself detached with no trace ace can follow (`env -i
nohup`, work handed to a tmux server). That is ADR 0191's known gap for ordinary Stop. Such a job
  doesn't own the thread, but it can still act, and it is listed under what ace can't detect.

- **Explicit recovery.** The new run's barrier stays closed, and the thread reads: "ace on this Mac
  stopped without closing cleanly. If no other copy of this Mac is running ace, carry on here."
  There are two buttons:
  - **Carry on here** is a person's command, with the warning: "If a copy of this Mac (for example
    a cloned virtual machine) is running this thread, both will run it." It sends `keep.recover`,
    signed and with the person's standing. The standby compares-and-sets the epoch, admits the new
    holder, and retires the old one.
  - **Take over on omarchy** stays offered on the standby meanwhile.
- **Two copies are caught when both speak.** A message under a retired holder, or a second
  registration presenting the same predecessor, means two live copies. The standby then
  quarantines the stream: it refuses both, and nothing automatic runs on either.
  - The copy that was running learns at its next check (at most 60 seconds) and stops.
  - The other was never admitted, so it never ran.
  - Both read "Two copies of MacBook are running this. Re-pair to keep a copy."
- **Network hardware is advisory only.** Wi-Fi roaming, VPN changes, new IP addresses and virtual
  interfaces don't count at all. Docks, USB and Thunderbolt adapters are left out of the
  fingerprint. A change to a built-in network address is shown in Settings ("omarchy's network
  hardware changed on 18 Nov"), and never quarantines a stream or blocks a restart on its own. A
  healthy standby on a new dock carries on.
- **What does quarantine** a standby's streams, until the person confirms there ("omarchy looks like
  a copy of itself. Confirm it's the original to keep copies here."):
  - its hardware id or machine id changed;
  - a VM generation change, or a revert report (below);
  - a TPM counter mismatch;
  - a second holder seen.

**A software-tier standby** can't prove it isn't a clone either. Opting in says so: "omarchy can't
prove it isn't a copy of itself. Don't clone it while it keeps copies." If a clone no signal caught
is pressed to take over while the laptop talks to the original:

- the clone sends `keep.takenOver` to the laptop on every route until acknowledged (section 5), and
  the laptop stops the moment one arrives;
- the original, told by the laptop of a higher epoch it never wrote, quarantines itself.

Until then both may run. That is the same risk as Take over on a laptop that is still awake, but
here nobody pressed anything on the original. That is why opting in shows it and why it is listed
as residual.

#### Live clones of a running VM

A running VM cloned with its memory and device state (a live snapshot, a fork, a resume of one
snapshot twice) comes up as two identical copies of the same run: the same nonce, the same keys, the
same sequence position, a virtual TPM if it had one. Neither registers anew. ace detects what can be
detected, and stops both on detection.

**VM generation id.** Hypervisors that support it change the guest's VM generation id on every
clone, snapshot revert and resume from a saved state:

- Hyper-V;
- QEMU/KVM with `-device vmgenid` (libvirt's `<genid/>`; Proxmox sets it by default);
- VMware (`vm.genid`);
- Firecracker-style microVMs via the same ACPI device.

On Linux the kernel's `vmgenid` driver turns a change into a uevent (`NEW_VMGENID=1`, Linux 6.0 and
later), which the helper reports as `vm-generation {changed}`. The daemon also reads the id at start
and compares it with the one it recorded. On a change, the daemon:

1. stops every kept tree with ordinary Stop;
2. burns its run;
3. closes the barrier;
4. tells the standby, which quarantines the stream.

The copy whose id didn't change is stopped by the quarantine at its next check. Each copy then needs
the person's **Carry on here**, and the first of them to be admitted retires the other.

**Guest-agent revert reports.** Where a guest agent reports a resume or revert to the guest (VMware
Tools' resume script, a QEMU guest agent hook that the person configured), the helper treats it the
same as a generation change.

**Sequence collisions.** Every request a runner sends carries its run nonce and its sequence number
(section 6). The standby keeps, per holder, the highest sequence number it has seen and the request
id that carried it. It quarantines the stream when either of these happens:

- a request arrives whose sequence number is at or below that highest number but whose request id
  is different (a genuine resend reuses its id);
- the number goes backwards.

Two live copies of one run collide within their first exchanges after the clone, and a VM reverted
in place goes backwards. Each answer also carries the highest number the standby has seen. A runner
that is shown a number above any it has sent knows another copy is speaking as it, and stops at
once.

**In a VM, silence stops the tree after 5 minutes** (section 6). A live clone that never reaches the
standby therefore runs for 5 minutes at most.

**Unsupported, and said so.** On a hypervisor that exposes no generation id and has no revert
report, a live clone can't be detected by any daemon until both copies reach the standby. That
covers every macOS guest under Virtualization.framework, and any hypervisor with the device turned
off. Until then, each copy can run for up to the 5-minute VM bound, and longer if both are cut off
and the person presses Run here anyway. ace lists this as unsupported. When it runs in a VM without
a generation id, it shows: "This is a virtual machine that can't tell ace when it's cloned. Don't
clone it or restore a snapshot of it while it keeps copies." This appears at opt-in, in Settings
and in `ace doctor`.

#### Rollback of a standby

| case                                                                                                     | caught by                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| restored to a point before the laptop's last contact                                                     | the laptop's authority record (a lower counter, or an equal counter with a different chain)                                                                                                                                                                                                                 |
| restored to another machine                                                                              | the identity: hardware, it can't sign; software, the hardware id or machine id changed and its streams are quarantined                                                                                                                                                                                      |
| restored on the same machine, hardware tier on Linux with the counter                                    | the TPM counter through its intent protocol, including a restore exactly one ownership change behind; streams quarantined                                                                                                                                                                                   |
| restored on the same machine otherwise, to exactly the laptop's last contact, with a takeover afterwards | not caught. The takeover's thread, and the agent that ran it, are gone with the restore, so nothing runs the thread twice. The work done there after the takeover is lost, and outside effects it made may be repeated by the laptop. This is the one residual a challenge can't close, and the ADR says so |

#### When the key is unavailable or gone

- **Not available yet.** For example, a launchd or SSH session before the Mac has been unlocked
  once since it started, or a locked Secret Service. These are retried, 1 second doubling to a
  minute, and again on the helper's unlock and wake events. The thread reads "Waiting for this Mac
  to be unlocked before checking with omarchy." with **Run here anyway**.
- **Gone or invalid.** An OS reinstall, a Mac migrated with Migration Assistant (a Secure Enclave
  key doesn't move), a home moved to another path, a TPM cleared. The thread reads "This Mac's
  keep-going key is gone (it was reinstalled, migrated or moved)." with **Rebind**.
  - **Rebind** is a person's command. It makes a new key and sends `keep.rebind`, signed by the new
    key, with the person's standing, to the standby. The standby compares-and-sets the epoch,
    retires every holder under the old key, and admits the new one. The warning: "If the old Mac
    is still running this, both will run it until it reconnects; then it stops."
  - **While the standby can't be reached,** the line reads "Rebinds once omarchy answers." The
    barrier stays closed.
- **Retirement that waits for an offline peer.** Whoever retires an authority (rebind, re-pairing,
  quarantine) keeps a durable **retirement owed** row naming the old stream and keys. Anything
  under them is refused locally from that moment. The row's notice is delivered whenever the other
  side is next reached, over any route the old pairing had (those routes are kept for this alone).
  On delivery, that side tombstones the old stream, stops anything of it, writes its rescue branch,
  and acknowledges. Until then, the side that hasn't heard keeps its barrier closed, because none
  of its requests will be answered under the old keys. The fence therefore holds before the
  tombstone arrives; the tombstone only lets it show the right words.
- **Re-pairing** makes a new pairing, a new stream and new keys on both sides. The old pairing's
  streams go into retirement owed.

`ACE_MAINTENANCE=1` daemons take no part in any of this.

### 8. Words

One sentence, text buttons, no icons on buttons (design-language.md, DESIGN.md). The words live in
`@ace/ui-core`.

| when                          | the line                                                                                                                          | buttons                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| opted in                      | Keeps a copy on omarchy · from 13:58                                                                                              |                        |
| standby can't prove itself    | omarchy can't prove it isn't a copy of itself. Don't clone it while it keeps copies.                                              |                        |
| first copy going              | Getting omarchy ready · 312 MB of 1.2 GB                                                                                          |                        |
| copy failing                  | omarchy's copy is from 13:58: <reason>                                                                                            |                        |
| out of room                   | omarchy is out of room for copies.                                                                                                |                        |
| asleep (seen elsewhere)       | MacBook is asleep · omarchy's copy is from 13:58                                                                                  | Take over on omarchy   |
| quiet (seen elsewhere)        | MacBook went quiet at 14:02 · omarchy's copy is from 13:58                                                                        | Take over on omarchy   |
| moving when quiet             | MacBook was moving this to Studio when it went quiet.                                                                             | Take over anyway       |
| taking over                   | omarchy took this over at 14:10 · Getting the project ready                                                                       |                        |
| couldn't start                | omarchy took this over but couldn't start it: <reason>                                                                            | Try again · Give up    |
| running there                 | Running on omarchy since 14:11.                                                                                                   | Open · Bring it back   |
| laptop barrier                | Checking with omarchy before carrying on.                                                                                         | Run here anyway        |
| stale standby                 | omarchy answered from an older copy of itself. Still checking.                                                                    | Run here anyway        |
| key not available yet         | Waiting for this Mac to be unlocked before checking with omarchy.                                                                 | Run here anyway        |
| unclean restart (software)    | ace on this Mac stopped without closing cleanly. If no other copy of this Mac is running ace, carry on here.                      | Carry on here          |
| key gone                      | This Mac's keep-going key is gone (it was reinstalled, migrated or moved).                                                        | Rebind                 |
| two copies                    | Two copies of MacBook are running this. Re-pair to keep a copy.                                                                   |                        |
| standby looks copied          | omarchy looks like a copy of itself. Confirm it's the original to keep copies here.                                               | It's the original      |
| moved on reconnect            | Moved to omarchy at 14:10. MacBook's work after 13:58 is on branch ace/kept/… here.                                               | Open · Send to omarchy |
| given back                    | omarchy gave this back; it couldn't start it.                                                                                     | Carry on here          |
| claim released                | The move to Studio didn't happen. This thread is here again.                                                                      | Carry on here          |
| revoked                       | This copy of ace was replaced; its work is on branch ace/kept/… here.                                                             | Open                   |
| quarantined                   | Stopped: omarchy saw a sign that this Mac was copied.                                                                             |                        |
| Take over anyway, late commit | Studio also has this thread: MacBook's move there finished before it went quiet.                                                  | Stop it here           |
| VM without generation id      | This is a virtual machine that can't tell ace when it's cloned. Don't clone it or restore a snapshot of it while it keeps copies. |                        |
| VM, silent 5 minutes          | Stopped: this virtual machine hasn't heard from omarchy for 5 minutes.                                                            | Run here anyway        |
| no hardware key               | This Mac's key can move with a backup, so ace asks you before trusting a restart.                                                 |                        |
| live move refused             | Can't reach omarchy, which keeps a copy of this thread.                                                                           |                        |

**Bring it back** is ADR 0191's live move from the standby to the laptop, claimed through the fence
(section 3), landing through ADR 0101's landing reuse. Uncommitted work in the laptop's checkout
goes onto an `ace/kept/` branch first. It is never automatic.

### 9. Wire

These are calls on the transfer protocol (ADR 0192: every route, idempotent by id, never parcels).
Every request is signed by its sender's identity, and every answer by the answerer's, over the
request's challenge. A runner's requests carry its run nonce and sequence number. Every answer
carries one signed outcome (section 3) and the highest sequence number the standby has seen.

- `keep.register` (holder, clean-end record), `keep.recover`, `keep.rebind`;
- `keep.status`;
- `keep.sleeping`;
- `part=warm`, with its reservation;
- `keep.claim`, `keep.claim.commit`, `keep.claim.release`;
- `keep.takeOver`, `keep.takenOver`, `keep.giveUp`;
- `keep.retire`, and the retirement-owed notice.

All of them except generation 1 fit ace's relay. `TransferBegin.keepGoing` asks for a stream
instead of a thread.

### 10. Convergence

| case                                                             | runner                                                                                                                      | standby                                         | ends with                                                       |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------- |
| lid closes, notice heard                                         | stops, sends a last generation if there's time, sleeps                                                                      | shows asleep                                    | the laptop's, until the person acts                             |
| notice missed, short sleep                                       | kernel wake record seen within 5 s; the barrier stops the thawed tree                                                       | shows quiet                                     | the laptop's, once answered                                     |
| silent for hours, nobody presses                                 | —                                                                                                                           | idle                                            | the laptop's                                                    |
| Take over, laptop asleep                                         | on wake: barrier, answer "taken over", cleanup                                                                              | setup to started; `keep.takenOver` retried      | standby; laptop moved, work on a branch                         |
| Take over, laptop awake and cut off                              | runs (the warned risk) until an answer or `keep.takenOver` reaches it                                                       | setup to started                                | standby; laptop moved                                           |
| an old "standby" answer arrives after a takeover                 | refused if its challenge is no longer outstanding; if accepted first, the next check (≤ 60 s) or `keep.takenOver` stops it  | —                                               | standby; laptop moved                                           |
| Take over's answer lost                                          | —                                                                                                                           | receipt on resend                               | one takeover                                                    |
| two clients press Take over                                      | —                                                                                                                           | the first wins                                  | one takeover                                                    |
| Take over racing a live move                                     | a pending claim fences takeover / a takeover fails the claim                                                                | epoch fence                                     | one owner                                                       |
| laptop crashes after claim, before `handing`                     | restart: release under the same transfer id                                                                                 | claim released, E+2                             | the laptop's, takeover offered again                            |
| laptop crashes after `handing`                                   | restart: asks the destination (ADR 0191), then commit or release                                                            | claim stays pending meanwhile                   | one owner                                                       |
| crash mid-landing                                                | —                                                                                                                           | no marker: partial removed and landed again     | started once                                                    |
| setup fails before the thread exists                             | told on contact                                                                                                             | listed with Try again or Give up; inputs pinned | the person decides                                              |
| laptop crashes right after `moved`                               | the cleanup journal replays stop, cancel, rescue                                                                            | —                                               | moved, branch written                                           |
| laptop wakes, standby unreachable                                | barrier closed, retrying forever                                                                                            | —                                               | waits, or Run here anyway                                       |
| answer from an earlier wake                                      | dropped (old barrier id and challenge)                                                                                      | —                                               | barrier holds                                                   |
| standby restored before the last contact                         | refused by the authority record                                                                                             | —                                               | barrier holds; Run here anyway or re-pair                       |
| standby restored to the last contact, with a takeover after      | opens (the takeover's state is gone with the restore)                                                                       | runs nothing of it                              | one runner; the takeover's work is lost (residual)              |
| VM clone of a hardware-tier laptop mid-turn                      | the clone can't sign: refused                                                                                               | —                                               | the original                                                    |
| VM clone of a software-tier laptop mid-turn                      | the clone has no clean end: explicit recovery; if the person carries on there, the original's next message quarantines both | quarantine                                      | nothing runs; re-pair                                           |
| cloned powered-off software-tier laptop, both started            | first admitted; the second's registration quarantines both                                                                  | quarantine                                      | nothing runs; re-pair                                           |
| cloned software-tier standby, takeover on the clone              | stops on the clone's `keep.takenOver`                                                                                       | the original quarantines on the laptop's report | the clone's thread, after a window (residual, warned at opt-in) |
| migrated Mac, key gone                                           | Rebind (warned), or Take over on the standby                                                                                | old key retired                                 | one owner                                                       |
| key not available in an SSH session                              | retried; barrier closed                                                                                                     | —                                               | opens after unlock                                              |
| live VM snapshot clone, with a generation id                     | both copies see the change: stop, burn the run, close; each needs Carry on here                                             | quarantine                                      | nothing runs; the person admits one                             |
| live VM snapshot clone, no generation id, both reach the standby | the sequence collision quarantines; each copy stops at its next exchange                                                    | quarantine                                      | nothing runs; re-pair or admit one                              |
| live VM snapshot clone, no generation id, one copy cut off       | the cut-off copy stops after 5 minutes (VM rule); the other runs                                                            | —                                               | unsupported; bounded at 5 minutes, warned                       |
| crash after a clean-end record, a job surviving                  | the record exists only if quiescence held; the burned run dispatches nothing; a detached agent job is the known gap         | admits the successor once                       | one runner (the detached job is a residual)                     |
| clean-end record presented twice                                 | —                                                                                                                           | the used record id quarantines                  | nothing runs; re-pair                                           |
| TPM counter one change ahead, no intent                          | —                                                                                                                           | quarantine at start                             | nothing answered from the rollback                              |
| crash between the intent and the TPM increment, or after it      | —                                                                                                                           | finishes the intent                             | carries on                                                      |
| dock swap or Wi-Fi change                                        | nothing                                                                                                                     | advisory line only                              | carries on                                                      |
| claim released                                                   | `released`: back to `kept`, held for Carry on here                                                                          | E+2, takeover offered                           | the laptop's                                                    |
| Give up after the laptop wrote `moved`                           | `released` for that epoch: back to `kept`, branch kept, Carry on here                                                       | thread fenced at rest, then E+2                 | the laptop's                                                    |
| quarantine while the barrier is open                             | `quarantined` at the next check: tree stopped, closed                                                                       | quarantine                                      | nothing runs                                                    |
| Take over anyway, then a late release                            | `moved` (the standby)                                                                                                       | owns it                                         | the standby                                                     |
| Take over anyway, then a late commit                             | `moved` (Studio); nothing to clean                                                                                          | holds its thread for the person: Stop it here   | the person picks (warned double owner)                          |

### 11. What ace can't detect

Plainly, these are unsupported or residual:

- **A live clone of a running VM on a hypervisor without a generation id or a revert report**
  (every macOS guest under Virtualization.framework; any hypervisor with the device off), while
  either copy can't reach the standby. Each copy runs for up to the 5-minute VM bound, and longer
  only if the person presses Run here anyway. Warned in the VM.
- **A software-tier standby cloned without any signal**, and pressed to take over on the clone.
  Both may run until the clone's `keep.takenOver` reaches the laptop. Warned at opt-in.
- **A same-host standby restore without a TPM counter**, to exactly the laptop's last contact, after
  a takeover. Nothing runs twice, but the takeover's work is lost.
- **A container given the host's TPM** and a copy of the home at the same path.
- **A job the agent detached** past what ace can trace (`env -i nohup`, a tmux server). It survives
  Stop, quiescence and every barrier.
- **A sleep of 1 second or less on Linux without the helper.**
- **Effects outside ace** (a push, a deploy, a message) made before the laptop stops, and possibly
  repeated by the standby from an older copy.

### 12. Costs and bounds

- **Idle threads cost nothing.** Generations happen only at turn ends. Status checks happen only
  at barriers, every 60 seconds while kept work runs, and from the standby while the runner is
  unreachable and a client is looking.
- **Captures** run one at a time across the runner, at most once every 2 minutes per thread, cut
  off after 10 seconds, and never on checkouts over 100,000 files.
- **Bytes.** A generation's bundle is usually kilobytes and its summary a few kilobytes, well
  under a second on 3G (400 kbit/s). A status check is a few hundred bytes. Generation 1 never
  crosses ace's relay.
- **The standby's disk** is held under one hard cap (20 GiB). The cap covers baselines, staging,
  unreclaimed objects and takeover pins. Space is reserved before intake, and bounded reclamation
  runs under pressure and once a day.
- **Signatures:** one per request and one per answer. A Secure Enclave or TPM signature takes
  milliseconds to tens of milliseconds, a few times a minute at most.
- **TPM counter writes:** one per ownership change, never per generation. That is a few a day,
  well within NV endurance.
- **Reservations at peak** hold back up to twice a generation's pack bytes while it lands, plus one
  landing headroom for the whole standby.
- **The helper** runs only while a thread is kept, and holds the inhibitor only while a kept thread
  works.
- **Startup** (ADR 0170): rows are found through the ownership table and the `_open` side tables
  (`keep_takeover_open`, `keep_cleanup_open`, and the owed claims and retirements). The barrier
  sends one `keep.status` per standby, batched across its threads.

## Rejected

- **Automatic hand-over when the laptop leaves, on proof that its tree stopped** (the second
  draft). On macOS nothing contains an agent's processes (`env -i nohup … &`, or work a tmux server
  launches), so no proof is reliable there. A hand-over that might leave a process running is a
  takeover nobody chose. With it went the `ACE_TREE` marker scan, cgroup containment, the freeze
  before an unproven sleep, and the hand-overs on low battery and on quit or shutdown.
- **Automatic takeover after silence, under a lease** (the first draft). Its safety needed a daemon
  that never stalls, a Stop that always ends every process, clock rates that hold through VM
  migration, a sleep-counting clock in the shipped runtime (Bun 1.4.4's `performance.now()` pauses
  in macOS sleep), and a daemon that acts before thawed children run.
- **Any heartbeat-driven automatic path.** Silence only changes words.
- **Trusting a restart on a software key.** A VM clone carries the key. So restarts are trusted
  silently only with a hardware key or a clean end (section 7).
- **The wall clock as the wake signal.** A short sleep doesn't move it far enough, and NTP moves it
  when nothing slept. Kernel wake records replace it.
- **Exempting first copies from the quota.** Many first copies can fill a standby.
- **Reserving wire bytes only.** A small bundle can land as a large checkout, and a repack needs
  room of its own.
- **Network hardware as a clone signal.** Docks and adapters change it on healthy machines. It is
  advisory only.
- **An orderly TPM counter.** It can jump forward after an unclean shutdown, which would quarantine
  a healthy standby.
- **The cuts the fourth review proposed:** dropping the hardware tier, the TPM counter and the
  live-move claims, among others, for a smaller design. The owner chose to keep the fuller design
  and fix the findings instead (2026-11-19).
- **Periodic captures during a turn, and native session copies**, for now (not measured).
- **Clearing the barrier after a while.** Elapsed time says nothing about whether the person took
  over.
- **Just start the work on the server.** It already works, but the choice has to be made before the
  work starts.
- **An arbiter in ace's cloud** (ADR 0002), **wall clocks compared across machines**, **keeping the
  Mac awake**, **bringing a thread back automatically on wake**, and **Electron's `powerMonitor`**
  (the daemon runs with no app, ADR 0186).

## Follow-ups

- **Automatic hand-over on Linux with cgroup containment.** A tree in its own cgroup can be proven
  empty, so a Linux laptop could hand over at the sleep notice, through this ADR's fence, after its
  own review.
- **Stopping a cut-off laptop after a long silence**, so that the double run after a takeover
  doesn't last until reconnect. It costs availability (open question 1).
- Windows: the TPM identity, sleep notices, and keep-going itself.
- Native session copies and in-turn captures, once measured.
- Moving children with their parent.

## Review history

**First review (lease, at 63365e5fce):** rejected automatic takeover on silence (stalls, Stop
reports, escapees, VM clock bounds, Bun's paused clock, thaw before timers).

**Second review (proof, at e9253358cd):** no containment on macOS, so no automatic hand-over in
version one. Its seven findings were answered at 7f8e2c11ce:

1. stop proof: moot;
2. lost replies: never permission;
3. clones: identity outside the home;
4. bypass: Run here anyway;
5. replayable setup;
6. helper bounds;
7. turn-end copies.

The third review refined findings 2, 3, 5 and 7 below.

**Third review (at 7f8e2c11ce):**

1. **VM clones of a software key register as restarts.** Resolved. The runner and standby keep a
   hardware-bound key where the host has one (section 7's table). On a software-tier host, a new
   holder is admitted silently only on the previous holder's clean end. Otherwise recovery is
   explicit and warned, and two live copies are quarantined.
2. **A pending claim was treated as a completed move.** Resolved. Intent and outcome are persisted
   by transfer id on both sides, and lost answers are reconciled on restart. Pending claims stay
   fenced until a confirmed commit or release, and a release after either kind of confirmed
   failure gives the thread back and offers takeover again, matching ADR 0191 (section 3).
3. **An earlier signed answer arrives late, and same-host restores.** Resolved, with one residual
   stated:
   - per-request challenges, scoped to a barrier;
   - checks again on reconnect, every 60 seconds and on `keep.takenOver`, stopping at a higher
     epoch;
   - the laptop's authority record (refusing older, or equal with a different chain);
   - the TPM NV counter on Linux hardware;
   - quarantine when the fingerprint changes.

   Section 6 says what a challenge proves and what it doesn't. Section 7's rollback table names
   the one restore the design can't catch, and why it never runs a thread twice.

4. **Setup replay.** Resolved. A landing is complete only once its ignored files are copied and its
   marker is written; it is built in a `.partial` folder that is renamed after. Retryable failures
   keep their inputs pinned and are shown on the standby's list and on the source, even with no
   thread yet. Give up gives the thread back. `enqueue` moves on only on accepted admission: the
   same attempt id after an ambiguous reply, a fresh one after a confirmed refusal, as in
   `live/target.ts` (section 5).
5. **Wake detection, and recovering an identity.** Resolved:
   - kernel wake records (`kern.waketime`; boot-time minus monotonic) replace the wall clock, and
     catch any sleep within 5 seconds;
   - a key store that isn't available yet is retried, with words and Run here anyway;
   - a key that is gone has Rebind;
   - retirement owed delivers tombstones to offline peers later, and the fence holds before they
     arrive (section 7).
6. **Warm-copy bounds.** Resolved. There is one hard cap covering baselines, staging, unreclaimed
   objects and pins. Space is reserved before intake, and reclamation runs under pressure. Captures
   run one at a time across threads (section 2).

**Fourth review (at 6ebc149ee2):**

1. **A live VM snapshot clone runs as two identical copies.** Resolved as far as any daemon can
   (section 7, "Live clones"):
   - a VM generation id change (Hyper-V, QEMU `vmgenid`, VMware), seen through the kernel's uevent
     and compared at start;
   - guest-agent revert reports;
   - sequence collisions, which the standby sees and the runner sees;
   - the 5-minute silence rule for runners in a VM.

   On detection, both copies stop. A hypervisor without a generation id is listed as unsupported,
   and ace warns when it runs in one.

2. **A clean end didn't prove the processes ended.** Resolved. A record needs verified quiescence of
   every process ace started (pid and start time) and the run burned on disk before it is written.
   It is single use, and a second presentation quarantines. Without it there is no silent restart.
3. **Release, Give up and quarantine were inferred from epochs.** Resolved by five signed outcomes
   (`standby`, `released`, `moved`, `quarantined`, `revoked`), each with one durable transition.
   - Give up fences the thread at rest, one change at a time with admission, before ownership
     returns, and the laptop's `moved` goes back to `kept` only for that takeover.
   - Quarantine closes dispatch at the next check.
   - Take over anyway moves the claim to `overridden`, and a late commit or release is answered
     explicitly.
4. **The TPM allowance accepted a restore one change behind.** Resolved by the durable intent
   protocol: intent, then TPM, then apply, then answer. Any mismatch an intent doesn't explain
   quarantines.
5. **Helper, keychain, probes, wake and network.** Resolved:
   - a provisioned helper bundle for the data-protection keychain, run in a user session; never a
     LaunchDaemon; the CLI archive carries the bundle; without it, the software tier;
   - Linux probes run from the real service context;
   - the Linux fallback's 1-second blind spot is stated;
   - network changes are advisory only.
6. **Disk peaks and worktree moves.** Resolved:
   - peak reservations from the sender's tree figures times a measured factor, with one landing
     headroom;
   - a repack reservation, or a prune-only fallback;
   - filesystem quotas used where set;
   - Git's own `worktree add`, `move`, `repair` and `remove` throughout.

## Verification

**Pure** (`transfers/keep/*-rules.ts` and their tests):

- the epoch fence: takeover against claim, claim commit and release, give up, retire, recover,
  rebind, a stale epoch;
- the claim reconciler after a lost answer at each step;
- the identities derived from the stream and epoch;
- each setup stage's done-when check, including a landing without its marker;
- `enqueue`'s attempt ids after an ambiguous reply and after a confirmed refusal;
- the cleanup journal;
- the barrier's answer rules: wrong challenge, earlier barrier, lower counter, equal counter with a
  different chain, unsigned, refused holder;
- re-checking after open;
- holder admission by tier: a hardware signature, a clean end, an unclean end, two registrations
  from one predecessor;
- network changes staying advisory (a dock swap, Wi-Fi, VPN), and the signals that do quarantine;
- the TPM intent protocol: each crash point between its four steps finished, and every unexplained
  mismatch (one ahead with no intent, two ahead, behind) quarantined;
- the five signed outcomes and the one transition each allows, including a `released` for a claim
  never made refused;
- clean-end admission: quiescence failing, the burned run refusing dispatch, a record id used twice;
- sequence collisions and a sequence going backwards;
- the VM silence rule;
- peak reservations, the measured factor, landing headroom, and the repack reservation or prune
  fallback;
- the landing replay from each `git worktree list` state;
- reservations, the hard cap, reclamation order, and pins kept;
- the capture scheduler: coalescing, the interval, one at a time, oldest first, backoff;
- both wake detectors, with injected readings.

**Two real daemons** over their pinned link, with real Git, scripted providers (one starts
`env -i nohup` work), a fake host helper (a software key, or a fake hardware signer), and a proxy
on every route that can drop, hold, delay or replay traffic. A partition and a SIGKILL of either
daemon are injected at each step:

- a reservation, a generation half-written, and reclamation;
- the claim, its commit and its release;
- the takeover transaction, and each setup stage, including mid-landing;
- `moved`, and each cleanup stage;
- a rebind, and a retirement owed.

Named tests:

- **VM clone:**
  - a software-tier laptop's home and keychain copied, with the same machine id and path, to a
    second VM while a turn runs. The copy is never admitted without Carry on here, and Carry on
    here quarantines both once the original speaks;
  - the same with a fake hardware signer, where the copy's signatures fail;
  - a powered-off clone booted beside the original. One is admitted, then both are quarantined.
- **Standby restore:**
  - the standby's home restored to before the laptop's last contact. The laptop refuses it;
  - restored on a fake TPM counter. The standby quarantines itself;
  - restored to exactly the last contact, after a takeover. The laptop opens, and nothing of the
    takeover runs.
- **Delayed old answer:** a "standby" answer to the barrier's first challenge, held by the proxy
  while the person takes over, then released.
  - If a newer answer was accepted first, the old one is refused.
  - If the old one arrives first, the laptop opens, then stops at the next check or at
    `keep.takenOver`. Its run marks end within that bound.
- **Crash mid-landing:** SIGKILL after `git worktree add` and before the ignored files finish
  copying. On restart the partial landing is removed with `git worktree remove` and landed again,
  and the thread starts with every ignored file, once. A second run kills the daemon inside
  `git worktree move`, and `repair` brings the registration and the folder back into step.
- **Live VM snapshot clone, with vmgenid:** a QEMU guest running a kept turn is snapshotted live,
  and the snapshot is resumed as a second VM. Both copies see `NEW_VMGENID` and stop, the standby
  quarantines, and neither runs until the person admits one.
- **Live VM snapshot clone, without vmgenid:** the same with the device off.
  - With both copies on the network, the sequence collision quarantines within one exchange.
  - With the clone cut off, it stops at the 5-minute bound.
  - The VM warning is shown.
- **Daemon crash after a clean-end record, with a surviving job:**
  - A scripted provider leaves a child that ignores SIGTERM, so quiescence fails and no record is
    written. The successor gets explicit recovery.
  - In a second run quiescence passes and the daemon is SIGKILLed right after writing the record.
    The burned run dispatches nothing, and the successor is admitted once. A copy of the home
    presenting the same record is quarantined.
- **TPM rollback by one change:** on a swtpm-backed test counter, the standby's home is restored
  to the state just before a takeover. The TPM is one ahead with no intent, so the standby
  quarantines and answers nothing from the restored state. Crashes between each of the four intent
  steps are finished, not quarantined.
- **Dock swap:** a USB Ethernet adapter is removed and another added on a healthy standby, and its
  Wi-Fi network and VPN change. The standby only shows the advisory line. No stream is
  quarantined, and a Take over works.
- **Outcomes:**
  - a claim released after `handing` is read as `released`, not as moved;
  - Give up racing an accepted continue message waits for the tree to rest, then returns the
    thread;
  - a quarantine during an open barrier stops the tree at the next check;
  - Take over anyway followed by a late commit, and by a late release.
- **Disk:** a 2 MB bundle whose checkout and ignored files are 3 GB is reserved at its peak and
  refused when it can't fit. A repack that can't reserve its room falls back to prune.

Cases:

- a sleep notice, with a last generation and with the capture cancelled;
- a missed notice with a 10-second sleep, caught by the kernel record;
- silence for hours with nobody pressing;
- a takeover with its answer lost;
- two takeovers at once;
- a takeover against a live move, both ways;
- a laptop crash after the claim, and after `handing`;
- a setup that fails before its thread exists, then Try again, and Give up;
- the laptop crashing right after `moved`;
- a barrier with the standby unreachable, then Run here anyway;
- a keychain locked under SSH;
- a migrated Mac and Rebind;
- re-pairing with the peer offline, then the tombstone on its return;
- twenty first copies against the cap;
- generations refused until reclamation frees space.

**The split-brain test:** the laptop awake and cut off with its tree running, and the person
pressing Take over. The laptop runs only until `keep.takenOver` or a check reaches it, then stops,
writes its branch and reads moved. The standby starts once. A scripted mark per run on one host
clock bounds the overlap.

**On the shipped binaries:**

- the host helper installed and upgraded from the CLI archive and from the app, on macOS and Linux;
- the helper exiting when the daemon is killed;
- a Secure Enclave key created and used by the provisioned helper bundle:
  - from the app;
  - from the CLI archive;
  - from a user LaunchAgent after an SSH start;
- the software tier reported when the bundle is missing, and in a macOS VM;
- a TPM key and NV counter probed from the systemd user service (with and without linger) on a
  physical Linux machine, and the probe's failure step reported without the `tss` group;
- a VM generation change seen through the uevent on QEMU and Hyper-V Linux guests;
- a vTPM detected as virtual on QEMU/swtpm and on a cloud VM;
- macOS lid close and `pmset sleepnow`, and `systemctl suspend` on Ubuntu, Fedora and Omarchy;
- `kern.waketime` and the boot-time clock catching a 3-second sleep without the helper;
- the keychain item not restoring to another Mac.

**Measured before in-turn captures or native session copies come back,** with the slow-link
harness (#2038), on ace's repository and on a 200,000-file one: CPU time and wall time per
capture, bytes per generation, the standby's disk use against the cap, reclamation time, and the
time from Take over to the continue message running, on 3G and on a LAN.
