# 0191: Continue a working thread on another machine

Date: 2026-11-18. Status: accepted. Decided by: the owner (the design, 2026-11-18), the build of
this ADR's PR (how). Amends [ADR 0101](0101-work-on-another-machine.md), "Continuing a thread".

## Context

ADR 0101's Continue on refuses a thread whose tree is still working, and the new thread there
starts idle, seeded with a bounded `@ace/handoff` summary. The person has to wait for the agent to
finish, move the work, then explain again what to do next. What people want is to pick up the
laptop and have the agent keep going on the desktop, with everything it knew. A later stage
(closing the lid and the work carries on on a server) needs the same pieces: a switch-over that
never runs a thread twice or loses it, a copy of the provider's own session, and a record of which
machine owns a thread.

## Decision

Continue on (`thread.continueOn`) and the agents' `transfer` tool with `thread: "self"` take a
working thread. ADR 0101's path still runs for an idle thread; a working one takes the live path
below. Both start the same way, so the person sees one action.

### 1. Copy the bulk while the agent works

The transfer's code, branch and ignored files are prepared and uploaded as ADR 0101 describes,
while the source agent keeps running. Nothing on the source is stopped yet. The strip reads
"Getting Studio ready · 312 MB of 1.2 GB". A live transfer names itself in `begin` (`live: true`);
a target that can take one answers `live: true` with a `finalOffset`. A target that doesn't (an
older ace) fails the transfer with `target_too_old` before anything on the source stops, so the
agent keeps working.

### 2. Stop at a safe point, then send only what changed

Once the target holds the bulk, the source marks the thread `stopping` in its ownership record
(below), which refuses new turns, then waits for a safe point (`live/safe-point.ts`, pure):

- the turn has ended on its own (a turn boundary): nothing to interrupt;
- no tool call is running and no reply is streaming (between tool calls): interrupt now;
- otherwise wait, and interrupt anyway after 90 seconds, so a long tool call can't hold the
  move forever.

The interrupt is the engine's own `thread.interrupt` of the root agent, which each provider
adapter carries out with its own interrupt.

**The fence.** From `stopping` on, nothing new runs here, at any of the three places work can
start: admission refuses new turns, the engine's dispatch holds sends, recoveries and steers
already queued, and no provider session opens for the thread. The open checks the ownership
record again right before the provider starts and once more when it has opened (a session that
opened after the fence is closed at once); a send that meets the fence there goes back to the
queue, held. Only teardown controls (`thread.interrupt`, `thread.archive`) still run; any other
control (a goal, a model, a permission change, an answer) waits. A fenced thread holds no engine
slot and is left out of the threads picked to run, so held work never blocks other threads at
the active-thread limit. The fence covers the whole tree here: the thread's subagents at any
depth are fenced with it (`thread_fence`, by the root's ownership record) from the moment the
move starts stopping, so none of them starts anything meanwhile. When a move fails before the
hand-over the fence lifts for the whole tree and each thread is woken, given a slot first, so
what was held dispatches then through normal scheduling. A fence that lands while a provider is
opening isn't an open failure: the open ends, nothing is reported, and the send goes back to
the queue, held.

A message queued behind the working turn is not given to the provider while the root works, so
the move's interrupt, a root Stop, leaves it queued: a Stop fails only resumes, limits and merges
waiting to run, and inputs already in the interrupted turn.

**The invariant before the final snapshot.** Every provider process of the thread's tree here
(the thread and its subagents at any depth, settled ones with a warm session included, and any
still opening) has exited, as the engine's own process set says (`withProcess`: attached,
opening or closing), within one deadline of 40 seconds:

1. Every live subagent is interrupted (its own `thread.interrupt`, with cascade) and waited on
   until its turn ends, until the last 10 seconds of the deadline.
