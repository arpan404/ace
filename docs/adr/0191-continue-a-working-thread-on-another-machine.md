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

### 2. Stop with ace's own Stop, then send only what changed

Amended 2026-11-19 (the owner, after four review rounds found holes in a stop path of the move's
own): the move builds no stop machinery. Once the target holds the bulk, the source:

1. **Stops the tree with ace's own Stop.** The same command the person's Stop button sends,
   `thread.interrupt` with `cascade` on the root, through the same command policy. Every agent
   of the tree stops: the root by its provider's own interrupt (or its session closed when the
   provider doesn't answer, ADR 0052), every delegated child here and on other machines by the
   cancellation cascade, which also sets the delegation fence and retires their queued delegated
   input. The move always sends it, even for a thread already at rest, so a shell its last turn
   left running stops too; only a thread that was working is owed the message to carry on if the
   move then fails.
2. **Stops the tree's terminals** with the same call settling a thread uses
   (`stopThreadTerminals` for the thread and every child it owns here). Their output stays
   readable. ace's Stop itself leaves terminals alone: they are the person's shells. Amended
   2026-11-19 (post-merge review): from the moment the move starts stopping, before the Stop is
   sent, no terminal opens for any thread of the tree (`holdTerminals` on the workspace, refused
   as `thread_moving`, checked at the open and again right before the shell spawns). It lifts
   when the stop ends: by then the ownership record holds the thread, or the move failed. The
   hold lives in memory; a stop run again after a restart takes it again.
3. **Waits until the tree reads at rest, with nothing of it still running.** Three things, read
   together on each look:
   - the normal status rules: the root's status, which folds in every child through its summary
     agents, reads done, new or failed once the move's own "Moving to" row is set aside
     (`atRest`, read on a copy through core's own reducer);
   - no background shell or monitor still running anywhere in the tree. A finished turn's build
     reads done by design (ADR 0116), so status alone never shows it ended. The list is the one
     the whole-thread Stop stops (`stoppableTasks`, `engine/stop-scope.ts`), read for the root
     and every child here;
   - every Stop in the tree finished (amended 2026-11-19, second review): no `thread.interrupt`
     still accepted and unfinished. A provider can report its turn ended while its interrupt
     call never answers; status then reads done while Stop still waits to close the session,
     and the close's outcome isn't known yet. The move waits for the Stop itself, so the check
     below reads the close's real outcome;
   - every provider close in the tree confirmed. Amended 2026-11-19 (post-merge review): when
     both the shell stop and the provider's close time out, ADR 0052's Stop still ends the
     session and the thread reads stopped, its shells `unknown`; that stays, so the person's
     Stop always settles. The provider's exit fact now says so (`process.exited` with
     `unconfirmed`, kept on `processExit` until a new session starts), and the move reads it as
     not stopped: the old process, and a shell under it, may still write. It fails the move
     before the hand-over (`process_unconfirmed`). A confirmed close ended the process group,
     shells included, so their `unknown` counts as ended;
   - no terminal of the tree open. One still open (opened before a restart, whose hold was
     lost) is stopped and the tree looked at again, so the record below never holds a thread
     with a terminal running;
   - every child on another machine stopped with its machine's confirmation. Ordinary status
     reads a remote child stopped once every cancel went unanswered (ADR 0052, "Stop is
     final"), and that stays: the person's Stop must always settle. The move asks more: a child
     settled without an answer from its machine (`stopped_unconfirmed` 1 or 3, or lost) may
     still be writing there, so it fails the move at once (`remote_child_unconfirmed`); a late
     confirmation (2) counts. Amended 2026-11-19 (post-merge review): that holds whenever the
     child settled, so a second attempt after `remote_child_unconfirmed` fails the same way until
     the machine answers. A child that can never answer (3) keeps the thread from moving while it
     works; once it is at rest, ADR 0101's idle path moves it. The read filters before its limit
     of 64, through `machine_children_parent`, so many settled children never hide that one. It
     covers every parent of the tree, 256 a query; a tree of more than 4,096 threads, or any read
     that fails, fails the move (`remote_children_unread`) instead of passing on part of it.
     Amended 2026-11-19 (third review): the unconfirmed ones are read from a table of only them
     (`machine_children_unconfirmed`, `machines/unconfirmed-stops.ts`), kept current by triggers
     on `machine_children`, so a look costs what the unconfirmed children do, not a parent's
     history of confirmed ones (ADR 0170). The table and triggers are made empty on first use;
     rows from before are found per parent in batches of 2,000 settled rows, resumed across
     looks and restarts. Until a parent's are all found the read says it isn't complete, and the
     move waits, then fails with `remote_children_unread` if the 60 seconds run out.

   Bounded at 60 seconds; a tree that never comes to rest fails the move before the hand-over
   (`process_still_running` when a shell is what still runs, else `tree_still_working`), with
   nothing held.

4. **Then holds new input** for the hand-over, in the same step that saw the tree at rest.

The gaps the reviews found in Stop itself are fixed in Stop, so the person's own Stop button
behaves the same way. Plainly, this ADR changes ordinary Stop in three ways:

- **Late delegations are refused until the next turn runs.** A delegation that a stopped
  agent's ending turn still asks for (a tool call already on its way) was admitted, because
  delegation admission checked only the child's own cancellation fence. A Stop of an agent's
  turn now records the run it interrupted (`delegation_turn_fences`, one row per thread). A
  delegation from that thread is refused (`delegation_cancelled`) until the thread's agent runs a
  different turn. So the fence lifts exactly when the next message from the person or the parent
  is dispatched as a new turn, not when it is accepted into the queue. It works the same for a
  root and for a delegated child sent a new task. A late tool call from the interrupted turn
  that arrives while the next message still waits is refused. Amended 2026-11-19 (post-merge
  review): the fence used to compare the caller's own current run with the stopped one, so a
  provider subagent's run (a different id) lifted it while the cascade was still stopping it,
  and a late root call that arrived after the next turn began counted as that turn's. Now only a
  call made from the new turn lifts it (`agent-control/turn-fence.ts`, pure). Runs are ordered by
  `Run.seq`, a number core gives each run of a thread as it starts, subagents' included, never by
  the clock, so two runs that start in the same millisecond are still told apart. A Stop records
  the thread's last `seq`; the fence lifts on the first call whose own run is a root turn that
  began after it, or a run that began within that turn. What the Stop recorded then stays until
  the thread's next Stop (`delegation_turn_bounds`): a run that began before the lifting turn (a
  provider subagent still running from the stopped work) stays refused, and so do the `delegate`
  calls the provider had reported and not finished when the Stop came, by request id
  (`delegation_refused_calls`). Each Stop adds its calls to those earlier Stops caught, so one
  caught by an earlier Stop stays refused under any later turn, until it is resolved: it arrived
  and was refused. That write waits until every transaction the refused call ran in has ended,
  so their rollback can't undo it. A thread keeps its newest 256. A tool item closing is no
  sign the request won't still come: the Stop itself closes the item, while the provider's
  request may still be on its way. A call the provider never
  reported before the Stop can't be told from a new one, and is judged by its agent's run.
