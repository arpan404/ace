# Storage retention and cleanup

Issue #554 adds a daemon API and Settings → Storage. The CLI in #552 can call
this API without resolving daemon paths or implementing deletion rules.

## Requests

All operations use a correlated `storage.request` envelope. Replies use
`storage.result` with `result.kind` of `usage`, `plan`, `apply` or `error`.
Reads never enter the client outbox. Apply is durable by plan ID: after a timeout
or reconnect, read its status or apply the same ID and revision again.

```json
{ "type": "storage.request", "requestId": "usage-1", "operation": { "op": "storage.usage" } }
```

```json
{
  "type": "storage.request",
  "requestId": "plan-1",
  "operation": {
    "op": "cleanup.plan",
    "kinds": ["threads", "attachments", "artifacts", "logs", "worktrees", "caches"],
    "forceItems": []
  }
}
```

A plan returns `id`, `revision`, `createdAt`, `expiresAt`, `retention`, `items`,
`bytes` and `complete`. Each item has an opaque ID, category, display label,
byte count, last modification time, thread owners, `remove` or `protect`, typed
`reasons`, `effects`, and whether it was explicitly forced. Worktrees also name
their branch and whether that branch will be removed. Clients cannot nominate
filesystem paths or submit replacement plan contents.

```json
{
  "type": "storage.request",
  "requestId": "apply-1",
  "operation": {
    "op": "cleanup.apply",
    "planId": "the-returned-id",
    "revision": "the-returned-64-character-revision"
  }
}
```

```json
{
  "type": "storage.request",
  "requestId": "status-1",
  "operation": { "op": "cleanup.status", "planId": "the-returned-id" }
}
```

Apply returns `complete`, `pending` or `stale`, with per-item outcomes. Pending
means an effect needs retry or ownership could not be proven. A stale plan
requires a new preview. Completed plans return their recorded result on retry.
Plans belong to their reviewer. Usage requires read authority; plans, status,
apply and global retention settings require host administrator authority.

## Policy

The default retention periods, in days, are threads 90, attachments 30,
artifacts 30, logs 14, worktrees 30 and caches 7. `storage.retention` is a global
settings object with those six keys. Null keeps a category indefinitely. A
planning request may supply an explicit policy without changing saved settings.
Thread age includes its latest activity, archive or deletion. Attachment age
includes its last reference release, so releasing an old file does not make it
immediately disposable. Other files and worktrees use modification times.

Threads must be archived or already tombstoned. Worktrees belonging to retained,
unarchived threads remain protected even after a PR closes. Eligibility reads
the durable delegation family, whole-thread status, live engine/provider and
terminal ownership, even idle provider sessions, open browser sessions, held/uncertain/admitted inputs,
continuations, delegation results and reservations. A pinned or live descendant
protects its ancestors and siblings. Force never overrides these protections.
Referenced or leased attachments remain protected independently of thread age.

Worktree discovery requires durable proof that ace created the checkout inside
its managed worktree root. The record pins the root, checkout, repository and Git
administration directory identities. Hand-created linked worktrees, including
ones inside that root, and older checkouts without creation provenance are never
cleanup candidates. Replaced directories cannot inherit cleanup authority.

A force request names individual IDs from a preview, then creates another plan.
It can bypass only a worktree's uncommitted and unpublished-work refusals. Main
checkouts, locked worktrees, unknown Git state and mutation quarantine remain
protected. Git inspects hidden-index edits and ignored files, measures checkout
bytes, and compares the complete reviewed fingerprint under its mutation lease.
Only local remote-tracking refs establish pushed commits; cleanup never fetches.
Verified terminal PR facts come from the existing forge projection. A local
branch is removed only when all associated PRs are merged and its reviewed head
still matches. Closed PRs keep the branch. Missing registered directories are
removed by exact Git worktree target, never by a broad prune.

Browser artifacts and recordings are exact files under daemon-owned artifact
roots. Retained thread references and browser acquisition/session ownership
protect them. Browser profiles are not swept as anonymous artifacts. Thread
deletion invokes their existing owner, including the desktop partition cleanup;
this effect is named in the preview. Current `ace.jsonl` is always protected.
Cache removal is deferred while agent/browser work is active or a thread is
pinned. Symlinks are listed as protected, never followed.

Built-in skill session roots (`builtin-skill-sessions/session-XXXXXX`) are
`caches` items with a `skill_root` target that names one root; clients still
cannot nominate paths. Each root is one item, sized and aged over its whole
tree. Its process lease decides protection, with the same rule as startup
cleanup: a live owner, a pending spawn or a surviving process group gives
`leased`, and a missing, foreign or unverifiable lease, or a root without the
plugin writer's ownership marker, gives `owner_unavailable`. Symlinks, plain
files and trees past 10,000 entries or 16 levels are listed as `unsafe_path`
instead of failing the plan. Removal proves ownership again under the
projection writer's lock and walks pinned descriptors without following links;
the lock database, marker and lease go last, lease final, so an interrupted
removal keeps its proof. Scans resume after `builtin-skill-sessions/.storage-cursor`,
so roots that stay protected cannot hide later ones from the 256-item budget.
Daemon startup reclaims the same roots independently (at most 64 removals and
1,024 lease inspections per start, resuming from `.cursor`).

## Durability and measurement

The shared pure planner lives in `@ace/core`; protocol schemas contain no I/O.
The daemon injects its root, clock, identifiers and scheduler. Files use the
existing pinned-directory descriptor boundary. Git inspection and both worktree
and branch removal use `GitService.nonExecuting`, retaining mutation quarantine.

