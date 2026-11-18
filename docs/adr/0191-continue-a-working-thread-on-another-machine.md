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
adapter carries out with its own interrupt. Then it captures what changed since the bulk:

- **Git methods.** A second capture commit of the checkout as it is now, and an incremental
  bundle of the branch and that commit, excluding the bulk's branch head and capture commit. It is
  usually a few kilobytes.
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
   running. A resumed native session that fails to open is retried once with the handoff instead.
   A turn that still fails is shown failed there, where the person can act on it;
6. records `running` on the transfer row. Status then answers `completed` with `live.running`.

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
  was interrupted the source sends itself "Moving to Studio didn't work: <reason>. Carry on
  where you left off." A source restart in `stopping` carries the cutover on from there.
- **`handing` is written before the commit is sent.** From then on the source never resumes on
  its own: the commit may have landed. It asks status until the target answers. `completed` (the
  target owns it) moves the source; `failed`, `cancelled` or "no such transfer" (the target never
  passed its cutoff) resume the source. A lost link or a target that is off is waited for without
  the one-hour limit ADR 0101 sets for other transfers; the strip says "Waiting for Studio to
  answer". The thread stays working meanwhile, never done.
- **A target restart** before the cutoff undoes the import and runs it again (ADR 0101); after
  it, the thread exists and the target finishes setting it up and starting its turn, keyed so it
  runs once.
- **A source restart** in `handing` reads the record, keeps refusing turns, and asks status again.

Cancel works until `handing`; after it, Cancel answers `too_late`, as ADR 0101's does past the
cutoff. Giving up on a target that never comes back needs the lease of the lid-close stage; until
then the source waits.

### 5. What can't move

- **Background shells and open terminals** of the thread are stopped after the interrupt. The
  continue message lists them by title ("Stopped here: dev server (npm run dev)"), so the agent
  there can start them again.
- **Children running on this machine** are stopped (their own `thread.interrupt`, with
  cascade) and listed. Moving them is out of scope for this stage.
- **Children delegated to other machines** keep running. Their parent link can't be repointed
  yet: their results wait undelivered on the moved thread, which holds them and runs nothing. They
  are listed in the continue message, and repointing them to the new parent is a follow-up.
- **A delegated child** (a thread with a parent) can't be continued live: it moves with its
  parent or not at all. It is refused with `thread_is_child`.
- **Queued messages** stay held on the source; the continue message says how many.

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
and the ui-core words. Live checks owed, because no real CLI ran: Claude resuming a session
placed under a new folder name; Codex forking from a copied rollout whose `cwd` changed; the
interrupt landing between tool calls for each provider; a resume failure reading as `failed` on
the new thread.