2. Every provider of the tree is closed (`closeProvider`). That ends an open still waiting for
   its handshake (its lifetime is the spawned process's) and waits for it to settle, waits for a
   close already in flight, and closes an attached session; it is not the deletion stop, so
   nothing pending is retired and queued messages stay held.
3. The process set is checked for every thread of the tree. Anything still there when the
   deadline passes fails the move before the hand-over (`process_still_running`), with the
   agent told to carry on here. No snapshot is taken while anything still writes, and a close
   that never returns can't hang the move.

Only then is the final snapshot taken. Then it captures what changed since the bulk:

- **Git methods.** A second capture commit of the checkout as it is now, and an incremental
  bundle of the branch and that commit, excluding the bulk's branch head and capture commit. It is
  usually a few kilobytes. The commit says what the bulk itself carried (`live.bulk`: its branch,
  head and capture), and the target reads the bulk by exactly that, never by the checkout at the
  stop: a checkout that was detached when the bulk left and on a new branch at the stop is read by
  the bulk's pinned head, and the branch comes from the delta.
- **A plain folder (archive).** A folder has no cheap diff, so its archive is packed after the
  stop instead of before. Plain folders are usually small; the strip says "Stopping at a safe
  point" for that time.
- **Ignored files** travel with the bulk only. An agent that edits `.env` after the bulk began
  leaves that edit behind; the handoff says the ignored files are as of the start.

These travel as one small final payload (`part=final`), a folder archive holding `delta.bundle`
and the provider's session files (below), checked by SHA-256 like the others. One payload, not
two, keeps the commit to one digest, one offset and one cleanup.

### 3. The provider's own session goes too

The agent keeps its full history when its provider allows it. One small interface,
`SessionCarrier` (`transfers/sessions/`), has one implementation per provider:

- `capture(home, nativeSessionId, sourceCwd)` lists the session's files, read from the
  provider's home of the thread's account, never anything else in it;
- `place(home, files, sourceCwd, targetCwd)` writes them into the target account's home, with
  the folder paths rewritten to the landed checkout, and says how the session continues there.

| Provider                         | Carried                                                                        | What is rewritten                                                                    | How it continues                                      |
| -------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Claude Code                      | `projects/<folder>/<id>.jsonl` and its `subagents/`                            | the `cwd` of every record; the file moves under the target folder's `projects/` name | resume by id                                          |
| Codex                            | the rollout and the rollouts it forks from (`sessions/…/rollout-…-<id>.jsonl`) | `session_meta.payload.cwd` and `turn_context.payload.cwd`                            | fork from the end, as an account copy does (ADR 0018) |
| OpenCode, Pi, Cursor, ACP agents | nothing                                                                        |                                                                                      | the handoff summary                                   |

The lineage rules are `@ace/accounts`' account-copy plans (`claudePlan`, `codexPlan`), shared,
not repeated. Lines are decoded leniently: a line that isn't JSON, or a record of a type the
rewrite doesn't know, is kept byte for byte. Only a path equal to the source folder, or inside
it, is rewritten; text the agent wrote that mentions the old folder stays as it was, and the
continue message names the new one. Compressed Codex rollouts, a session with more than 512
files or 256 MiB, a Claude folder name longer than its 200-character limit, and a home the
thread's account doesn't have are not carried.

Session files are provider data, never credentials (ADR 0002). Only the session's own files are
read; auth files (`auth.json`, `.credentials.json`, keychain entries) are never opened, and a
listed file named like one is refused. The target writes only inside the chosen account's home,
through `@ace/files`' descriptor-safe merge, never over a file that is already there.

On the target the new thread uses the account its provider would pick for a new thread there.
Any failure (nothing to carry, capture, copy, placing, the resume itself) falls back to ADR
0101's handoff summary. The new thread's continue message and the transfer's result say which
happened: `session: "native"` or `"summary"`, with the reason.

### 4. Switch over atomically

The commit carries the thread (title, mode, provider, model, the handoff as fallback, the
carried session) and a short continue message. The target:

1. lands the code as ADR 0101 does, applying `delta.bundle` after the bulk;
2. passes the cutoff and makes the thread (ADR 0101), recording in the same transaction that it
   now owns the thread (`owned`, below);
3. places the session; on failure, adopts the handoff instead;
4. sends the continue message itself: "This thread moved here from MacBook while you were
   working. Carry on where you left off. The project is now at <path>." with what stayed behind
   (section 5);
5. watches the turn start (`live/turn-start.ts`, pure): working, waiting or needing the person is
   running; a message still waiting in the queue is not. A resumed native session that fails to
   open is retried once with the handoff instead. A turn that still fails is shown failed there,
   where the person can act on it;
6. records `running` on the transfer row. Status then answers `completed` with `live.running`.

The start is durable (`transfer_live_start`, `live/target-rows.ts`). When the engine refuses the
continue message for now (it is full, starting, or out of slots), the start is tried again,
waiting 1 second, then 2, doubling up to a minute, about half an hour in all, the backoff kept
across restarts. Each attempt is a command of its own id, so the receipt of a refusal never
answers the next try; the durable attempt count keeps a send that went through from being sent
twice after a restart. After that the start is final: `running: false`, a line on the thread there
says it couldn't start and that a message carries it on, and the sender is answered, so the
source moves (the target owns the thread from its cutoff). A thread deleted there meanwhile is
final at once. Starts still pending are listed in a table of their own
(`transfer_live_pending`), so finding them never reads finished ones (ADR 0170), and a restart
drains it in batches of 64, a turn of the event loop between them, until none are left.
Retention never drops a transfer whose start is still pending, however long the target was
down, so the start can always be rebuilt from its row. A start waits for its transfer's setup
(the handoff and the link back) to finish. A setup that keeps failing past the cutoff, or a start
that keeps throwing, is tried again in the background without a restart (1 second, doubling to
a minute, 8 tries); then the transfer completes without it and the start is recorded as not
started, said on the thread there, so the sender is answered and moves on.

Recovery and retention on the target read side tables kept in step with every write to a
transfer's row, never the transfers table itself (ADR 0170): `transfer_incoming_open` lists
transfers still receiving, cloning or importing and settled ones with a rollback left to finish;
`transfer_incoming_expiry` lists the others with the time retention counts from, indexed when
it is made. Each read starts from the side table and reaches the row by its key. A home whose
rows predate the side tables is indexed once, in pages of the primary key with a turn of the
event loop between them, before recovery reads them; never at open. Its progress is kept with
each page it writes (`transfer_incoming_index_progress`), so a restart carries on where it
stopped. Recovery on each side drains every batch to the end, and the sending side's recovery
never waits on the receiving side's. A payload file is removed at startup only once its own
transfer's row says it is settled or gone, never from a list that could be cut short.

**The receipt.** The same row is the receipt of the transfer: it keeps the sending device, the
method and the result, and retention never drops it. The transfer's own row is swept a day after
it settles; any call about a transfer whose row is gone (begin, status, commit, cancel) is
answered from its receipt for the device that sent it. So a sender whose answer was lost, and
that asks again a day later, is told the same thread, and nothing lands twice.

The source keeps the thread working (its ownership record `handing` holds it open as a
background row "Moving to Studio") until the target answers. Then, in one transaction, the
ownership record becomes `moved`, `continuedOn` is set, and the thread's state takes
`movedTo`, so its status reads `{ state: "moved", to }`: "Moved to Studio". It is not done and not
settled; its row and Open lead to the new thread. A moved thread refuses new turns with
`thread_moved` and a detail naming the machine.

#### Ownership record

`thread_ownership` (`transfers/ownership.ts`) holds one row per thread whose owner isn't simply
this machine:

| state      | on     | meaning                                                               |
| ---------- | ------ | --------------------------------------------------------------------- |
| `stopping` | source | finding a safe point; new turns refused; may still resume here        |
| `handing`  | source | the commit may have reached the target; never resumes here on its own |
| `moved`    | source | the target owns it                                                    |
| `owned`    | target | this machine owns it, moved here from `peer`                          |

Each row has the transfer id, the peer machine and thread, an `epoch` that grows with every
handover of the thread, and when it changed. No row means this machine owns its thread. The lid-
close stage adds a lease (a renew time and a holder) to the same row.

#### Converging after restarts and lost links

The target's cutoff is the single point where ownership changes. Exactly one machine owns the
thread at every moment:

- **Before `handing`** nothing was committed, so the target can't own it. A failure, a cancel, a
  lost link or a refused begin returns the source to running: the record goes, and if the turn
  was interrupted the source owes itself "Moving to Studio didn't work: <reason>. Carry on
  where you left off." That message is owed durably (`transfer_live_resume`) and sent until it
  goes, under a fresh command id per attempt: a full engine refuses it now and takes it once a
  slot frees, and a restart keeps owing it. It is dropped once the thread carries on by itself.
  A source restart in `stopping` carries the cutover on from there.
- **`handing` is written before the commit is sent.** From then on the source never resumes on
  its own: the commit may have landed. It asks status until the target answers. `completed` (the
  target owns it) moves the source; `failed`, `cancelled` or "no such transfer" resume the
  source. "No such transfer" means the target never passed its cutoff: past it, the receipt
  answers. A lost link or a target that is off is waited for without
  the one-hour limit ADR 0101 sets for other transfers; the strip says "Waiting for Studio to
  answer". The thread stays working meanwhile, never done.
- **A target restart** before the cutoff undoes the import and runs it again (ADR 0101); after
  it, the thread exists and the target finishes setting it up and starting its turn, keyed so it
  runs once.
- **A source restart** in `handing` reads the record, keeps refusing turns, and asks status again.
- **The ownership record is the authority.** `handing` on the ownership record and on the
  transfer's row are written in one transaction. A row found saying `stopping` while the record
  says `handing` (or `moved`) is read as handed over and brought up to it before the transfer is
  driven again, so a long outage after it never gives the thread back on the source's own say.

Cancel works until `handing`; after it, Cancel answers `too_late`, as ADR 0101's does past the
cutoff. Giving up on a target that never comes back needs the lease of the lid-close stage; until
then the source waits.

### 5. What can't move

- **Background shells and open terminals** of the thread are stopped after the interrupt. The
  continue message lists them by title ("Stopped here: dev server (npm run dev)"), so the agent
  there can start them again.
- **Children running on this machine**, at any depth, are fenced, stopped and listed, and their
  processes are among those the invariant above waits for. Moving them is out of scope for this
  stage.
- **Children delegated to other machines** keep running. Their parent link can't be repointed
  yet: their results wait undelivered on the moved thread, which holds them and runs nothing. They
  are listed in the continue message, and repointing them to the new parent is a follow-up.
- **A delegated child** (a thread with a parent) can't be continued live: it moves with its
  parent or not at all. It is refused with `thread_is_child`.
- **Queued messages** stay held on the source, never sent there and never failed; the continue
  message says how many. A moved thread reads moved with them still in its queue.

### 6. Agents

`transfer` with `thread: "self"` takes the same path. The agent's call returns at once; the
agent's own turn is the work being moved, so it is the turn that is interrupted at the safe
point. The result is not delivered to the source (it no longer runs); the target's continue
message is the result.

### 7. Wire

- `TransferBegin.live`, `IncomingTransfer.live` (`{ finalOffset, running? }`),
  `TransferCommit.final` and `TransferCommit.live` (continue message, carried session facts).
- `Transfer.live`: `{ stage: "readying" | "stopping" | "handing" | "moved" | "resumed", session? }`.
- `ThreadStatus` gains `{ state: "moved", to: { hostId, name, threadId } }`.
- `@ace/ui-core` words for each stage and for the moved status; the iPhone uses the same through
  ui-core. No Swift work in this stage.

## Rejected

- **Stop first, then copy everything.** The agent would wait the whole upload; on a large
  repository that is minutes of nothing.
- **Run both until the target catches up.** Two agents editing two checkouts of one task can't be
  merged afterwards.
- **A summary only.** The agent loses its tool results and its reasoning; the owner wanted the
  full conversation where the provider allows it.
- **Rewriting every mention of the old folder in session text.** It would change what the agent
  and the person wrote; only structural `cwd` fields are paths ace knows the meaning of.

## Follow-ups

- Repointing remote children to the new parent.
- The lid-close stage: a lease on the ownership record, renewed by the owner, so a server can
  take over a thread whose laptop went to sleep, and the source can give up on a target that
  never answers.
- Native session carriers for OpenCode and Pi once their formats are verified.

## Verification

Unit tests: the safe-point rule, the cutover's stage machine (each failure before and after
`handing`, each restart point), the turn-start rule, the ownership record's transitions (one owner
at every step, a stale epoch refused), the Claude and Codex carriers against fixture homes (paths
rewritten, unknown lines kept, auth files never read, oversized and compressed sessions refused),
the target's start (native session, summary fallback, a refused send retried, a start that gives
up, the receipt, pending starts past one batch), the source's stop (a subagent waited on, or
closed after 30 seconds, before the snapshot; a process that never exits failing the move),
closing a provider (a close in flight waited for; one that never ends refused), retention
keeping a pending start, recovery's reads planned without a scan of the transfers table, and
the ui-core words. End to end, two daemons
over their pinned link with real Git and scripted providers: a working thread moved with late
changes; a finished turn with a build running; a restart while handing; a lost link; a failure
before the hand-over; a message queued before the stop held through the move; a detached bulk
with a branch made before the stop; a lost answer after retention dropped the target's row; a
crash between the hand-over's two writes followed by an outage longer than the retry limit; a
follow-up queued behind the working turn kept through the move's interrupt; a moved thread's
first turn refused by a full engine through real command receipts, then started once a slot
freed; a session that finished opening after the fence, its input still queued and its provider
closed; a moved thread with held work leaving its slot to other threads at the active-thread
limit; a failed move's resume refused while another thread held the only slot, then sent once
it freed. Unit tests also cover an opening provider ended and waited for, a grandchild's
process in the tree's deadline, the durable resume across a restart, a target's setup and start
given up on and answered, indexing carried on after a restart, and recovery past one batch on
both sides with every live payload kept.
Live checks owed, because no real CLI ran: Claude resuming a session
placed under a new folder name; Codex forking from a copied rollout whose `cwd` changed; the
interrupt landing between tool calls for each provider; a resume failure reading as `failed` on
the new thread.
