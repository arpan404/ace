# 0193: Work carries on when the laptop leaves

Date: 2026-11-19. Status: proposed (design; revised after review, before the build). Decided by:
the owner (the outline, 2026-11-18; no automatic takeover after silence, 2026-11-19), this ADR
(how). Builds on [ADR 0191](0191-continue-a-working-thread-on-another-machine.md) (live
continue) and [ADR 0192](0192-transfers-over-every-machine-route.md) (transfers over every
route). Amends ADR 0191's ownership record.

## Context

A person works on a laptop, then closes the lid, quits ace, or the battery runs down, and the agent
stops with the laptop. ADR 0191 can move a working thread, but only when the person asks and both
machines can talk for the whole move. What the person wants is to say once, "if I leave, keep this
going on omarchy" (their server), and have it happen.

Copying is the easy part. ADR 0191 already copies code and the provider's native session and
switches over at one cutoff. The hard part is knowing that the laptop has really stopped. A laptop
that sleeps, stalls or loses its link can't say so. A first draft of this ADR let the server take
over once a lease ran out, with the laptop stopping itself on its own clock. Review found that the
draft's guarantee broke in ordinary cases:

- a daemon stalled past its deadline;
- a Stop that reported stopped while a process still ran;
- processes that escape the process group;
- a VM migration that breaks clock-rate bounds;
- the shipped Bun's `performance.now()`, which pauses during macOS sleep;
- children that thaw before any JS timer runs.

Any one of these runs the thread on both machines. A daemon started on a copy of a live home has
already done that once (the cloned home incident, 2026-11-16).

Priority 1 in AGENTS.md decides this ADR: never two owners. The owner's ruling follows from it.
ace hands a thread over by itself only when the laptop proves its tree has stopped. When the
laptop simply goes quiet, only the person can move the thread, and ace tells them plainly what
that risks.

## Decision

### 1. Opt in, per thread, with a project default