- **A whole-thread Stop stops background shells.** It used to leave the agent's background
  shells and monitors running (ADR 0052 listed this as a follow-up). It now stops each with the
  provider's own task stop, bounded like the interrupt, and closes the session when one won't
  stop.
- **One definition of a whole-thread Stop.** It is a cascading Stop that names no agent, or
  names the root agent by its own id (`engine/stop-scope.ts`). Before, agent control's cascade
  counted the root named by id as whole-thread while the engine's shell stop and close fallback
  didn't. The handler's queue hold, the delivery's shell stop and close fallback, and agent
  control's cancellation all read the one rule now.

**Holding input: one record.** The ownership record (`thread_ownership`, below) is the only hold,
owned by one transfer id and released in one transaction. While it says `stopping`, `handing` or
`moved`, nothing new runs for the thread: admission refuses new turns, the engine's dispatch holds
sends, recoveries and steers already queued, no provider session opens (checked again right before
the provider starts and once it has opened; a send that meets it goes back to the queue, held),
only teardown controls run, and no terminal opens (checked at the open and again right before
the shell spawns, after every await, so an open that was waiting on cleanup spawns nothing). A subagent is held by its root's record,
found through the delegation journal, so one row holds the whole tree. A held thread holds no
engine slot: it is left out of the threads picked to run, and its warm session gives up its slot
like an idle one when another thread needs it. A second move of a thread already moving is
refused at start (`thread_moving`), checked right before its row is written.

A message queued behind the working turn is not given to the provider while the root works, so
the Stop leaves it queued: a Stop fails only resumes, limits and merges waiting to run, and inputs
already in the interrupted turn.

