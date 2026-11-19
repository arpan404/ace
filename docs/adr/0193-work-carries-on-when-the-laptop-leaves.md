# 0193: Work carries on when the laptop leaves

Date: 2026-11-18. Status: proposed (design; GPT review before the build). Decided by: the owner
(the outline, 2026-11-18/19), this ADR (how). Builds on
[ADR 0191](0191-continue-a-working-thread-on-another-machine.md) (live continue) and
[ADR 0192](0192-transfers-over-every-machine-route.md) (transfers over every route). Amends ADR
0191's ownership record.

## Context

A person works on a laptop. They close the lid, the battery dies, or the train leaves the Wi-Fi.
Today the agent stops with the laptop. ADR 0191 can move a working thread, but only when the
person asks and both machines can talk for the whole move. What the person wants is to say once,
"if I leave, keep this going on omarchy" (their server), and have it happen.

The hard part is not copying. ADR 0191 already copies code and the provider's native session and
switches over at one cutoff. The hard part is deciding, without talking, which machine runs the
thread. A laptop that sleeps or loses its link can't say it has stopped. A server that takes over
because it heard nothing may be wrong: the laptop may be awake, behind a broken route, still
running. Two agents then edit two checkouts of one task, push to one branch, and answer one
person twice. A daemon started on a copy of a live home has already done this once (the cloned
home incident, 2026-11-16). Split brain is the risk this ADR is built around. Priority 1 in
AGENTS.md decides every trade below: never two owners, never shown done while work runs.

## Decision

### 1. Opt in, per thread, with a project default

