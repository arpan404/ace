# Members' work on an org host

How an org host decides whether a member's work may keep running, and how it stops it
([ADR 0209](../adr/0209-members-work-on-a-shared-org-host.md) §7 and its amendment 1). The code is
`apps/daemon/src/member-work/`. On a personal machine none of it acts: no roster is fetched, no
lease is held and nothing is stopped.

## The roster

`GET /v1/orgs/{org}/hosts/{hostId}/roster` answers only that host's organization credential.

- The backend reads the members mirror (removed members too, with WorkOS's time for each one's
  state), the org's hosts and the version last served in one D1 batch, which is one transaction.
- A body different from the one served takes the next version, only while the members are still
  at that snapshot's revision (migration `0011_org_rosters.sql`). A request that read before a
  removal can never take a version after it.
- The statement is signed with the grant key over the body's SHA-256 (`signOrgRoster` in
  `@ace/account-grant`), dated with the snapshot's read time. It carries `epoch`, the backend's
  restore generation (`ACE_ROSTER_EPOCH`, a secret outside D1): never assumed (unset, no roster:
  `roster_epoch_unset`), never behind what the database recorded (`roster_epoch_behind`), and
  raised by one after any restore of the accounts database (`docs/release/workers.md`).
- Serving the same version again is guarded like taking the next: only while the members are
  still at the snapshot's revision.

The host fetches it every 60 seconds and refuses a roster for another org or host, one not
signed by the pinned keys, a lower epoch, a lower version in the same epoch, and the same version
with another body or no later signing time.

## Revocations and leases

- A roster that lists a member as anything but `active`, or no longer lists an account the host
  knew, writes `member_revocations` in the roster's own transaction. The revocation keeps the
  WorkOS time of the state that revoked them. Only a roster that shows them active in a later
  WorkOS state lifts it, so a restored backend can't.
- A member tree's lease (`member_leases`) lasts 15 minutes. A pass renews it while the member may
  run work: not revoked, active on the held roster, and that roster at most two minutes old. The
  offline allowance (`threads.offline_minutes`, default 60, at most 1,440) applies only to
  transport failure: no TCP or TLS answer, or no headers in time (`roster-fetch.ts`). A refusal is refused before its body is read; a body that stalls or is cut short after the headers is an answer too. Every HTTP answer
  gives none: a refusal, the origin's contention or epoch errors, a proxy's 5xx, a redirect.
  Someone on the path who drops replies gets the bounded outage behaviour, by design.
- A lease that ran out is stopped, never renewed.
- Times are on a lease clock that never goes back and never runs slower than the monotonic clock.
  After a restart whose wall clock is behind the last recorded time (`member_clock`), the roster
  from before renews nothing.
- A pass runs at start, before the first fetch, after each roster and every 60 seconds.

## Admitting work

`admit(account, root)` takes or renews the lease, and refuses past an expired lease, while a stop
is under way, or on a tree a stop ended. Every session open, input, answer to a provider's
request and goal goes through it. It never clears a stop: only `resume(account, root)` does, which
the access policy calls when it admits the owner's own proven input. Engine continuations,
retries, automations and sends of unknown origin can't.

## Stopping

- A stop is recorded as pending before anything is torn down (`stop_pending`). It stays pending,
  and is retried each pass and after a restart, until the tree's sessions are closed (retained
  ones too), its slice is confirmed empty, and each child it delegated to another host is
  confirmed ended by that machine (`MachineChildren.endings`), or until the deadline that machine
  enforces itself has passed (see below). A delegation is recorded before it is sent
  (`member_remote_starts`). One refused for certain holds nothing; one whose answer was lost is kept
  until a probe (`MachineCaller.probe`) names the child or the target withdraws the request.
- A member's child on another host carries `member: {account, ttlMs}`. The destination records
  the deadline when it makes the child (`member_child_deadlines`), tears the child down by it on
  its own clock (a timer and every pass), and its gate refuses the child any work after it.
  Nothing renews it.
- Every affected tree is fenced at once; then each tree's teardown and containment kill start
  together, each bounded by `STOP_BOUND_MS` (30 s), so processes die even while a session close
  hangs and one tree holds back neither the others nor the next pass. A try that outlives the
  bound is tried again.
- `stopMemberTree`, before anything is awaited:
  - fences every unfinished thread from delegation and result delivery;
  - fences it from new work through `Engine.stopForOwner`: intents retired, queue stopped;
  - records what was unsettled as failed, with "Stopped · its owner is no longer in this
    organization" or "Stopped · couldn't confirm its owner is still in this organization".

  Children on other hosts get the cross-machine stop (`machines.caller.cancel`), which the
  children's ledger repeats until each machine confirms. Then every local session closes and
  what was in flight drains. The thread reads failed, never done, and waits for its owner to
  resume it.

- A member a roster revokes loses every open socket at once. No hello, command or grant refresh
  of theirs is admitted after that, even on a grant still unexpired.

## The gate

`gate.ts` runs at every execution entry point. The provider adapter wrapper in
`services/engine.ts` gates every session open, before spawn and for pooled providers too, and
every input: turns, queued starts, automation and wake runs, steers. `services/agent-control.ts`
gates delegation to another host. Background shells are the provider's own children and live in
its session and containment.

`OwnerOf` (`DaemonOptions.ownerOf`) says who owns a thread. It answers none on personal machines
and for the host's own threads, which pass unchanged. The access policy fills it in from
`thread_access`. An owned thread with no member work to vouch for its owner is refused.

## Containment

- **Linux:** each member tree's provider processes start inside a transient scope under the
  tree's own slice, nested in the member's,
  `systemd-run --user --scope --slice=ace-member-<member>-<tree>.slice`, with no delegation and
  `--expand-environment=no`. They are inside before any provider code runs. A scope that can't be
  made (no user manager, systemd older than 254) starts nothing. A stop writes `1` to the tree's
  slice's `cgroup.kill` and counts only once `cgroup.events` reads unpopulated, systemd says the slice doesn't exist, or the kernel has no cgroup where systemd makes it. A cgroup it can't read stays unconfirmed. Sibling trees are untouched.
- **The boundary:** the slice lives in the host user's own systemd tree, which that user can write.
  An unprivileged daemon can't make a system-manager scope (that needs root or polkit's
  `manage-units`). So this stops accidental escapes, not a hostile member: phase 1's
  trusted-member boundary (ADR 0209 §1). Phase 2's separate OS users close it.
- **macOS, phase 1: best effort.** A member's processes are their sessions' process groups, which
  closing the session kills. A process that leaves its group (`setsid`, a daemonizing tool)
  outlives the stop. The host page must say so.

## The seam

| Call                         | What it does                                                    |
| ---------------------------- | --------------------------------------------------------------- |
| `active(account)`            | Whether the member may run work here now                        |
| `revoked(account)`           | Whether a roster revoked them and nothing since lifted it       |
| `admit(account, root)`       | Whether the tree may run work now; holds its lease              |
| `resume(account, root)`      | The owner's proven input resumes a tree a stop ended            |
| `remoteStart(account, root)` | Records a delegation to another host before it is sent          |
| `release(root)`              | The tree settled on its own                                     |
| `launchEnv(account, root)`   | Environment that starts a tree's process in its containment     |
| `stop(account, reason?)`     | Stops all of the member's work: trees, then contained processes |
| `stopReason(root)`           | Why a tree was stopped, until its owner resumes it              |
| `pendingStops()`             | Trees whose stop isn't confirmed yet                            |