**Known gap.** Processes a provider starts outside its own process group (a stdio MCP server or
a native helper that calls `setsid`, for example) are ended only when the provider ends them; a
Stop that closes the session signals the process group, which they left
(`packages/provider-kit/src/process.ts`). ace has no portable way to find them. They are rare,
and they don't write the checkout as a rule, but a live check is owed for each provider's
helpers.

Only then is the final snapshot taken. Then it captures what changed since the bulk:

- **Git methods.** A second capture commit of the checkout as it is now, and an incremental
  bundle of the branch and that commit, excluding the bulk's branch head and capture commit. It is
  usually a few kilobytes. The commit says what the bulk itself carried (`live.bulk`: its branch,
  head and capture), and the target reads the bulk by exactly that, never by the checkout at the
  stop: a checkout that was detached when the bulk left and on a new branch at the stop is read by
  the bulk's pinned head, and the branch comes from the delta.
- **A plain folder (archive).** A folder has no cheap diff, so its archive is packed after the
  stop instead of before. Plain folders are usually small; the strip says "Stopping the work here" for that time.
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
5. watches the turn start on the continue message itself (`live/turn-start.ts`, pure), read by
   its command id through the engine's `inputFate`, never on the thread's status. A turn the
   person starts there would change the status too, while the continue message still waits.
   Running means only that a run took that exact message (`delivered` with its run id). Taken
   from the queue with no run yet is not: an open that fails then puts it back. Waiting in the
   queue is not either, however long it waits. Waiting in a queue paused on a failure
   (`not_sent`, `model_unavailable`), or failed, means it was held unsent. Amended 2026-11-19
   (post-merge review): the person's own act on it is a defined outcome, not a start. Waiting in
   a queue the person's Stop paused (`stopped`, kept across restarts), taken out (`removed`) or
   sent again (`replaced`) ends the start as not started, with why ("the person stopped it"),
   and so does a Stop that cancels it once written but before any run took it (`inputFate` now
   reads such an input `failed`, not `delivered` without a run, so nothing waits on it),
   and no line on the thread, which already shows what they did. The target owns the thread
   from its cutoff, so the sender is answered and the source settles as moved. An `uncertain`
   message (it may have reached its run) is read again every half second for up to 10 minutes
   from when it first read so, a time kept across restarts (`transfer_live_uncertain`), then the
   start gives up as not started, said on the thread. There is exactly
   one continue message, ever. A resumed native session that fails to open leaves that message
   held unsent; the carried session is dropped, the handoff goes in front, and the same message
   is sent again with the person's own "Try again" (`queue.resume`). A turn that still fails is
   shown failed there, where the person can act on it;
6. records `running` on the transfer row. Status then answers `completed` with `live.running`.