A thread runs on one machine (the **runner**) and names one other machine of the person's (the
**standby**). The person turns it on from the thread's menu: "Keep going on omarchy if I leave".
A project can set it as the default for its new threads (Settings › the project: "Keep new
threads going on omarchy if I leave"). It is a person's command (`thread.keepGoing`), never
offered to agents: it decides where work runs and what a machine may start.

It is offered only when all of these hold, checked at opt-in and again before each arm (section
3):

- the standby is linked to the runner with `operate` and `projects` allowed there (ADR 0101), and
  takes live transfers and leases (it answers `keepGoing: true` in `begin`, else
  `target_too_old`);
- the standby has a signed-in account for the thread's provider (else "omarchy has no Claude
  sign-in");
- the thread is a root thread. A child moves with its parent or not at all (ADR 0191,
  `thread_is_child`);
- the tree has no delegated work running on a third machine, or on the standby itself. Those
  children report to the runner; a takeover can't stop or adopt them. While they run, the thread
  isn't kept: "Not kept on omarchy while work runs on Studio."

### 2. A warm copy on the standby

**The first copy** is ADR 0191's bulk: code, branch and ignored files, sent while the agent works.
It goes only over a direct route or the person's own relay, never ace's hosted relay (ADR 0192's
8 MiB bound applies as it does to any bulk). Until it lands, the thread isn't kept: "Getting
omarchy ready · 312 MB of 1.2 GB".

**Each later copy** sends only what changed since the copy the standby acknowledged:

- **Code.** A capture commit of the checkout (`captureChanges`, the same temporary index ADR 0191
  uses, so the person's checkout and index are untouched) and an incremental bundle that excludes
  the last acknowledged capture and branch head. Usually a few kilobytes.
- **The native session.** Claude's and Codex's session files only grow, so a copy sends the bytes
  past the offset the standby holds, with the last 4 KiB before that offset to prove nothing
  before it changed. A file that shrank or whose proof differs is sent whole. The standby
  rewrites paths line by line as ADR 0191's carriers do, holding a partial last line back until
  its newline arrives. The 512-file and 256 MiB bounds of ADR 0191 apply; a session past them
  is not copied, and a takeover falls back to the handoff summary.
- **The thread** (title, mode, provider, model, a fresh `@ace/handoff` summary, the queue count):
  small JSON.
- **Ignored files** travel with the first copy only. The takeover's continue message says they
  are as of opting in.

One copy is one transfer part, `part=warm`, checked by SHA-256 like ADR 0191's `final`. ADR
0192's hosted-relay policy takes `warm` as it takes `final`: allowed on ace's relay up to
`HOSTED_RELAY_TRANSFER_BYTES` (8 MiB). A copy past that, when ace's relay is the only route, isn't
sent; the line shows how old the standby's copy is ("omarchy's copy is from 13:58") until a route
that can take it answers.

**When copies run.** At every end of the root's turn (with a park, section 3), and during a long
turn every 5 minutes if the capture differs from the last one, 10 minutes on battery. One copy
in flight per standby at a time, newest first; a copy waiting behind another is replaced by a
newer one of the same thread, never queued twice.

**The prepared landing.** The standby applies each copy as it arrives: the bundle into the
project's landing repository (shared by every kept thread of that project, ADR 0101's landing
reuse), the landing worktree checked out at the capture, the session tail into a staging folder
of ace's own. Nothing goes into the provider's home, and **no thread row exists on the standby**,
so nothing there can dispatch, recover or resume it: the engine has nothing to run. A copy that
doesn't apply makes the standby ask for a new bulk; until it lands the thread isn't kept.

### 3. The lease

Exactly one machine may run the thread. The runner may run it only while it holds a lease the
standby granted. Both sides keep their halves durably on the thread's ownership record (ADR
0191's `thread_ownership`, which said this stage adds its lease to the same row):

| state     | on      | meaning                                                                  |
| --------- | ------- | ------------------------------------------------------------------------ |
| `kept`    | runner  | owns the thread; a standby holds a landing; lease fields below           |
| `standby` | standby | doesn't own it; holds a landing; may take it over under section 3's rule |

`stopping`, `handing`, `moved` and `owned` keep ADR 0191's meanings. Both new rows carry the
transfer id of the copy stream, the peer, the `epoch`, and:

- `holder`: the runner daemon's run id (the per-run id in `daemon-lock`) the lease was granted
  to;
- `lease`: `parked`, `armed` or `fenced` (armed, and stopped for want of a renewal; held across restarts);
- `copy`: the sequence number of the last copy the standby applied;
- `home`: the stable device id (ADR 0115) and the home's path, on both sides (section 7).

The time a lease runs out is never stored as a clock value: the clocks below restart with the
machine. Wall times are stored only for the words a person reads.

#### The constants

| name                     | value  | meaning                                                             |
| ------------------------ | ------ | ------------------------------------------------------------------- |
| `LEASE_MS` (T)           | 180 s  | how long a granted lease lasts, counted by the runner from its send |
| `RENEW_EVERY_MS`         | 20 s   | how often an armed runner renews                                    |
| `FENCE_STOP_AT`          | T−70 s | the runner starts ace's ordinary Stop when no renewal answered      |
| `FENCE_CLOSE_AT`         | T−10 s | the Stop's close fallback is forced (ADR 0052's 8 s `PROCESS_STOP`) |
| `TAKEOVER_MARGIN_MS` (M) | 30 s   | the standby waits T + M after its last grant before taking over     |

So a laptop that vanishes is taken over about 3.5 minutes after its last renewal, and a laptop
whose link to the standby breaks keeps working for almost two minutes before it stops.

#### Clocks

No wall clock is ever compared across machines. Each side measures only its own intervals:

