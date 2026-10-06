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
hashed journal beside the selected directory. Clone holds its parent scope,
which also fences its destination. Repository lookup checks enclosing scopes,
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
destroys its descriptors and drops its process reference. It does not wait for
process `close` or the cleanup receipt to reject or finish service shutdown.
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
`git_quarantined`. Ready workspace preparation checks the same fence before a
provider session opens. Before-send checkpoint preparation rejects quarantine
after recording its unavailable state, so it cannot deliver another turn into an
uncertain workspace. Ordinary checkpoint failures retain their existing behaviour. Deck exposes the same execution error, retains its pending
integration/preparation effect and stays nonterminal. Restart retries that
existing effect; it encounters the durable fence rather than admitting another
writer. Native Deck worktree operations use the host's injected Git supervisor
and process boundary from `workspaceActions.git`.

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
tests guard visible quarantine, retained Deck effects and restart. Tests run
serially under this task's explicit authorization. No provider CLI or recorder
session is involved.
