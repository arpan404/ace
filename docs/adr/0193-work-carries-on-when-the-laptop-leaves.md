# 0193: Work carries on when the laptop leaves

Date: 2026-11-19. Status: proposed (design, version one, revised after three reviews; before the
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

**Space is reserved before intake.** A generation's `begin` states its size (generation 1's from
ADR 0191's prepare; a later one's from its bundle and summary). The standby reserves that many
bytes in one transaction, against the cap and against the stream's own limit (4 GiB, including
its baseline). If the reservation doesn't fit, the generation is refused before a byte is sent. A
reservation is released when its generation is pinned (and turned into usage) or abandoned. A
reservation whose upload goes silent for an hour is abandoned and its staging is removed.

**Reclamation under pressure.** When usage passes 80% of the cap, or a reservation is refused, the
standby reclaims space:

1. It drops refs older than each stream's last two pinned generations. A ref held by a takeover's
   setup is never dropped (section 5).
2. It runs `git gc --prune=now` on the landing repository with the most unreclaimed bytes, one
   repository at a time, at idle CPU and I/O priority, with a 5-minute budget.
3. It measures again, then retries the refused reservation once.

The same reclamation also runs once a day when the standby is idle (ADR 0170: bounded, never at
open). If reclamation can't free enough, the refusal stands: the runner says "omarchy is out of
room for copies", and the standby's Settings lists each stream's share.

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

Every answer the standby gives carries `epoch`, `counter`, `chain` and `pinned` (section 6).

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

   The standby compares-and-sets E+1 to E+2 back to `standby`, and Take over is offered again. The
   laptop returns to `kept` at E+2, with ADR 0191's owed resume. A lost link after `handing` is
   never a failure: the laptop keeps asking the destination, as ADR 0191 does.

7. **A restart** on either side reconciles from its own rows. The laptop re-sends the claim, the
   commit or the release that its `keep_claims` row says is owed, under the same transfer id. The
   standby answers each from the claim's recorded outcome.

If the laptop goes quiet with a claim still pending, the standby lists the thread as "MacBook was
moving this to Studio when it went quiet". The destination is the one that may own it, so Take
over isn't offered. The only choice is **Take over anyway**, with its own warning: "If Studio
already has this thread, both will run it."

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
7). It ships beside the daemon's entry bundle in every daemon release, in the CLI's archive and in
the app's bundled daemon, signed with the daemon's Developer ID on macOS. It is versioned with the
daemon: the daemon refuses a helper whose version differs from its own, and an update replaces it
after ending the old helper.

- **macOS:** `IORegisterForSystemPower` on a run loop, and the Secure Enclave.
- **Linux** (Ubuntu, Fedora, Debian, Omarchy):
  - `zbus` to logind: a delay inhibitor for `sleep`, held only while a kept thread works, plus the
    `PrepareForSleep` signal;
  - the TPM, through `/dev/tpmrm0`.
- **Protocol:** JSON lines on stdin and stdout.
  - `will-sleep {id, deadlineMs}`, which the daemon answers with `allow {id}`;
  - `did-wake {wakeId}`;
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

- **Does:** `git worktree add` at the derived path, at the generation's capture, into a folder named
  `<path>.partial`. It copies in the ignored files, syncs everything to disk, writes the marker
  file `.ace-landing-complete` (the stream, epoch, commit, and a digest of the ignored files'
  list), then renames the folder to `<path>`.
- **Done when:** the folder `<path>` exists, its marker matches, and `HEAD` is at the commit.
  Anything else, including a leftover `.partial` folder, is removed and made again.

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

**Try again** restarts the failed stage. **Give up** is a person's command: a compare-and-set from
E+1 to E+2 back to `standby`, which releases the pins and removes the partial landing and the
thread, if one was made. The laptop, once it hears, returns to `kept` at E+2 behind its barrier
(section 6). Take over is offered again.

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

  Both record a sleep of any length. Neither depends on the wall clock. A wake detected this way is
  seen within 5 seconds; a tree that thawed runs that long at most before the barrier stops it.

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

- **Still `standby`, this holder admitted:** the laptop opens the barrier. Held work runs, and an
  interrupted turn gets the carry-on message.
- **Taken over, retired, or a higher epoch:** the laptop goes `moved` and runs the cleanup journal
  below.
- **Claimed by its own transfer:** it reconciles the claim (section 3).
- **No answer:** the barrier stays closed and the laptop keeps asking.

#### After it opens: checking again

While the barrier is open and a kept thread has work running or queued, the laptop asks again
with a fresh challenge:

- every 60 seconds;
- at once, on every reconnect and every route change;
- on every `keep.takenOver` it receives.

Any accepted answer with a higher epoch, or showing a takeover, stops the tree at once and starts
the cleanup journal. An unanswered check does not close the barrier: a laptop cut off from its
standby keeps working, which is the risk the takeover's confirmation names. A late answer to an
older challenge can never undo a higher epoch, because the authority record only moves forward.

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