- **The runner** must count time it spent asleep. A clock that stops during sleep would let a
  laptop that slept past its lease think the lease still holds. It uses `continuousNow()`,
  injected: on macOS `performance.now()` (libuv reads `mach_continuous_time`, which counts sleep;
  `loop-monitor.ts` relies on the same), on Windows `performance.now()` (`QueryPerformanceCounter`
  counts standby and hibernation), on Linux the boot-time clock (`CLOCK_BOOTTIME`, read from
  `/proc/uptime`, which counts suspend; `performance.now()` there is `CLOCK_MONOTONIC`, which
  doesn't). A runner without such a clock isn't offered keep-going.
- **The standby** may use any monotonic clock that never runs fast: `performance.now()`. A
  standby that sleeps (a second laptop) and whose clock stops while it sleeps only counts less,
  so it takes over later. That is the safe side.

**Why it holds.** The runner sends a renewal at its time `s` and counts its lease from `s` once
the answer comes. The standby grants it at real time `g ≥ s` and counts from `g`. With clock
rates within ρ of true (crystals are within 10⁻⁴; the proof allows 10⁻³), the runner is fully
stopped by real time `s + T(1+ρ) ≤ g + 180.2 s`; the standby takes over no sooner than
`g + (T+M)/(1+ρ) ≥ g + 209.7 s`. The 29 s between them cover the close fallback's last seconds
and scheduling delay. A renewal whose answer is lost changes nothing: the runner counts from the
last renewal it saw answered, the standby from the last it granted, which is later.

#### The runner

```
off ─opt in─▶ readying ─bulk landed─▶ parked
parked ─turn starts, standby reachable─▶ arming ─granted─▶ armed
parked ─turn starts, standby unreachable─▶ (runs unkept; arms once a probe answers)
armed ─renewed─▶ armed            armed ─turn ends─▶ parking ─park answered─▶ parked
armed ─no answer by T−70 s─▶ fencing ─tree at rest─▶ fenced
fenced ─renewal granted─▶ armed (and the carry-on message is owed, then sent)
fenced ─answer: taken over─▶ moved (work kept, section 5)
armed or parking ─sleep notice─▶ leaving = handing (section 4)
```

- **Parked** means the thread is at rest, the copy of its end is applied on the standby, and the
  standby confirmed it won't take the thread over. A parked runner sends nothing, so an idle
  thread costs nothing.
- **Arming.** A turn of a kept thread starts at once; it never waits for the standby. The runner
  first sends `probe`, which changes nothing. If it answers, the runner sends `arm` (epoch,
  holder) and from that send on behaves as armed: renewing, and fencing if renewals stop. An
  `arm` whose answer is lost may have armed the standby, so it counts as armed. If the probe
  doesn't answer, the runner sends no `arm` and the turn runs unkept: the standby is parked and
  can't arm without hearing an `arm`, so it never takes over. The line says "Not kept on omarchy
  right now: can't reach it." and the runner arms as soon as a probe answers.
- **Parking.** At the end of the root's turn the runner sends the copy of that end and `park`.
  Until `park` is answered the runner stays armed (renewals carry `park` again). A thread at rest
  whose park can't be confirmed may still be taken over; that is correct, since the standby can't
  know the turn ended.
- **Fencing is ace's ordinary Stop**, the same command the person's Stop button sends
  (`thread.interrupt` with `cascade`, plus `stopThreadTerminals`, ADR 0191 section 2). The fence
  adds no stop machinery of its own. At `FENCE_CLOSE_AT` the Stop's close fallback is forced so the
  tree's process groups are signalled in time. The thread reads "Stopped: can't reach omarchy,
  which may carry this on. Waiting to reach it." It isn't done: its ownership row holds it
  (`fenced`), new turns are refused, and the queue waits.
- **Fenced, then reached again.** If the standby grants the renewal (it never took over), the
  runner is armed again and owes itself "The connection to omarchy dropped and ace stopped this
  to keep it from running twice. Carry on where you left off." That debt is ADR 0191's durable
  resume (`transfer_live_resume`), sent under its rules, but only on a full wake (section 4).
  If the standby answers that it took over, the runner moves (section 5).
- **A runner restart** never runs a kept thread on its old lease. Its agents died with the
  previous run, or are ended first: the build confirms the engine's startup sweep ends provider
  process groups a previous run left (pid and start time recorded at spawn), and adds that
  sweep if it doesn't. The new run then asks the standby to `reacquire` under its own run id,
  saying the previous run's tree is gone. The standby grants it if it hasn't taken over. A clean
  shutdown parks every armed thread it can before it exits.

#### The standby

```
preparing ─bulk applied─▶ parked ◀─park─ armed
parked ─arm─▶ armed ─renew─▶ armed (expiry = now + T + M)
armed ─expiry passed─▶ taking ─thread made─▶ owned (ADR 0191)
armed or parked ─commit (planned handover)─▶ owned
armed ─leave─▶ taking
```

- **Grants are serialized.** `arm`, `renew`, `park`, `reacquire`, `leave`, a commit and the
  takeover decision for one thread run one at a time, each in one transaction on its `standby`
  row. A renewal checks the epoch and the holder; a different holder is refused unless it is a
  `reacquire` from the same pairing. Expiry lives in memory on the standby's monotonic clock,
  reset to `now + T + M` for each grant.
- **A standby restart** resets the expiry of every armed row to `now + T + M`, as if a renewal
  had just come. It can't know when the last came; assuming now only delays a takeover.
- **A planned standby restart** (an update, `ace stop`) first sends `pause` to every armed runner
  it can reach: "I won't take over until you renew after I'm back." Its rows go `parked` in the
  same transaction as the send is recorded; a runner that got `pause` may run unkept until a probe
  answers again. A server update then never stops the laptop's work.
- **The takeover.** Once an armed row's expiry has passed, the standby, in one transaction, writes
  epoch + 1, makes the thread from the landing and records `owned` (ADR 0191's cutoff, run from
  the warm copy instead of a received commit). From then on every renewal under the old epoch is
  answered "taken over at 14:05, from the copy of 13:58" with the new thread's id. The thread then
  starts as ADR 0191 section 4 starts a moved one: session placed (or the handoff summary), one
  continue message, watched to its first turn, durable across restarts. The message says what is
  missing: "This thread moved here from MacBook when MacBook went offline at 14:02. The project
  here is as of 13:58; anything MacBook did after that is still on MacBook, and it will be kept
  there. Files Git ignores are as of when keep-going was turned on."
- **A commit that comes after a takeover** (a planned handover whose commit was delayed past the
  takeover) is refused as a handover. Its final delta is kept on the standby as a branch
  (`ace/kept/<thread>-<time>`) and the thread there is told: "MacBook's last changes came after
  the takeover; they are on branch ace/kept/… here."

#### Convergence

Every case ends with one owner, and at no moment do both machines run the thread:

| case                                          | runner                                               | standby                        | ends with                        |
| --------------------------------------------- | ---------------------------------------------------- | ------------------------------ | -------------------------------- |
| one renewal lost                              | renews next time                                     | armed                          | nothing seen                     |
| link down < 110 s                             | armed                                                | armed                          | nothing seen                     |
| link down 110 s to 210 s                      | fenced                                               | armed, renewed on return       | runner carries on (owed message) |
| link down > 210 s, laptop awake               | fenced by 180 s                                      | takes over at 210 s            | standby; runner moved, work kept |
| laptop sleeps or dies without a handover      | asleep, or fenced on wake by its own clock           | takes over at 210 s            | standby; runner moved, work kept |
| runner daemon crashes                         | new run sweeps, `reacquire`s                         | grants, or took over           | whichever came first             |
| standby crashes                               | fenced if down > 110 s, armed on return              | expiry reset at start          | runner carries on                |
| standby updates (planned)                     | gets `pause`, runs unkept                            | parked across the restart      | runner, kept again after a probe |
| partition during a planned handover           | `handing` (ADR 0191: asks status, never resumes)     | commit or takeover, first wins | one owner; a late delta kept     |
| both partitioned, lease expires, laptop wakes | continuous clock says expired: fenced, refuses turns | took over                      | standby; runner moved on contact |
| laptop wakes, still partitioned for hours     | fenced, waiting, never runs                          | took over (or not)             | settles on contact               |

**The thaw window.** A tree that was still running when the laptop slept thaws when it wakes,
for the moment before the daemon's first timer runs and fences it. Section 4 exists so that
doesn't happen: the runner always stops its tree before it lets the machine sleep. The window is
left only when no sleep notice arrived (no helper, a helper that died, a forced shutdown that
skipped notices). ace then records it and the moved thread says "MacBook slept without handing
over; the agent may have run for a moment after it woke." ace's own state still has one owner;
what can escape in that moment is a side effect outside ace (a push, an API call).

**Process-group escapees** (ADR 0191's known gap) are not ended by the fence, as they are not by
Stop.

### 4. The sleep notice: hand over before the machine sleeps

The runner listens for the system's notice that it is about to sleep, and only while at least one
kept thread of this machine is armed or parking. When it comes, the daemon runs **leave** for each
of them in parallel, within the time the system allows, then lets the system sleep:

1. **Stop**, with ace's ordinary Stop; its close fallback is forced at half the budget.
2. **Hand over through ADR 0191's live path**, once the tree is at rest: capture the final delta
   against the last warm copy (small: the copy is warm), write `handing`, send the commit. The
   standby lands it on top of the landing and owns the thread. The runner reads "Running on
   omarchy since 14:02."
3. **If the commit can't be sent in time**, send `leave` instead: "I'm stopped and at rest; take
   over from your last copy." `leave` is written to the record as `handing` before it is sent,
   so, like a commit, the runner never resumes on its own after sending it. The standby takes
   over at once instead of waiting out the lease, missing only what changed since the last copy.
4. **When the budget ends** in whichever state the leave reached, the machine is let sleep. A
   tree that came to rest but sent nothing stays `fenced`, armed: the standby takes over at
   expiry if the laptop stays away, and the laptop carries on if it comes back first.

The tree is stopped before every sleep, whatever happened to the handover.

**A full wake, not a dark wake.** A Mac with its lid closed wakes briefly about once a minute
(DarkWake); a daemon timer runs then. A kept thread never restarts and an owed carry-on message is
never sent on a dark wake, only after a full wake (display on), so it doesn't start a turn just as
the machine goes back to sleep.

**macOS.** The daemon must hear the notice with no app open (ADR 0186), so Electron's
`powerMonitor` can't be the source. The screen helper gains a mode, `ace-screen-helper --power`,
started by the daemon only while a kept thread is armed. It calls `IORegisterForSystemPower`,
runs its run loop, and speaks line-delimited JSON on stdin and stdout: `will-sleep {id}`, which
the daemon answers with `allow {id}` (`IOAllowPowerChange`); `can-sleep {id}` (idle sleep), allowed
at once and never cancelled; `did-wake {full}`, with full told from dark by the system's power
capabilities; and the power source, for the copy cadence. The system waits for the answer up to
about 30 seconds (Apple's QA1340); ace uses at most 20 seconds and answers sooner when the leaves
are done. A daemon started by the CLI or the login service, with no `ACE_SCREEN_HELPER`, runs the
copy the app last installed under the home (`installScreenHelper`); with none at all,
keep-going is offered with the line "Only hands over when this Mac goes offline for a while" and
works by the lease alone.

**Linux** (Ubuntu, Fedora, Debian, Omarchy: all systemd-logind). `ace-screen-helper-linux
--power`, through its existing `zbus`, takes a delay inhibitor (`Inhibit("sleep", "ace", "Handing
work to omarchy", "delay")`) only while a kept thread is armed, listens for
`PrepareForSleep(true)`, and closes the inhibitor's file descriptor when the daemon says `allow`.
It reads the allowed delay from logind's `InhibitDelayMaxUSec` (5 s by default) and leaves one
second spare. Five seconds is enough to stop and send `leave`; the final delta goes when the link
is quick. ace never changes logind's setting; the person may raise `InhibitDelayMaxSec` and ace
uses what's there. A delay inhibitor needs no administrator under logind's default polkit policy,
to be confirmed on each distribution (a live check owed). The helper takes a new inhibitor after
`PrepareForSleep(false)`.

**Windows** is deferred. A process gets `PBT_APMSUSPEND` with about two seconds and can't delay
sleep; on Modern Standby desktop processes are suspended without a usable notice. Windows gets the
lease alone, which is correct because its runner clock counts standby. Its planned handover is a
follow-up.

A lid closed with the machine kept awake (an external display, "Prevent sleep") sends no notice,
and nothing happens: the laptop is still there.

### 5. When the laptop comes back to a thread that moved

The runner learns on its first contact with the standby that the thread was taken over (the
answer to its renewal or `reacquire`). In one transaction its record goes `moved` with
`continuedOn`, as ADR 0191's source does. Then, before anything else touches the checkout:

- **Its work since the last copy is kept.** The checkout as it is now is captured
  (`captureChanges`, the checkout untouched) onto a real branch,
  `ace/kept/<thread>-<yyyymmdd-hhmm>`, local and never pushed. The checkout itself stays as it is.
  The native session files on the laptop are left in place, and the thread's own transcript there
  stays readable.
- **The person is told** on the thread: "Running on omarchy since 14:05. MacBook went offline;
  the work it did after 13:58 is on branch ace/kept/… here." with **Open** and **Send to
  omarchy**. Send to omarchy sends that branch as a parcel to the thread's project there (ADR 0182) and tells the agent there it exists; it never merges.

### 6. Bringing it back

**By the person's "Bring it back"**, never by itself on wake. It is ADR 0191's live move in the
other direction, from the thread on the standby to the laptop, landing in the laptop's checkout
(ADR 0101's landing reuse: only the delta travels, since the laptop has the objects). Any
uncommitted work in that checkout is first captured onto an `ace/kept/` branch, so nothing is
overwritten without a trace. Keep-going stays on: after the move back the laptop is the runner
again and the standby already holds a landing, so no bulk is sent.

Automatic return on wake is rejected. A laptop opened for a minute (a calendar check, a dark
wake) would stop a turn running well on the server, the move costs a transfer on whatever link the
laptop woke on (often 3G), and the two would flap with every lid. The person sees the line when
they come back and chooses. While it runs on the standby, the thread there has no standby of its
own; a server is expected to stay up.

### 7. Clones of a home

A copy of a home carries the same pairing credentials, so a peer can't tell it from the original
by its credential. Both new rows record the home they were made in: the stable device id (ADR 0115) and the home's path. A daemon whose own differ (a home copied to another folder, restored
to another machine, or started with `ACE_MAINTENANCE=1`) never arms, renews, reacquires or takes
over on those rows: it shows them as "Kept by another copy of ace" and does nothing. That covers
both sides: a cloned standby can't take a thread over and start the agent on the real CLIs, and a
cloned laptop can't take the lease from the real one.

### 8. Words

One sentence, text buttons, no icons on buttons (design-language.md, DESIGN.md). In `@ace/ui-core`,
so the iPhone shows the same words without Swift work in this stage.

| when                        | the line                                                                       | buttons                                |
| --------------------------- | ------------------------------------------------------------------------------ | -------------------------------------- |
| opted in, ready             | Keeps going on omarchy if you leave.                                           |                                        |
| first copy going            | Getting omarchy ready · 312 MB of 1.2 GB                                       |                                        |
| copy behind                 | omarchy's copy is from 13:58.                                                  |                                        |
| standby unreachable, unkept | Not kept on omarchy right now: can't reach it.                                 |                                        |
| fenced                      | Stopped: can't reach omarchy, which may carry this on. Waiting to reach it.    |                                        |
| handed over or taken over   | Running on omarchy since 14:02.                                                | Open · Bring it back                   |
| taken over, work kept       | Running on omarchy since 14:05. Work after 13:58 is on branch ace/kept/… here. | Open · Send to omarchy · Bring it back |
| bringing it back            | Bringing it back from omarchy                                                  |                                        |
| not offered                 | Not kept on omarchy while work runs on Studio.                                 |                                        |

The thread's status reads `{ state: "moved", to }` as in ADR 0191 while it runs on the standby,
and `fenced` reads as stopped and waiting, never done.

### 9. Wire

New machine calls on the transfer protocol (ADR 0192: every route, idempotent under their ids,
never parcels): `keep.probe`, `keep.arm`, `keep.renew` (batched: one call carries every armed
thread for that standby, answered per thread), `keep.park`, `keep.reacquire`, `keep.leave`,
`keep.pause`, and `part=warm`. All are small enough for ace's relay. `TransferBegin.keepGoing`
asks for a standby landing instead of a thread.

### 10. Costs and bounds

- **Idle threads cost nothing**: parked runners send nothing.
- **Renewals**: one batched call per standby every 20 s while any kept thread works, about 300
  bytes plus 80 per thread. On 3G (400 kbit/s) that is well under a second of airtime a minute.
- **Copies**: a turn's end usually carries a few kilobytes of code and 10 to 500 kB of session
  tail; on 3G a 500 kB copy takes about 10 s, in the background. The capture walks the checkout's
  file stats as ADR 0191's does; on battery the in-turn copy runs half as often.
- **The sleep notice** costs nothing unless a kept thread is armed: the helper runs only then, and
  the Linux inhibitor is held only then.
- **Many threads**: renewals stay one call per standby; copies go one at a time per standby,
  newest first, coalesced per thread, so a slow link makes copies older, never more numerous. The
  line says how old. The standby keeps one worktree per kept thread in one landing repository per
  project, removed when keep-going is turned off or the thread is settled.
- **Nothing is history-sized at startup** (ADR 0170): the runner and standby find their rows
  through the ownership table, which holds only threads that are kept, moving or moved.

## Rejected

- **Just start the work on the server.** It already works (remote threads, `delegate` with a
  machine). But the choice has to be made before the work starts, and most work starts on the
  laptop because that is where the person is, with its browser, simulator and local services.
  The decision to leave comes later and is often not a decision at all (the battery). This keeps
  the laptop as the place to work and the server as insurance.
- **Comparing wall clocks across machines.** Skew and NTP jumps would let both run.
- **Taking over on silence without a lease the runner fences on.** A partition with an awake
  laptop runs the thread twice.
- **An arbiter in ace's cloud.** ace is never the place state lives (ADR 0002), and a lock server
  that is down would stop everyone's work. Three of the person's own machines could form a
  quorum; that is more than two-machine people need now.
- **Keeping the Mac awake instead.** A closed lid overrides it, and it does nothing for a dead
  battery or a lost link.
- **Freezing the tree (SIGSTOP) at the sleep notice.** Instant and reversible, but it is a stop
  path of the move's own, which ADR 0191's owner amendment ruled out, and a frozen CLI's provider
  stream breaks during sleep anyway. Worth looking at again only if Linux's five seconds prove too
  short to stop.
- **Bringing it back automatically on wake** (section 6).
- **Electron's `powerMonitor`.** The daemon runs with no app (ADR 0186).
- **`systemd-inhibit` and `gdbus monitor` as child processes.** Two processes to parse and keep in
  step; the Linux helper already speaks D-Bus.

## Follow-ups

- Windows planned handover.
- Handing over on low battery before the system forces sleep.
- Keeping children on other machines across a takeover.
- Refreshing ignored files on the standby.

## Verification

**Pure, with injected clocks** (`transfers/keep/lease-rules.ts` and its tests): the runner's
deadline from the last answered send and the standby's expiry from its last grant, with drift at
±10⁻³ never letting the standby's takeover come before the runner's stop; a lost answer counted
on both sides; the standby's restart resetting expiry; epoch and holder refusals, `reacquire`
from the same pairing; an `arm` with no answer counted as armed; a run with no `arm` sent never
taken over; `park` unconfirmed staying armed; `leave` and the commit both meaning `handing` on the
runner; a commit after a takeover kept as a branch; a home or device mismatch refusing every
lease action; full and dark wakes.

**Two real daemons** over their pinned link, with real Git and scripted providers, a fake sleep
notifier in place of the helper, a fake continuous clock for the runner, and a controllable proxy
on every route that can drop or hold traffic. A partition is injected at each step (bulk, each
copy, arm, renew, park, leave, commit, takeover) and a SIGKILL of each daemon at each step. Each
scripted provider writes a start and stop mark per run on one shared host clock, and every test
asserts that no two marks of one thread overlap across the two homes. Cases: a planned handover
in budget; one where only `leave` fits; one where nothing is sent; the link down for 100 s, 150 s
and 300 s; a laptop asleep past expiry; a server update with `pause`; the runner's restart and
`reacquire`; a cloned home on either side doing nothing; the hosted relay refusing a copy past 8
MiB; twenty kept threads renewing as one call. **The split-brain test**: both sides partitioned,
the runner's clock advanced past the lease as if it slept, the standby taking over, the runner
woken while still partitioned (it refuses turns and runs nothing), then the partition lifted (it
reads moved, its changes on an `ace/kept/` branch, nothing lost).

**Live checks owed** on real hardware: macOS lid close and `pmset sleepnow` with the helper
answering within 20 s, and how long Wi-Fi stays up during the wait; DarkWake ticks reading as
dark; `systemctl suspend` and a lid close on Ubuntu, Fedora and Omarchy with the inhibitor and
its polkit default; Claude and Codex resuming from a warm session copy.