Reviewed plans persist in SQLite before apply. Apply validates the whole plan
before its first effect, then checks every item again. It records an admission
fence and running progress before destructive I/O. Thread fences deny new sends,
terminal opens and organization changes. Worktree root reservations are committed
before final asynchronous Git inspection. Current root owners, including local
workspace owners without engine sessions, are then revalidated under that fence
and immediately before Git dispatch. Confirmed pre-deletion refusals become
protected and release their fences; uncertain effects keep the running journal
and fences for recovery. Removal records a permanent root marker, preventing a retained
thread from reopening a missing checkout. Startup resumes accepted running plans.
Attachment deletion has a second journal inside its existing serializer, covering
the original file, its MIME alias and byte accounting across a crash.

Transcript purge retains small thread tombstones, execution-root bindings,
delegation identities and replay deletion coverage. It removes event/item/output/
blob bodies, settled input payloads, engine state records and long-thread indexes.
Attachment references are released through their owner. Original provider session
files outside ace's data directory are never scanned or deleted.

Usage is explicitly bounded and reports `complete: false` when its scan budget
is exhausted. Thread sizes count stored payload bytes, not SQLite allocation.
Worktree sizes count files without following symlinks. Browser partitions owned
by the desktop are not included in local byte estimates. Database and WAL disk
usage, plus reusable SQLite pages, are reported separately. A reviewed plan is
limited to 256 items and 512 KiB; its removals are exact even when it is a partial
batch. Preview again after applying a batch to discover additional data. Very
large worktrees fail closed with `unknown_git_state` rather than a partial
cleanliness proof.

Retention cleanup never starts VACUUM or incremental vacuum. Deleted SQLite pages
stay reusable by ordinary writes; a cleanup plan does not promise to shrink the
database file. Compaction is a separate, admin-only operation.

## Compaction

`cleanup.compact` compacts `events.sqlite`. It runs under the Store maintenance
fence, never inside a retention plan.

The Store has one write boundary, `Store.write(run)`. A caller awaits admission
there, then `run` commits synchronously, so ownership checks inside a commit still
see the state they commit against. `writable()` is the same admission for callers
that already sequence their own commit. History publication and other writers whose
commits span awaits register through `Store.writer()`. `Store.maintenance(work)`
holds new admissions, waits up to 10s for registered writers to drain, then runs
the work alone. A held writer waits up to 60s, then fails as `Store is busy`, the
same transient error SQLite contention already raises. Refresh sweeps, async action
receipt completion, automation admission, the async Forge projections (status,
refresh and PR creation), device artifact publication and preview authentication
all go through `write`.

A few writers stay synchronous by contract: event-listener bookkeeping, the
`WriteDispatch` journal callbacks in `@ace/forge`, reservation of async command
receipts, and bearer authentication on sockets. They share the Store's single
connection and event loop, and a maintenance step never holds a transaction across
an await, so such a write commits whole between two steps and is never lost or torn.
Moving them behind `write` needs interface changes in those packages and is tracked
separately.

New databases are created with `auto_vacuum=INCREMENTAL`. The incremental mode
releases free pages with `incremental_vacuum(256)`. Each chunk is its own
transaction, journaled in `storage_compactions`, and the step yields between
chunks. A run is limited to 4,096 chunks and is left `pending` beyond that. It
ends with `wal_checkpoint(TRUNCATE)`; `checkpointed: false` means a reader kept
the WAL from being truncated. A file created before incremental vacuum reports
`fullRequired`. Only a full rebuild can shrink it: `mode: "full"` with
`confirm: true`, which sets incremental mode and runs `VACUUM`. Full VACUUM keeps
the rowids of tables without an explicit INTEGER PRIMARY KEY through SQLite's
transfer optimisation, and some engine tables depend on that ordering.

Every step leaves an intact file if the process is killed. A chunk and a VACUUM
are both atomic, so the only trace is a `running` journal entry. On startup, an
incremental entry resumes. A full rebuild is never repeated without a fresh
confirmation: it becomes `interrupted`, waiting for `cleanup.compact` with
`mode: "full", confirm: true` or for `cleanup.compactAbandon`. Settings → Storage
offers Compact database, and offers Rebuild database (behind a confirmation)
when it is needed. The CLI equivalent is
`ace clean --compact [--full --confirm] [--abandon ID]`.

## Scheduling and verification

`StorageService.scheduledCleanup()` is the host automation hook. It resumes old
accepted work, creates a plan from saved policy and applies it with no forces or
database maintenance. `storage.scheduledCleanup` defaults to false. Enabling it installs
one injected timer with a durable daily deadline. Disabling it also withdraws
permission from an in-flight scheduled apply. No provider CLI is started.

Behavior tests are written for real temporary SQLite, files, Git repositories
and a daemon process killed after its first deletion. Additional UI tests guard
preview, protected explanations and confirmation. Tests, mutation runs and
benchmarks were not executed under the owner's development policy. Merge-time
verification should include these production mutations:

- Ignore descendant human work or pins.
- Ignore paused/uncertain inputs.
- Skip plan revision or expiry checks.
- Delete a file whose identity changed after preview.
- Follow a substituted directory symlink.
- Remove a skill root whose lease is live, unreadable or unmarked.
- Remove a blob while a provider lease owns it.
- Bypass pushed-commit or hidden-index checks.
- Infer cleanup ownership from a linked worktree or directory name.
- Admit a new root owner during final cleanup inspection.
- Retain admission fences after a confirmed pre-deletion refusal.
- Enable repository fsmonitor/filter execution during cleanup.
- Remove a changed branch instead of compare-and-deleting it.
- Omit either running journal or its startup replay.
- Drop replay deletion coverage when purging a transcript.
- Apply a preview before the user's confirmation.