A thread runs on one machine (the **runner**) and names one other machine of the person's (the
**standby**). The person turns it on from the thread's menu: "Keep going on omarchy if I leave".
A project can make it the default for its new threads (Settings › the project: "Keep new threads
going on omarchy if I leave"). It is a person's command (`thread.keepGoing`), with the person's
standing as ADR 0190 defines it, and never an agent's.

It is offered only when:

- the standby is linked with `operate` and `projects` allowed (ADR 0101), and answers
  `keepGoing: true` in `begin` (an older ace: `target_too_old`);
- the standby has a signed-in account for the thread's provider (else "omarchy has no Claude
  sign-in");
- the thread is a root thread (ADR 0191, `thread_is_child`);
- both sides pass the host check of section 7.

### 2. Warm copies: Git checkpoints and a summary

The standby keeps a copy of the thread that is recent enough to start from. A copy is a
**generation**, numbered from 1 for each keep-going **stream** (one stream per thread and standby,
with its own id).

**Generation 1** is ADR 0191's bulk: code, branch and ignored files, uploaded while the agent
works. It goes only over a direct route or the person's own relay, never over ace's hosted relay.
Until it lands, the thread isn't kept: "Getting omarchy ready · 312 MB of 1.2 GB".

**Each later generation** holds:

- **Code.** A capture commit of the checkout (`captureChanges`, the temporary index ADR 0191 uses,
  so the person's checkout and index are untouched) and an incremental bundle that excludes the
  last pinned generation's capture and branch head.
- **A summary.** A fresh `@ace/handoff` summary of the thread, bounded as ADR 0101 bounds it, plus
  the thread's title, mode, provider, model and queue count.

The native session is **not** copied in this stage. Claude's and Codex's session files can be
rewritten in place, so a tail with a short overlap check can miss a change earlier in the file.
Sending them whole on every generation costs more than has been measured. A planned handover still
carries the native session whole, through ADR 0191's final payload (section 4). A person's takeover
starts from the summary. Native session copies come back only after the measurements in
"Verification" justify them.

**When.** A generation is made at each end of the root's turn. During a long turn one is made every
10 minutes if the capture differs from the last one (20 on battery). Captures are bounded:

- If a capture takes longer than 2 seconds, or the checkout has more than 100,000 files, the
  thread drops to turn ends only.
- The line then says how old the standby's copy is ("omarchy's copy is from 13:58").

**Fair, not newest first.** Each standby takes one generation at a time. Kept threads take turns,
oldest copy first, and each thread has at most one generation waiting; a newer capture replaces
its own waiting one. A quiet thread can't be starved by a busy one, and a slow link makes copies
older, never more numerous. A generation is `part=warm` under ADR 0192's hosted-relay policy, the
same as `final`: allowed up to `HOSTED_RELAY_TRANSFER_BYTES` (8 MiB). Past that, with only ace's
relay to send it on, it waits for a route that can take it.

**Pinned atomically.** The standby writes a generation's bundle into the project's landing
repository under `refs/ace/keep/<stream>/g<N>`, then its summary file, and syncs both to disk.
Then, in one transaction, it records `pinned = N` on the stream's row. A generation that arrived
only in part is never pinned and is never started from. The standby keeps the last two pinned
generations and removes older refs afterwards. Nothing is checked out until a takeover or
handover, and nothing goes into a provider's home. **No thread row exists on the standby**, so
nothing there can dispatch, recover or resume it.

### 3. Who owns the thread

ADR 0191's `thread_ownership` gains two states:

| state     | on      | meaning                                                                 |
| --------- | ------- | ----------------------------------------------------------------------- |
| `kept`    | runner  | owns the thread; a standby holds generations of it                      |
| `standby` | standby | owns nothing; holds generations; owns the thread only by section 4 or 5 |

`stopping`, `handing`, `moved` and `owned` keep their ADR 0191 meanings. Both new rows carry:

- `stream`: the stream id;
- `epoch`: grows with every change of owner (ADR 0191);
- `holder`: a nonce the runner's daemon draws at each start and registers with the standby
  (section 7);
- `pinned`: the standby's last pinned generation;
- `host`: the binding of section 7.

**There is no lease and no timer that moves ownership.** Ownership changes in only two ways:

1. **A handover**, sent by the runner with proof that its tree stopped (section 4).
2. **A takeover**, pressed by the person on another client (section 5).

Both are compare-and-set on the standby row's epoch, run one at a time per stream in one
transaction. The first wins; the second is answered with the first's result. So a handover that
races a takeover, a repeated takeover, or a takeover pressed on two phones, all end with one owner.

**Sequencing.** Every message of a stream carries `stream`, `epoch`, `holder` and, where it applies,
`generation`. The standby refuses a message under an old epoch or an unregistered holder, and a
generation that isn't newer than `pinned`. Every obligation is written before its message goes:

- `handing` on the runner before the handover is sent (ADR 0191);
- the takeover's whole transaction on the standby before it is answered (section 5);
- a generation's pin before it is acknowledged.

Only three things need ordering now: generations, the handover and the takeover. The draft's
`arm`, `renew`, `park` and `pause` are gone, and their races with them.

**Delegation to other machines is not blocked while kept.** A handover needs every remote child's
machine to confirm it stopped (ADR 0191, section 2), so a child can't escape it. A takeover is the
person's call, and its words list the work running elsewhere (section 5).

**Liveness is for words only.** While a kept thread is working, the runner sends `keep.beat` to the
standby every 30 seconds and at each turn end: one batched call per standby, about 200 bytes. The
standby notes when it last heard, on its own monotonic clock. The note only chooses the words other
clients show ("MacBook went quiet at 14:02"). It never moves ownership, so no clock has to count
sleep, keep a rate bound, or agree with another machine's.

### 4. Handing over with proof that the tree stopped

The runner hands a kept thread over by itself only when it is leaving and can prove its tree
stopped. It leaves on:

- **the sleep notice** (lid close, the Sleep menu, idle sleep);
- **low battery**: on battery with 5 minutes or 5% left, before the system forces sleep;
- **a normal quit or shutdown**: Quit ace completely, `ace stop`, or the daemon told to stop by
  the system at logout, restart or shutdown. A plain app quit leaves the daemon running (ADR 0186),
  so nothing is handed over.

Then, for each kept thread that is working, within the time the system allows:

1. **Stop**, with ace's ordinary Stop (ADR 0191, section 2), terminals included. The ownership
   record goes `stopping`, which refuses new turns, delegations and terminals.
2. **Prove the tree stopped.** A Stop that reports stopped is not proof. These are, all of them:
   - every process ace started for the tree is gone, matched by pid and start time, never by pid
     alone. That covers provider CLIs, their sessions, and the terminals' shells;
   - no process carries the tree's mark. Every process ace starts for a tree gets `ACE_TREE=<token>`
     in its environment, which the processes it starts inherit, background shells and MCP servers
     included.
     - **Linux:** the tree also runs in its own cgroup, a transient user scope (`systemd-run
--user --scope`) when the user's systemd manager is there. The proof is an empty
       `cgroup.procs`, which no process can leave on its own.
     - **macOS, or Linux without a user manager:** the proof is a scan of the person's processes
       for the token (`KERN_PROCARGS2`; `/proc/<pid>/environ`).
   - every child on another machine confirmed stopped by its machine (ADR 0191; unconfirmed fails);
   - the tree reads at rest by ADR 0191's rule.
3. **Hand over through ADR 0191's live path.** Write `handing`, then send `keep.handover`
   (`stream`, `epoch`, `holder`, the pinned generation it builds on, the proof's summary, and
   ADR 0191's final payload: the delta since that generation and the native session whole). The
   standby takes it under section 3's compare-and-set and starts the thread as section 5 starts a
   takeover, with the session placed. The runner reads "Running on omarchy since 14:02."
4. **If the final payload can't be sent in time**, the handover goes without it, from the pinned
   generation. The continue message says what is missing ("changes after 13:58 are still on
   MacBook"), and the runner keeps them as section 6 does.
5. **No proof in time means no handover.** The standby does nothing on its own. The thread stays
   the runner's, with the line "Didn't hand over to omarchy: the agent hadn't stopped yet."

**Before the machine sleeps without proof**, the runner freezes what is left of the tree: `SIGSTOP`
to every process with the tree's mark, or the cgroup's `cgroup.freeze` on Linux. A frozen process
doesn't thaw by itself on wake, so the resume barrier (section 6) can decide before it runs again.
Freezing is never proof and never leads to a handover; it only keeps a stopped-or-stopping tree
from running before the daemon looks.

**Sleep notices are best effort.** No notice, a notice too short, or a helper that isn't there,
means no handover. Nothing becomes unsafe.

- **macOS.** The daemon must hear the notice with no app open (ADR 0186), so Electron's
  `powerMonitor` can't be the source. A small helper, `ace-power-helper`, ships in every daemon
  release beside the daemon's entry bundle, versioned with it: the daemon refuses a helper whose
  version differs. It calls `IORegisterForSystemPower`, runs its run loop, and speaks JSON lines
  over stdin and stdout:
  - `will-sleep {id}`, answered by the daemon's `allow {id}` (`IOAllowPowerChange`);
  - `can-sleep {id}` for idle sleep, allowed at once and never cancelled;
  - `did-wake {full}`, telling a full wake from a dark wake;
  - the battery's state, for low battery.

  The system waits for the answer up to about 30 seconds (Apple's QA1340); ace uses at most 20. The
  helper is separate from the screen helper, so a CLI-only install has it, and it needs no TCC
  grant.

- **Linux** (Ubuntu, Fedora, Debian, Omarchy: all systemd-logind). The same helper, built for
  Linux on `zbus`:
  - takes a delay inhibitor for `sleep:shutdown` only while a kept thread is working, and drops it
    when the daemon says `allow`;
  - listens for `PrepareForSleep` and `PrepareForShutdown`;
  - reads `InhibitDelayMaxUSec` and keeps one second spare;
  - reads UPower for the battery.

  logind's default delay is 5 seconds, shorter than Stop's 8-second close bound. So on a default
  Linux laptop, a handover at the sleep notice happens only when the tree stops quickly. Low
  battery and quit have no such limit. ace never changes logind's settings; Settings says the
  person can raise `InhibitDelayMaxSec`.

- **Windows** is deferred. `PBT_APMSUSPEND` gives about two seconds and can't delay sleep, and
  Modern Standby suspends processes without a usable notice. Quit and low battery may hand over on
  Windows in a later stage.

The helper is checked in each context the daemon runs in:

- **macOS:** started by the app, by `ace open` from a terminal, by the login item (a LaunchAgent in
  the person's login session), and over SSH with no login session. There the helper can't register
  and says so; keep-going still works by the person's takeover.
- **Linux:** started by a systemd user service with and without linger, and from a terminal.
  Inhibitor permission under each distribution's polkit default is checked too.

A daemon with no working helper still offers keep-going: "Hands over when you quit ace. If this
Mac sleeps, take over from your phone or omarchy."

**Low battery** gives more time than sleep does. The helper reports the battery, and at the
threshold the runner starts the steps above with no system deadline. Proof then comes from an
ordinary Stop of any length.

**Quit or shutdown** run the steps before the daemon exits. A system shutdown allows what launchd
(`ExitTimeOut`, 20 seconds for the login item) or the logind shutdown inhibitor allows. Quit ace
completely shows "Handing 2 threads to omarchy" and waits for them, up to 60 seconds, with "Quit
now" to stop waiting. Quitting now leaves those threads the laptop's, frozen and stopped.

### 5. A person's takeover after the laptop goes quiet

When the laptop goes silent (a dead battery, a lost network, a stalled daemon, a sleep without a
handover), the standby never takes the thread on its own. It lists the thread to every client of
the person's that can reach it: the phone, the standby's own window, another machine.

- **Quiet.** 90 seconds after the last beat of a working thread, or at any time for a thread at
  rest when its runner isn't answering, it reads: "MacBook went quiet at 14:02 · omarchy's copy is
  from 13:58", with **Take over on omarchy**.
- **The confirmation**, which must be pressed: "Take over on omarchy? If MacBook is still running
  this, both will run it until MacBook reconnects. Then MacBook stops at once and keeps its
  changes on a branch. omarchy starts from the copy of 13:58." When work runs on a third machine:
  "Work it started on Studio keeps running until MacBook reconnects." Buttons: **Take over** and
  **Cancel**.

`keep.takeOver` is a person's command with the person's standing (ADR 0190), sent to the standby,
never offered to agents. It carries the epoch the client saw and a command id.

**One transaction** on the standby, under section 3's compare-and-set:

- the epoch goes up by one, and the row records `owned`;
- the generation started from is fixed: the pinned one at that moment;
- the new thread's id is derived from the stream and the new epoch, so every retry and every
  restart names the same thread;
- a takeover transfer row joins ADR 0191's recovery tables (`transfer_incoming_open`), with its
  pending start (`transfer_live_start`, `transfer_live_pending`);
- the receipt is keyed by the command id.

**Then setup runs through ADR 0191's recovery**: the landing worktree checked out at the fixed
generation's capture, the handoff summary in front, the link back, and one continue message.

- **A lost answer:** a resent command with the same id gets the receipt. One with a new id but the
  old epoch is answered "already taken over" with the same thread.
- **A restart at any point after the transaction:** the restart finds the transfer in
  `transfer_incoming_open` and the start in `transfer_live_pending`, and carries them on. Before
  the transaction, nothing happened.
- **Repeated restarts** reach the same state, because each step is keyed to the derived thread id
  and the takeover transfer.

The continue message says where the copy came from and how to treat the outside world: "This
thread moved here from MacBook, which went quiet at 14:02. The project is as of 13:58 and files
Git ignores are as of when keep-going began; anything MacBook did after that is still there. Check
what already happened before you repeat it: fetch before pushing, never force-push, and check a
deploy's state before deploying again."

**Three states, shown separately.** Ownership, startup and running are read from three records and
never folded into one word:

| fact      | read from                                                | words                                                                |
| --------- | -------------------------------------------------------- | -------------------------------------------------------------------- |
| ownership | the `owned` row and epoch                                | "omarchy took this over at 14:10"                                    |
| startup   | the takeover transfer and its pending start              | "Getting the project ready" / "Couldn't start: <reason> · Try again" |
| running   | the continue message's fate (ADR 0191's turn-start rule) | "Running on omarchy since 14:11"                                     |

### 6. The laptop's resume barrier

The laptop may wake or restart into a thread the person took over. So whenever its daemon starts,
and on every wake from sleep, **nothing automatic runs for a kept thread until the standby
answers**:

- no queued message, owed carry-on message, recovery, automation or delegation result;
- no provider session opens;
- a tree frozen before sleep stays frozen.

The daemon learns of a wake from the helper's `did-wake`, or from the loop monitor's sleep record
when there is no helper. A dark wake starts nothing.

When the standby answers:

- **The thread is still the laptop's:** frozen processes are continued (`SIGCONT`), held work runs,
  and an interrupted turn gets ADR 0191's carry-on message.
- **It was taken over:** in one transaction the record goes `moved`, with `continuedOn`, as ADR
  0191's source does. Then, before anything else:
  - the tree is ended: every marked process is killed (`SIGKILL` for frozen ones, ordinary Stop
    and its close fallback for anything running), and its remote children get the cancel cascade;
  - the checkout as it is now is captured onto a local branch that is never pushed,
    `ace/kept/<thread>-<yyyymmdd-hhmm>`. The checkout itself stays as it is, and the laptop's
    native session files and transcript stay where they are;
  - the thread reads "Moved to omarchy at 14:10. The work MacBook did after 13:58 is on branch
    ace/kept/… here.", with **Open** and **Send to omarchy**. Send to omarchy sends that branch as a
    parcel to the thread's project there (ADR 0182) and tells the agent there; it never merges.

**While the standby can't be reached**, the thread waits: "Checking with omarchy before carrying
on." The person at the laptop may still type a message, which runs: they are the one person who
could have pressed Take over, and the line says "Couldn't check with omarchy whether it took this
over."

**Residual risk, plainly.** The barrier can't act earlier than the daemon can run:

- **A tree that wasn't frozen** thaws when the machine wakes, before the daemon's first look. That
  happens when there was no notice, a crash, or a dead battery that came back on power. Agent
  processes don't survive a power loss, but a laptop that slept on a notice ace never heard
  resumes with its agents running.
- **A takeover pressed while the laptop is still awake but cut off.** The laptop runs until it
  reconnects. That is the double run the person was warned of.

In both cases ace's own records end with one owner. Outside effects can escape: a push, a deploy,
a message sent from the laptop. The standby, starting from an older copy, may replay one the laptop
already made. ace can't fence systems it doesn't own. It says so in the confirmation and the
continue message, and it recommends that work kept going this way use effects that are idempotent
or fenced downstream: a push without force is refused when the branch moved, deploys with an
idempotency key or an expected version, tickets keyed by id.

### 7. Clones and restores

A copied home carries the same rows, pairing credentials and ADR 0115 device id. That includes a
VM clone at the same path and a backup restored to the same or another machine. Keep-going binds
participation to the host as well as the home:

- **Host identity from outside the home**, recorded on both rows:
  - macOS: `IOPlatformUUID`;
  - Linux: `/etc/machine-id`;
  - Windows: `MachineGuid`.

  A daemon whose host identity or home path differs from what its rows record never registers,
  generates, hands over or takes over on them. The thread reads "Kept by another copy of ace.
  Re-pair to keep going here." Re-pairing makes a new pairing and a new stream (ADR 0192's pins
  belong to one pairing).

- **One holder at a time.** Each runner start draws a holder nonce and registers it with the
  standby. A clone with the same host identity (a VM clone that kept its machine id) shows up the
  first time both copies talk to the standby: two holders on one stream. The standby then refuses
  both and marks the stream "Two copies of MacBook are running this. Re-pair to keep going." It
  refuses anything automatic from either until the person re-pairs.
- **`ACE_MAINTENANCE=1`** daemons take no part.

A cloned standby can no longer take a thread over by itself, which was the incident's risk. A
takeover needs a person pressing it on a client of that standby.

### 8. Bringing it back

By the person's **Bring it back**, never automatically on wake. It is ADR 0191's live move from the
thread on the standby to the laptop. It lands in the laptop's checkout through ADR 0101's landing
reuse, and any uncommitted work there goes onto an `ace/kept/` branch first. Keep-going stays on,
and the standby already holds generations, so no bulk is sent.

An automatic return is rejected. A laptop opened for a minute, or a dark wake, would stop a turn
running well on the server. The move would cost a transfer on whatever link the laptop woke on, and
it would flap with every lid. While the thread runs on the standby, it has no standby of its own.

### 9. Words

One sentence, text buttons, no icons on buttons (design-language.md, DESIGN.md). They live in
`@ace/ui-core`, so the iPhone shows them without Swift work in this stage.

| when                      | the line                                                                                  | buttons                                |
| ------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------- |
| opted in, ready           | Keeps going on omarchy if you leave.                                                      |                                        |
| no helper                 | Hands over when you quit ace. If this Mac sleeps, take over from your phone or omarchy.   |                                        |
| first copy going          | Getting omarchy ready · 312 MB of 1.2 GB                                                  |                                        |
| copy behind               | omarchy's copy is from 13:58.                                                             |                                        |
| handover without proof    | Didn't hand over to omarchy: the agent hadn't stopped yet.                                |                                        |
| quitting                  | Handing 2 threads to omarchy                                                              | Quit now                               |
| handed over               | Running on omarchy since 14:02.                                                           | Open · Bring it back                   |
| quiet (seen elsewhere)    | MacBook went quiet at 14:02 · omarchy's copy is from 13:58                                | Take over on omarchy                   |
| taking over               | omarchy took this over at 14:10 · Getting the project ready                               |                                        |
| couldn't start            | omarchy took this over but couldn't start it: <reason>                                    | Try again                              |
| laptop waiting after wake | Checking with omarchy before carrying on.                                                 |                                        |
| moved on reconnect        | Moved to omarchy at 14:10. The work MacBook did after 13:58 is on branch ace/kept/… here. | Open · Send to omarchy · Bring it back |
| clone                     | Kept by another copy of ace. Re-pair to keep going here.                                  |                                        |

### 10. Wire

These are calls on the transfer protocol (ADR 0192: every route, idempotent under their ids, never
parcels): `keep.register` (holder), `keep.beat` (batched per standby), `part=warm` (a generation),
`keep.handover`, `keep.takeOver` (person), `keep.status`. All but generation 1 fit ace's relay.
`TransferBegin.keepGoing` asks for a stream instead of a thread.

### 11. Costs and bounds

- **Idle threads cost nothing**: no beats, no generations.
- **Beats**: one call per standby every 30 seconds while a kept thread works, about 200 bytes.
- **Generations**: a capture walks the checkout's file stats, bounded by section 2's limits. A
  bundle is usually kilobytes and a summary a few kilobytes. On 3G (400 kbit/s) a typical
  generation takes well under a second.
- **The helper** runs only while a thread is kept, and the inhibitor is held only while one works.
- **The standby's disk**: one landing repository per project; the last two generations' refs per
  stream; worktrees only after a takeover or handover.
- **Startup** (ADR 0170): rows are found through the ownership table, which holds only kept,
  moving or moved threads; the barrier asks one `keep.status` per standby.

## Rejected

- **Automatic takeover after silence, under a lease** (the first draft of this ADR). The laptop
  stopped itself when it couldn't renew, and the server took over after the lease plus a margin.
  Its safety rested on every one of these holding:
  - the daemon never stalling past its deadline;
  - Stop's report meaning every process ended;
  - no process escaping the group;
  - clock rates staying within bounds through VM migration;
  - a sleep-counting clock in the shipped runtime (Bun 1.4.4's pauses on macOS);
  - the daemon acting before thawed children.

  Review showed each can fail, and any failure runs the thread twice without anyone choosing it.
  The owner chose instead: an automatic handover only with proof, and a person's takeover, with the
  risk said plainly, when the laptop goes quiet.

- **Just start the work on the server.** It already works (remote threads, `delegate` to a
  machine). But the choice has to be made before the work starts, and most work starts on the
  laptop, with its browser, simulator and local services. The decision to leave comes later and is
  often not a decision (the battery).
- **Comparing wall clocks across machines.** Skew and NTP jumps make it meaningless.
- **An arbiter in ace's cloud.** ace is never the place state lives (ADR 0002). A quorum of three
  of the person's own machines is more than most people have.
- **Keeping the Mac awake.** A closed lid overrides it, and it does nothing for a dead battery.
- **Native session tails in every generation**, for now (section 2).
- **Bringing it back automatically on wake** (section 8).
- **Electron's `powerMonitor`.** The daemon runs with no app (ADR 0186).
- **The screen helper as the power helper.** On a Mac it is installed only by the app, needs
  computer use's grants to be useful, and is versioned with the app, not the daemon.

## Follow-ups

- Windows: hand over on quit and low battery.
- Native session copies, once measured.
- Ignored files refreshed on the standby.
- Moving children with their parent.

## Review findings and how this revision answers them

1. **A stall past the window, a Stop that reports stopped without the processes ending, escaped
   processes, VM migration breaking rate bounds.** Mostly moot: silence never moves ownership, so
   no timer has to hold. For the planned path, proof is the processes ending, checked by pid with
   start time, the tree's mark and, on Linux, the cgroup (section 4). One residual remains: on a
   Mac without a cgroup, a process that strips its environment and leaves the tree.
2. **Clocks: the shipped Bun's `performance.now()` pauses in macOS sleep, and children thaw before
   timers.** The sleep-counting clock is moot: no timer moves ownership, and beats only choose
   words. Thawing is handled by freezing before an unproven sleep and by the resume barrier
   (section 6), with the residual risk and downstream advice stated. A test on the shipped binary
   through a real sleep checks the freeze and the barrier.
3. **Delayed park, pause or renewal replies racing; a new remote child escaping the arm check.**
   Moot: those messages are gone. What still needs ordering is generations, the handover and the
   takeover. Each carries stream, epoch, holder and generation, runs as a compare-and-set, and is
   written down before it is sent (section 3). Remote delegation needs no block: the handover needs
   their confirmation, and the takeover's words name them.
4. **Takeover convergence.** Resolved by section 5's single transaction (epoch, fixed generation,
   derived thread id, transfer row, pending start, receipt), then ADR 0191's recovery. Lost answers
   and repeated restarts are covered, and ownership, startup and running are shown separately.
5. **Clones: a VM clone at the same path or a restored home carries the same ids.** Resolved by the
   host identity outside the home, one holder per stream, and refusing an ambiguous restore until
   re-pairing (section 7).
6. **Sleep notices: no helper on a CLI install, a LaunchAgent needs a login session, logind's 5 s
   is shorter than Stop's 8 s.** Resolved by a power helper shipped and versioned with the daemon,
   checked in each context, with notices treated as best effort: no proof, no handover
   (section 4).
7. **Warm-copy cost, starvation, and the session overlap check.** Resolved by bounded Git
   checkpoints with summaries, fair oldest-first scheduling, generations pinned whole, and native
   tails deferred until measured (section 2).

## Verification

**Pure** (`transfers/keep/*-rules.ts` and their tests):

- the stream row's compare-and-set: a handover against a takeover, two takeovers, a stale epoch, an
  unregistered holder, a generation not newer than pinned;
- the derived thread id;
- the barrier's decisions on still-yours, taken-over and no-answer;
- the host check, and two holders on one stream;
- the scheduler's fairness: a quiet thread served while a busy one keeps capturing;
- proof's rules: a pid reused with another start time is not the same process, an unconfirmed
  remote child fails, Stop's report alone fails;
- the quiet words from the last beat.

**Two real daemons** over their pinned link, with real Git and scripted providers that start
background shells and a process that calls `setsid`. A fake power notifier stands in for the
helper, and a controllable proxy on every route can drop or hold traffic.

- **Injected faults:** a partition and a SIGKILL of each daemon at each step (generation 1, a
  generation half-written, the handover before and after `handing`, the takeover before and after
  its transaction, the setup, the start).
- **The overlap check:** every scripted process writes start and stop marks on one shared host
  clock. Every test asserts the two homes' marks for a thread overlap only in the cases this ADR
  names as a person's accepted risk.
- **Cases:**
  - a handover at the sleep notice with proof;
  - one whose proof didn't come in time (no handover, tree frozen, standby idle);
  - a final payload too late (a handover from the pinned generation);
  - low battery;
  - Quit ace completely, and Quit now;
  - silence with no takeover (the standby stays idle for hours);
  - a person's takeover with its answer lost and the command resent;
  - a takeover racing a late handover;
  - a takeover on two clients at once;
  - the standby restarting three times during setup;
  - the laptop waking into a takeover (frozen tree killed, branch kept, moved);
  - the laptop waking with the standby unreachable (held; a person's message runs);
  - a cloned home at the same path with the same machine id (two holders refused);
  - a restored home on another machine (refused until re-pairing);
  - a generation past 8 MiB on ace's relay;
  - twenty kept threads with one busy.
- **The split-brain test:** the laptop asleep with a frozen tree, the standby partitioned and taken
  over by the person, then the laptop woken still partitioned (nothing automatic runs, the tree
  stays frozen), then the partition lifted (the tree killed before it runs, an `ace/kept/` branch,
  moved).

**On the shipped binaries, through real sleep:**

- macOS lid close and `pmset sleepnow` with the helper started each way section 4 lists;
- Ubuntu, Fedora and Omarchy `systemctl suspend` and a lid close with the inhibitor;
- a frozen tree staying frozen across wake until the barrier answers;
- the env scan and the cgroup proof finding a `setsid` child;
- how long Wi-Fi stays up while the notice waits.

**Measured before native session copies or a shorter cadence**, using the slow-link harness
(#2038) and a large repository (ace's own and a 200,000-file one): the CPU and disk time per
capture, bytes per generation, standby disk per stream, battery on a laptop over a working day, and
recovery lag (from Take over to the continue message running, on 3G and on a LAN).