On the Linux hardware tier, the standby also keeps its stream `counter` mirrored in a **TPM NV
monotonic counter** (`TPM_NT_COUNTER`), where the owner hierarchy allows defining one. The counter
is incremented before each change is written. At start, a stored counter below the TPM's
(allowing one change in flight) means the home was rolled back. Its streams are quarantined
(below).

#### The software tier: everything else

The key is a P-256 key outside the ace home:

- on macOS, in the login keychain, `AfterFirstUnlockThisDeviceOnly` and not synchronizable;
- on Linux, in the Secret Service when there is one, else `$XDG_STATE_HOME/ace/identity` (mode
  0600).

It is bound to the hardware id (`IOPlatformUUID`; `/etc/machine-id`) and to a fingerprint: the
machine's permanent network addresses. A copy of the whole machine, such as a VM clone that kept
its disk, machine id and keychain, carries this key. **So on this tier ace never trusts a
restart by itself.** Exactly:

- **Holder replacement needs a clean end.** A daemon that stops cleanly (Quit ace completely,
  `ace stop`, a system shutdown) first stops its kept trees with ordinary Stop. It then writes a
  signed **clean-end record** for its run into the home, and sends it to the standby if it can.
  The next run presents that record when it registers. The standby admits the new run silently
  only if the record names the currently admitted holder. A run that finds no clean-end record for
  the run before it (a crash, a power loss, a snapshot taken mid-run) is never admitted silently.
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
- **A changed fingerprint** (new network hardware, which is what most hypervisors give a clone) is
  treated as an unclean restart, on either side. On a standby, its streams are quarantined until
  the person confirms there: "omarchy looks like a copy of itself (its network hardware changed).
  Confirm it's the original to keep copies here."

**A software-tier standby** can't prove it isn't a clone either. Opting in says so: "omarchy can't
prove it isn't a copy of itself. Don't clone it while it keeps copies." If a clone the fingerprint
didn't catch is pressed to take over while the laptop talks to the original:

- the clone sends `keep.takenOver` to the laptop on every route until acknowledged (section 5), and
  the laptop stops the moment one arrives;
- the original, told by the laptop of a higher epoch it never wrote, quarantines itself.

Until then both may run. That is the same risk as Take over on a laptop that is still awake, but
here nobody pressed anything on the original. That is why opting in shows it and why it is listed
as residual.

#### Rollback of a standby

| case                                                                                                     | caught by                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| restored to a point before the laptop's last contact                                                     | the laptop's authority record (a lower counter, or an equal counter with a different chain)                                                                                                                                                                                                                 |
| restored to another machine                                                                              | the identity: hardware, it can't sign; software, the fingerprint changed and its streams are quarantined                                                                                                                                                                                                    |
| restored on the same machine, hardware tier on Linux                                                     | the TPM NV counter; streams quarantined                                                                                                                                                                                                                                                                     |
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

| when                       | the line                                                                                                     | buttons                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------- |
| opted in                   | Keeps a copy on omarchy · from 13:58                                                                         |                        |
| standby can't prove itself | omarchy can't prove it isn't a copy of itself. Don't clone it while it keeps copies.                         |                        |
| first copy going           | Getting omarchy ready · 312 MB of 1.2 GB                                                                     |                        |
| copy failing               | omarchy's copy is from 13:58: <reason>                                                                       |                        |
| out of room                | omarchy is out of room for copies.                                                                           |                        |
| asleep (seen elsewhere)    | MacBook is asleep · omarchy's copy is from 13:58                                                             | Take over on omarchy   |
| quiet (seen elsewhere)     | MacBook went quiet at 14:02 · omarchy's copy is from 13:58                                                   | Take over on omarchy   |
| moving when quiet          | MacBook was moving this to Studio when it went quiet.                                                        | Take over anyway       |
| taking over                | omarchy took this over at 14:10 · Getting the project ready                                                  |                        |
| couldn't start             | omarchy took this over but couldn't start it: <reason>                                                       | Try again · Give up    |
| running there              | Running on omarchy since 14:11.                                                                              | Open · Bring it back   |
| laptop barrier             | Checking with omarchy before carrying on.                                                                    | Run here anyway        |
| stale standby              | omarchy answered from an older copy of itself. Still checking.                                               | Run here anyway        |
| key not available yet      | Waiting for this Mac to be unlocked before checking with omarchy.                                            | Run here anyway        |
| unclean restart (software) | ace on this Mac stopped without closing cleanly. If no other copy of this Mac is running ace, carry on here. | Carry on here          |
| key gone                   | This Mac's keep-going key is gone (it was reinstalled, migrated or moved).                                   | Rebind                 |
| two copies                 | Two copies of MacBook are running this. Re-pair to keep a copy.                                              |                        |
| standby looks copied       | omarchy looks like a copy of itself. Confirm it's the original to keep copies here.                          | It's the original      |
| moved on reconnect         | Moved to omarchy at 14:10. MacBook's work after 13:58 is on branch ace/kept/… here.                          | Open · Send to omarchy |
| live move refused          | Can't reach omarchy, which keeps a copy of this thread.                                                      |                        |

