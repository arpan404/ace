# Members' work on an org host

How an org host decides whether a member's work may keep running, and how it stops it
([ADR 0209](../adr/0209-members-work-on-a-shared-org-host.md) §7). The code is
`apps/daemon/src/member-work/`. On a personal machine none of it runs: no roster is fetched, no
lease is held and nothing is stopped.

## The roster

`GET /v1/orgs/{org}/hosts/{hostId}/roster` answers only that host's organization credential. The
backend builds the body from its members mirror (members by account, hosts by id), signs a
statement over the body's SHA-256 with the grant key (`signOrgRoster` in `@ace/account-grant`),
and gives the body a new version whenever it differs from the last one served (migration
`0011_org_rosters.sql`). The body rides beside the statement, as the policy's does, because a
signed statement is at most 2 KiB.

The host fetches it every 60 seconds and verifies it against the pinned grant keys. A roster for
another organization or host, or one with a lower version, is refused. The same version is taken
again only when it was signed later, which only refreshes its time.

## Revocations and leases

A roster that lists a member as anything but `active`, or no longer lists an account the host
knew, writes `member_revocations (org, account, version, seen_at)` in the same transaction as the
roster. Only a later roster showing the member active clears it.

A member tree holds a lease in `member_leases` for 15 minutes. Each pass renews it while the
member may run work: not revoked, active on the held roster, and that roster no older than two
minutes or `threads.offline_minutes` (policy, default 60, at most 1,440), whichever is longer. A
roster's time is the backend's signing time, never later than when it arrived. A pass runs at
start, before the first fetch (so a revocation seen before a restart stops work while offline),
after each roster and every 60 seconds.

A pass stops each lease whose owner is revoked, and each lease that ran out. A stop fences the
tree from delegation, closes its sessions and records what was unsettled as failed, with
"Stopped · its owner is no longer in this organization" or "Stopped · couldn't confirm its owner
is still in this organization" as the reason (`Engine.stopForOwner`). The thread reads failed,
never done, and its queue stays stopped until the owner resumes it. A member's open sockets close
as soon as a roster revokes them, before their grant would run out.

## Containment

- **Linux:** each member's contained processes are moved into a transient systemd scope of their
  own (`ace-member-<hash>.scope`), made through the user's systemd manager with no delegation.
  A stop writes `1` to the scope's `cgroup.kill`, which takes every process in it, including one
  that left its process group or session. The scope lives in the host user's own systemd tree,
  which that user can write, so a process set on leaving it can. That is phase 1's trusted-member
  boundary (ADR 0209 §1). Phase 2's separate OS users close it.
- **macOS, phase 1: best effort.** Each contained process leads its own process group, as
  provider-kit spawns them, and a stop kills those groups. A process that leaves its group
  (`setsid`, a daemonizing tool) outlives the stop. The host page must say so.
- A process that can't be moved into a scope (no user manager, a refused call) is still killed by
  its process group.

## The seam

The rest of the daemon uses `MemberWork` (`member-work.ts`):

| Call                       | What it does                                                    |
| -------------------------- | --------------------------------------------------------------- |
| `active(account)`          | Whether the member may run work here now                        |
| `revoked(account)`         | Whether a roster revoked them and none since showed them active |
| `hold(account, root)`      | A member tree starts or resumes; false refuses it               |
| `release(root)`            | The tree settled on its own                                     |
| `contain` / `processLease` | A member's process joins their containment                      |
| `stop(account, reason?)`   | Stops all of the member's work: trees, then contained processes |
| `stopReason(root)`         | Why a tree was stopped, until its owner resumes it              |

Until member trees have owners (`thread_access`, ADR 0209 §5.3), nothing calls `hold` or
`processLease`: the access policy's start rule holds the lease when a member starts or resumes a
tree, and the owner-keyed provider pool passes `processLease(owner)` to its spawns.
