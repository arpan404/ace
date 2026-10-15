# 0068: Git failure responses and durable mutation cleanup

Date: 2026-10-05. Status: accepted for implementation.

## Context

Issue #55 follows audit D4 in PR #53. A Git filter or helper can start a detached
writer, leave its parent's process group, and inherit output descriptors. Killing
the parent group does not stop that writer. Waiting for `close` makes deadlines
unbounded. Destroying descriptors and releasing a worktree lock permits another
operation to modify files while the first writer remains alive.

Node distinguishes [process exit from pipe closure](https://nodejs.org/api/child_process.html#event-close).
Microsoft documents [taskkill's descendant termination request](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill).
Neither event or request supplies proof that arbitrary escaped writers are gone.
The implementation uses our own contract and code, with no external implementation.

## Decision

`@ace/provider-kit/cleanup` owns the shared Zod-validated `MutationLease`,
`CleanupResult`, `CleanupReceipt` and supervisor contract. A receipt is awaitable
independently of an operation's result. A confirmed receipt requires containment
or equivalent exclusive-scope evidence, covering escaped descendants and writers
without inherited pipes. Exit, EOF, timeout, PID absence and successful kill
requests cannot establish that evidence. Supervisor failure means unconfirmed.

Git records an intent before entering every locked operation. The I/O shell
writes and flushes a uniquely identified record in the repository's common Git
metadata directory. It resolves `.git` files and linked-worktree `commondir`
files without spawning Git. Records for repositories sharing metadata therefore
fence their shared refs together. Clone/init before Git metadata exists use a
hashed journal beside the selected directory. Clone holds its pre-created destination scope so cancellation fences that checkout
without blocking unrelated sibling projects. The host retains a quarantined partial
checkout until trusted cleanup evidence permits removing it. Repository lookup checks enclosing scopes,
so root quarantine fences descendants even before they have Git metadata.

Nested locking preserves the existing hierarchy and checkout ownership. Before
entering a descendant, the parent intent records that descendant's canonical
root. All held scopes are captured when each process starts. This capture is
explicit: injected deadline callbacks need not retain AsyncLocalStorage context.
A lazily created, unreferenced local TCP endpoint answers bounded, token-verified
ownership queries. It distinguishes a healthy foreign owner from an unknown
intent without relying on PIDs. Healthy foreign owners may allocate against
separate linked worktrees using the existing ref CAS; overlapping scopes remain
unavailable. In-process scopes still use the shared scheduling locks. Successful
concurrent retirement is rechecked before denying a stale directory entry.
Endpoint absence, port reuse, token mismatch and query failure all fail closed.
Owner liveness never establishes cleanup or authorizes retiring an intent.
The pure `leaseState` function denies unknown or quarantined intents. The lock,
filesystem journal, process spawner, signaler and timers remain I/O shells; lease
IDs, deadlines, process launch and process-group signaling are injectable.

Timeout, close cancellation, abort, stream failure and unexpected signal exit
first quarantine the captured root and descendant leases synchronously. The
caller receives its original typed error with `GitError.cleanup`. Restore also
retains `safetyCheckpointId`. The runtime cancels timers, detaches stream consumers,
destroys its descriptors and releases its call registration. It does not wait for
process `close` or the cleanup receipt to reject or finish service shutdown.
Shutdown separately drains the owned leader's `exit` notification with an
injected one-second deadline before allowing its worker to exit. This drain
never waits for inherited pipes and never retires a mutation lease; leader exit
or the drain deadline supplies no escaped-descendant containment evidence.
Queued callers acquire the released scheduling lock, then explicitly reject
with `git_quarantined`; durable quarantine continues to own mutation access.
The service checks quarantine before even verifying its executable.

A successful ordinary Git completion retains the existing lock rules and retires
its intent after the operation and temporary-index cleanup finish. On failure,
only confirmed supervised cleanup retires an intent. If several processes fail
within one operation, every receipt must confirm cleanup. An unconfirmed or
pending sibling keeps the root fenced. Leases do not leave a process-global
history cache: successful and failed operation registrations are removed when
operations unwind, and quarantine remains on disk.

## Platform policy

- macOS and Linux request POSIX process-group termination. Arbitrary `setsid` or
  detached descendants are not contained, so default receipts are unconfirmed.
- Windows requests `taskkill /PID /T /F`. Helper failure or its deadline falls
  back to leader termination and descriptor cleanup. The helper's own deadline
  bounds its ownership. Default receipts are unconfirmed because ace currently
  has no Job Object owner that prevents breakaway.
- Other Node platforms use the same conservative unconfirmed policy.

An already-exited leader is never signaled again using its possibly reused PID.
On Windows, files are flushed but Node cannot flush directory handles. This
contract covers daemon/process restart; it does not promise crash consistency
across power failure on every filesystem.

## Visible state and restart recovery

`GitService.mutationState(path)` reads the journal without launching Git and
returns `available` or `quarantined` plus durable identities and captured roots.
Any journal left by a killed daemon has no matching live ownership endpoint and
is quarantined. Malformed, oversized and excessive records fail closed. Restart,
service close and pipe destruction never erase an uncertain intent.

Workspace command receipts and unavailable turn checkpoints expose
`git_quarantined`. A separate workspace-admission port checks the same fence
before a provider session opens, including roots already prepared at creation.
It never repeats preparation of an already-ready root. Before-send checkpoint
preparation rejects quarantine
after recording its unavailable state, so it cannot deliver another turn into an
uncertain workspace. Ordinary checkpoint failures retain their existing behaviour.

A host calls `GitService.recoverCleanup(path)` with its trusted
`processRuntime.cleanupSupervisor`. The supervisor reconciles lease identities
against its own containment journal or equivalent exclusive-scope evidence,
never by signaling persisted PIDs. Recovery traverses the recorded descendant
roots and retires no intent until every relevant receipt confirms cleanup.
Currently executing scopes are never reconciled. Missing proof, failed proof,
unknown identities and a missing supervisor preserve quarantine. Once all proof
is available, access resumes through the ordinary public service API.

The default runtime deliberately cannot self-certify same-boot cleanup. Native
cgroup/Job Object containment or a host supervisor with durable evidence can
provide confirmation through the shared port. An operator must obtain that
evidence before recovery; deleting journal files is not a supported recovery
procedure. No client or provider tool can submit a cleanup assertion.

## Verification

Public GitService tests start a real escaped Node writer during child checkout,
expire injected deadlines or close the service, and obtain the failure while the
writer can still modify the worktree. Root and child queued/new checkpoints must
reject. A separate Node process observes the durable quarantine. Tests then stop
the exclusive fixture writer, verify its endpoint and kernel termination, and
supply the fixture supervisor's proof. Both live receipts and restart
reconciliation recover access. Partial child proof must retain the parent fence.

Existing real Git tests guard normal checkout ownership, POSIX/Windows request
strategies, first stream-error preservation, indexes and filters. Daemon process
tests guard visible quarantine, restart recovery. Tests run
serially under this task's explicit authorization. No provider CLI or recorder
session is involved.

## Amendment (2026-10-13): stale-lease retirement and scope

A lease left by a daemon that died during an ordinary restart quarantined every worktree of its
repository for a week: its owner port had no listener, its root worktree had been removed, and
nothing could ever retire it, because an absent owner read the same as an unanswered one and
`leaseState` denied every unknown intent repository-wide.

- **Definitive owner absence.** The owner probe distinguishes `gone` (connection refused, or the
  listener answers for a different token) from `unknown` (timeout, reset, malformed reply, or the
  owner answering for its own token about an intent it no longer runs). Only `gone` counts.
- **Automatic retirement.** Admission, `mutationState` and a startup sweep over registered
  projects retire an intent when its owner is `gone` and every recorded root is gone or no longer
  a registered worktree of the repository (its `.git` points at pruned or reassigned metadata).
  A second probe precedes removal; each retirement is reported to the host's log.
- **Scope.** An uncertain intent fences the roots it overlaps. It fences the whole repository only
  when a recorded root is a main checkout, a separate repository or anything not proven to be a
  linked worktree. A linked-worktree intent no longer blocks its siblings.
- **Confirmed retirement.** When the owner is `gone` but a recorded checkout still exists, ace
  cannot prove an escaped writer stopped. The quarantine message names the repository, the
  checkout and the start time, and offers "Clear stale lock": after the person confirms, the same
  verification runs and the intent is retired only if its owner is still `gone`. An owner that may
  be alive (`active`, `quarantined`, `unknown`, or this daemon's own quarantined intent) keeps the
  fence; restarting that daemon makes the owner `gone`.

This replaces "Owner liveness never establishes cleanup or authorizes retiring an intent" and
"deleting journal files is not a supported recovery procedure" above for these cases only.

## Amendment (2026-10-14): self-healing leases and Git locks

Issues #712, #721 and #722: sends failed with "A stale Git lock blocks this checkout", and Clear
stale lock did nothing. A timeout, abort or service close quarantined the lease on disk. Then the
daemon dropped its in-memory record of it. Its own endpoint answered `unknown` for the lease, so
nothing short of a restart could retire it. A lease on a linked worktree nested inside the main
checkout's directory also fenced the main checkout, because overlap compared paths.

- **Evidence that work ended.** Without a cleanup supervisor, ace accepts two kinds of evidence:
  the process group it killed is gone, or no live Git process (listed with `lsof` on macOS and
  `/proc` on Linux) works in any of the lease's roots. A Git process whose directory can't be
  read counts as working everywhere. Without a listing (other platforms), only the earlier rules
  apply. A supervisor, when configured, stays the only source of proof. Writers that escape
  their process group without being Git are not detected. This replaces the "default runtime
  cannot self-certify" rule above for hosts without a supervisor.
- **Own leases.** A quarantined lease stays in a process-local registry after its operation
  unwinds. It retires as soon as each killed group is gone, polled right after the kill and on
  service close, and checked again by every admission and sweep. A lease carrying this
  process's owner token but no registry entry counts as `orphaned`. It retires once no Git
  process works in its roots.
- **Stopped owners.** A lease whose owner is `gone` retires once no Git process works in its
  roots, even when its checkouts still exist. At startup this retires a previous instance's
  leases, and the daemon repeats the sweep every minute.
- **Waiting, not failing.** Admission waits (default 60 seconds, polling) for a lease that clears
  on its own: one held by a live owner, or one whose process is still alive. It never waits for
  a lease the caller holds itself. After the bound the error names what holds the lock. Clear
  stale lock is the last resort, and it reports how many locks it actually retired.
- **Git lock files.** `index.lock`, `HEAD.lock` and partial-commit temporary indexes of a
  checkout, and the shared ref, `packed-refs`, `shallow` and `config` locks, plus a
  `worktree add` still marked `initializing`, are removed only when they are older than a grace
  period and no Git process works there. That covers the checkout for its own locks, and every
  checkout and the common directory for shared ones. This runs after a lease retires, in
  sweeps, and once when a write fails because a lock exists, before a single retry.
- **Fencing by worktree identity.** A linked worktree root fences only itself and the paths
  inside it, never the checkout whose directory contains it. Main checkouts and separate
  repositories keep fencing the whole repository.
- **Deadlines.** Commit, staging, switch, merge and worktree add/checkout run under a ten-minute
  deadline (`longWriteTimeoutMs`) instead of the service default, so hooks are not killed at 30
  seconds. They stay cancellable.