The start is durable (`transfer_live_start`, `live/target-rows.ts`). When the engine refuses the
continue message at admission for a reason that passes (it is full, starting or shutting down,
agent control isn't ready), no message exists yet and the start is tried again, waiting 1
second, then 2, doubling up to a minute, about half an hour in all, the backoff kept across
restarts. Any other refusal ends the start at once. Each attempt is a command of its own id, so
the receipt of a refusal never answers the next try; the durable attempt count keeps a send that
went through from being sent twice after a restart. When it ends, the start's final state and
the line on the thread commit together: `running: false`, a line on the thread there
says it couldn't start and that a message carries it on, and the sender is answered, so the
source moves (the target owns the thread from its cutoff). A thread deleted there meanwhile is
final at once. Starts still pending are listed in a table of their own
(`transfer_live_pending`), so finding them never reads finished ones (ADR 0170), and a restart
drains it in batches of 64, a turn of the event loop between them, until none are left.
Retention never drops a transfer whose start is still pending, however long the target was
down, so the start can always be rebuilt from its row. A start waits for its transfer's setup
(the handoff and the link back) to finish. A setup that fails past the cutoff is tried again in
the background without a restart (1 second, doubling to a minute) until it goes: the transfer
never completes without its handoff and link, and the sender waits for it. A start that keeps
throwing is tried 8 times, then recorded as not started, said on the thread there.

Recovery and retention on both sides read side tables kept in step with every write to a
transfer's row, never the transfers table itself (ADR 0170; `transfers/transfer-index.ts`): on the
target, `transfer_incoming_open` lists transfers still receiving, cloning or importing and settled
ones with a rollback left to finish; on the source, `transfer_outgoing_open` lists unsettled
transfers and settled ones whose agent result is still owed. Each side's `_expiry` table lists
the others with the time retention counts from, indexed when it is made. Each read starts from the side table and reaches the row by its key. A home whose
rows predate the side tables is indexed once, in pages of the primary key with a turn of the
event loop between them, before recovery reads them; never at open. Its progress is kept with
each page it writes (`transfer_incoming_index_progress`), so a restart carries on where it
stopped. Until a source's indexing ends, a new move of a thread is refused
(`transfers_unavailable`, "try again in a moment"): a move already under way may not be in the
side table yet, and nothing indexes the transfers table by thread, so admission can't look it up
any other way (ADR 0170's rule on incomplete data). Recovery runs the indexing first, so the wait
is short. Recovery on each side drains every batch to the end, and the sending side's recovery
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
| `stopping` | source | stopped and at rest; new input held; may still resume here            |
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
  slot frees, and a restart keeps owing it. The record going, the "Moving to" row ending and the
  debt are one transaction. A thread whose queue is paused or waiting keeps it owed; it is
  dropped only once the thread carries on by itself (working, or asking the person).
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

Children are stopped, not paused. Everything the Stop stops is listed in the continue message,
so the agent there can start it again:

- **Background shells** (stopped by the Stop) **and open terminals** (stopped as settling does),
  by title.
- **Children running on this machine**, at any depth, by title. Moving them is out of scope for
  this stage.
- **Children delegated to other machines** are stopped by the same cascade, as the person's Stop
  stops them, and listed. The move goes ahead only once each one's machine confirmed it stopped
  (section 2).
- **A delegated child** (a thread with a parent) can't be continued live: it moves with its
  parent or not at all. It is refused with `thread_is_child`.
- **Queued messages** stay held on the source, never sent there and never failed; the continue
  message says how many. A moved thread reads moved with them still in its queue.

### 6. Agents

`transfer` with `thread: "self"` takes the same path. The agent's call returns at once; the
agent's own turn is the work being moved, so it is the turn the Stop stops. The result is not delivered to the source (it no longer runs); the target's continue
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

- Moving children with their parent instead of stopping them.
- Process-group escapees (see "Known gap" above).
- The lid-close stage: a lease on the ownership record, renewed by the owner, so a server can
  take over a thread whose laptop went to sleep, and the source can give up on a target that
  never answers.

## Verification

Unit tests: the cutover's stage machine (each failure before and after
`handing`, each restart point), the turn-start rule, the ownership record's transitions (one owner
at every step, a stale epoch refused), the Claude and Codex carriers against fixture homes (paths
rewritten, unknown lines kept, auth files never read, oversized and compressed sessions refused),
the source's rest wait (a finished turn's build waited out; a shell that never ends and a remote
child that never confirmed both failing the move before the hold), the target's start (native
session, the summary fallback through the same held message, which records no start when the
retry never dispatches it, a turn the person started not counted as the continue message's, a
transient refusal retried and any other ending it at once, a message queued for an hour never
sent twice, the receipt, pending starts past one batch), a setup that keeps failing never
completing its transfer, the durable resume (kept while the queue is paused or waiting), retention
keeping a pending start, both sides' recovery reads starting from their side tables, and the
ui-core words. ace's Stop (`agent-control/stop-tree.process.test.ts`, a real engine and agent
control with scripted CLI sessions): a stopped root's late delegation refused after the person's
next message is accepted and allowed once that message's turn runs, the same for a stopped
delegated child sent a new task, and a whole-thread Stop stopping the agent's background shell
whether it names no agent or the root by its id. A terminal open that was waiting on cleanup
spawns nothing once the thread starts moving (`workspace-terminal-ownership.process.test.ts`).
A thread move is refused while an upgraded home's transfers are still being indexed. End to end, two daemons
over their pinned link with real Git and scripted providers: a working thread moved with late
changes; a finished turn with a build running; a restart while handing; a lost link; a failure
before the hand-over; a message queued before the stop held through the move; a detached bulk
with a branch made before the stop; a lost answer after retention dropped the target's row; a
crash between the hand-over's two writes followed by an outage longer than the retry limit; a
real delegation tree (a child and a grandchild, scripted Claude sessions) stopped by the cascade
before the move, a late delegation refused and the stopped subagents listed there; a second move
of one thread refused; a remote child stopped without its machine's confirmation keeping the
thread here; a follow-up queued behind the working turn kept through the move's interrupt; a moved thread's
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