**Bring it back** is ADR 0191's live move from the standby to the laptop, claimed through the fence
(section 3), landing through ADR 0101's landing reuse. Uncommitted work in the laptop's checkout
goes onto an `ace/kept/` branch first. It is never automatic.

### 9. Wire

These are calls on the transfer protocol (ADR 0192: every route, idempotent by id, never parcels).
Every request is signed by its sender's identity, and every answer by the answerer's, over the
request's challenge.

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

| case                                                        | runner                                                                                                                      | standby                                         | ends with                                                       |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------- |
| lid closes, notice heard                                    | stops, sends a last generation if there's time, sleeps                                                                      | shows asleep                                    | the laptop's, until the person acts                             |
| notice missed, short sleep                                  | kernel wake record seen within 5 s; the barrier stops the thawed tree                                                       | shows quiet                                     | the laptop's, once answered                                     |
| silent for hours, nobody presses                            | —                                                                                                                           | idle                                            | the laptop's                                                    |
| Take over, laptop asleep                                    | on wake: barrier, answer "taken over", cleanup                                                                              | setup to started; `keep.takenOver` retried      | standby; laptop moved, work on a branch                         |
| Take over, laptop awake and cut off                         | runs (the warned risk) until an answer or `keep.takenOver` reaches it                                                       | setup to started                                | standby; laptop moved                                           |
| an old "standby" answer arrives after a takeover            | refused if its challenge is no longer outstanding; if accepted first, the next check (≤ 60 s) or `keep.takenOver` stops it  | —                                               | standby; laptop moved                                           |
| Take over's answer lost                                     | —                                                                                                                           | receipt on resend                               | one takeover                                                    |
| two clients press Take over                                 | —                                                                                                                           | the first wins                                  | one takeover                                                    |
| Take over racing a live move                                | a pending claim fences takeover / a takeover fails the claim                                                                | epoch fence                                     | one owner                                                       |
| laptop crashes after claim, before `handing`                | restart: release under the same transfer id                                                                                 | claim released, E+2                             | the laptop's, takeover offered again                            |
| laptop crashes after `handing`                              | restart: asks the destination (ADR 0191), then commit or release                                                            | claim stays pending meanwhile                   | one owner                                                       |
| crash mid-landing                                           | —                                                                                                                           | no marker: partial removed and landed again     | started once                                                    |
| setup fails before the thread exists                        | told on contact                                                                                                             | listed with Try again or Give up; inputs pinned | the person decides                                              |
| laptop crashes right after `moved`                          | the cleanup journal replays stop, cancel, rescue                                                                            | —                                               | moved, branch written                                           |
| laptop wakes, standby unreachable                           | barrier closed, retrying forever                                                                                            | —                                               | waits, or Run here anyway                                       |
| answer from an earlier wake                                 | dropped (old barrier id and challenge)                                                                                      | —                                               | barrier holds                                                   |
| standby restored before the last contact                    | refused by the authority record                                                                                             | —                                               | barrier holds; Run here anyway or re-pair                       |
| standby restored to the last contact, with a takeover after | opens (the takeover's state is gone with the restore)                                                                       | runs nothing of it                              | one runner; the takeover's work is lost (residual)              |
| VM clone of a hardware-tier laptop mid-turn                 | the clone can't sign: refused                                                                                               | —                                               | the original                                                    |
| VM clone of a software-tier laptop mid-turn                 | the clone has no clean end: explicit recovery; if the person carries on there, the original's next message quarantines both | quarantine                                      | nothing runs; re-pair                                           |
| cloned powered-off software-tier laptop, both started       | first admitted; the second's registration quarantines both                                                                  | quarantine                                      | nothing runs; re-pair                                           |
| cloned software-tier standby, takeover on the clone         | stops on the clone's `keep.takenOver`                                                                                       | the original quarantines on the laptop's report | the clone's thread, after a window (residual, warned at opt-in) |
| migrated Mac, key gone                                      | Rebind (warned), or Take over on the standby                                                                                | old key retired                                 | one owner                                                       |
| key not available in an SSH session                         | retried; barrier closed                                                                                                     | —                                               | opens after unlock                                              |

### 11. Costs and bounds

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
- fingerprint changes;
- the TPM counter's rollback rule;
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
  copying. On restart the partial landing is removed and landed again, and the thread starts with
  every ignored file, once.

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
- a Secure Enclave key created and used by the signed helper, and refused in a macOS VM;
- a TPM key on a physical Linux machine;
- a vTPM detected as virtual on QEMU/swtpm and on a cloud VM;
- macOS lid close and `pmset sleepnow`, and `systemctl suspend` on Ubuntu, Fedora and Omarchy;
- `kern.waketime` and the boot-time clock catching a 3-second sleep without the helper;
- the keychain item not restoring to another Mac.

**Measured before in-turn captures or native session copies come back,** with the slow-link
harness (#2038), on ace's repository and on a 200,000-file one: CPU time and wall time per
capture, bytes per generation, the standby's disk use against the cap, reclamation time, and the
time from Take over to the continue message running, on 3G and on a LAN.
