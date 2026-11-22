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
  `@ace/account-grant`). It carries `epoch`, the backend's restore generation: raise
  `ACE_ROSTER_EPOCH` by one after any restore of the accounts database.

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
  offline allowance (`threads.offline_minutes`, default 60, at most 1,440) applies only while the
  backend can't be reached at all (no answer, a timeout, a 5xx). An answer that refuses (401,
  403, a bad signature, a stale roster) gives none.
- A lease that ran out is stopped, never renewed.
- Times are on a lease clock that never goes back and never runs slower than the monotonic clock.
  After a restart whose wall clock is behind the last recorded time (`member_clock`), the roster
  from before renews nothing.
- A pass runs at start, before the first fetch, after each roster and every 60 seconds.

## Stopping

- A stop is recorded as pending before anything is torn down (`stop_pending`). It stays pending,
  and is retried each pass and after a restart, until the tree's sessions are closed and the
  member's contained processes are gone.
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

- **Linux:** each member's provider processes start inside a transient scope under their own
  slice, `systemd-run --user --scope --slice=ace-member-<hash>.slice`, with no delegation and
  `--expand-environment=no`. They are inside before any provider code runs. A scope that can't be
  made (no user manager, systemd older than 254) starts nothing. A stop writes `1` to the slice's
  `cgroup.kill` and waits for `cgroup.events` to read unpopulated.
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
| `admit(account, root, from)` | Whether the tree may take new work now; holds its lease         |
| `release(root)`              | The tree settled on its own                                     |
| `launchEnv(account)`         | Environment that starts a member's process in their containment |
| `stop(account, reason?)`     | Stops all of the member's work: trees, then contained processes |
| `stopReason(root)`           | Why a tree was stopped, until its owner resumes it              |
| `pendingStops()`             | Trees whose stop isn't confirmed yet                            |
