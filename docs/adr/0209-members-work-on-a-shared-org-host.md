# 0209: Members of an organization work in projects and threads on one shared org host

Status: accepted. Date: 2026-11-21. Decided by: the owner (2026-11-21: "yes", taking every
recommendation listed under "Decided"). Asked for by the owner the same day (build ADR 0206 §2.4's
phase 3, coding threads on org hosts), and revised after a security review of #2511.

Amends:

- [ADR 0206](0206-organizations-on-workos.md) §2.2 (what a member may do on an org host), §2.4
  (made concrete: private threads wait for the member boundary, §9), §3 (one narrowing policy
  block) and §6 (a former member's private threads are never transferred; stopping their work is
  bounded by execution leases, not by socket expiry).
- [ADR 0190](0190-a-machine-keeps-a-machine-credential.md): on an org host the threat model's
  out-of-scope attacker (writing `ACE_HOME`, replacing the daemon) is any member who can run code
  there. §1 says which guarantees survive that, and in which phase.
- [ADR 0079](0079-shared-provider-processes.md): on an org host the provider process pool is also
  keyed by the thread's owner.
- [ADR 0155](0155-relay-connect-in-one-round-trip.md)'s early reads: on an org host they answer nothing for
  a member admission.
- [ADR 0115](0115-one-device-one-machine.md), [ADR 0101](0101-work-on-another-machine.md) and
  [ADR 0192](0192-transfers-over-every-machine-route.md): pairing, fleet links and transfers are
  refused between an org host and anything outside its organization, at both ends.

Builds on [ADR 0002](0002-local-cli-providers.md) (providers only through installed, logged-in
CLIs; ace never proxies provider credentials), [ADR 0018](0018-accounts-and-session-portability.md)
(provider account homes, portable handoff), [ADR 0111](0111-account-machine-access.md) (grants,
machine codes), [ADR 0167](0167-spade-security-boundaries.md) and
[ADR 0171](0171-spade-decides-on-effects.md) (decision 2's typed push; amendment 7's Permissions),
[ADR 0170](0170-daemon-never-blocks-on-history-sized-work.md),
[ADR 0182](0182-agents-send-data-to-each-other.md) (parcels) and
[ADR 0198](0198-address-bots-clubs-and-agents-from-a-thread.md) (`@` bots from a thread).

## Context

One daemon serves one person. The person's standing comes only from proof (ADR 0190: a browser
sign-in held by one client, a key in that client's memory, one socket at a time), the machine
answers to one owner (`ace-owner.json`), and every approval, Permissions switch and person-only
action assumes there is exactly one person to ask.

Org hosts (#2432, #2458) bent that only a little. A member's socket is admitted with a format 3
member grant, proves its standing the way a person's does (`provenMemberStanding`,
`apps/daemon/src/account-access/member-grant.ts`), and then reaches Spade and nothing else: the
actor is `spadeOnly` with `read` and `operate` (`relay-hello.ts` `accountDeviceActor`). Owners of
the organization hold the host as an account device does, and its shell (terminal, `files.*`)
needs their proven `host:shell` (`org-socket.ts` `hostShellMessage`).

Coding threads are different in kind. A thread's agent runs a provider CLI that executes commands
on the host, reads files, holds a provider login, pushes with whatever git credentials it can
reach, opens browsers and terminals, and asks for approvals. Two facts decide the design:

1. **On a shared host, every member's agent is the host's OS user** unless ace starts it as
   someone else. Whatever access mode a thread runs in, its provider CLI and its commands can at
   least read most of the disk.
2. **The host's OS user controls the daemon.** It reads `ACE_HOME`, so it holds the host token
   and the daemon's whole local authority. It can write the daemon's database (access rows,
   approvals, the audit outbox), its settings and its code. Every check ace makes on the host is
   made by a process that user can change.

So any member whose agent runs as the host's user can take over the host, and nothing ace checks
over a socket changes that. Only an OS boundary between members' processes and the daemon does.
The design states which guarantees hold without that boundary (phase 1) and which need it
(phase 2), and never claims the second set for the first.

## Decision

### 1. Two kinds of guarantee, and which phase holds which

| Against                                                                          | Phase 1: dedicated host, trusted team                                                                                                                                                                  | Phase 2: member boundary on                                                                                               |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Honest members and intact clients making mistakes (wrong thread, stale tab, bug) | Identity, visibility, owner-only writes, approvals and audit of mediated operations hold (§3–§6)                                                                                                       | Same                                                                                                                      |
| A hostile member who can't run code on the host (read-only in phase 1)           | Holds: everything they reach goes through the one access policy (§4)                                                                                                                                   | Holds                                                                                                                     |
| A hostile member who can run code on the host (a trusted member in phase 1)      | **Nothing on the host holds.** Only what lives elsewhere does: audit checkpoints already sent to WorkOS, other hosts, members' personal machines, the backend, and scopes set at the credential issuer | Identity, reads of others' threads, approvals and audit of mediated operations hold: their code runs as their own OS user |
| The machine's administrators (root), and owners holding `host:shell`             | Never                                                                                                                                                                                                  | Never                                                                                                                     |

**Phase 1's identity, approval and audit guarantees hold only against intact endpoints, never
against a hostile trusted member.** A guarantee that must survive a hostile member belongs to
phase 2.

### 2. Phase 1 is a dedicated, clean host for a trusted team

#### 2.1 What a trusted member's agent can do

Said in these words on the host's trusted list page, the guide and this ADR. A trusted member's
agent, or anything that steers it, can:

- read the host token and act as the host's operator on every surface;
- change the daemon's database, settings and code, and so: answer or skip any thread's approvals,
  write messages and access rows that look like any member's, and read any thread on the host;
- read every member's worktrees, browser profiles and cookies, and the host's provider, forge and
  MCP sign-ins;
- edit or drop audit entries not yet checkpointed, and, where the OS releases the host's
  keychain to its user (Linux Secret Service, ADR 0190), sign new checkpoints with the audit key.
  Checkpoints already sent to WorkOS can't be changed.

#### 2.2 Requirements before members can code

The host refuses to turn on member coding unless:

- **It was enrolled fresh** (ADR 0206 §2.1, "Recommended setup"): no thread, project, browser
  profile or provider, forge or MCP sign-in from before enrollment (`before` in `ace-owner.json`
  owns no tree). A host given to the organization from a person's daily machine can share bots,
  never coding.
- **A machine code is set** (ADR 0111), so a backend-minted grant alone doesn't open it.
- **An org owner confirms the credentials checklist**, recorded as `host.coding_enabled` in the
  audit log: every sign-in on the host is an organization service account, scoped at its issuer;
  the forge token reaches only the organization's repositories, with no admin scope; provider
  accounts are team or API accounts with spending limits; no person's own account, mail or chat.
  ace can check the first two requirements; this one is the owner's word, and the page says so.

#### 2.3 The trusted list

Kept on the host, changed only from an org owner's proven socket, and audited
(`host.trust_changed`). Owners of the organization are on it implicitly. Its page says:

> Trusted members can take over this host. Their agents can read and change everything on it,
> including ace itself, other members' threads, its sign-ins and its recent audit entries. Trust
> only people you would give this machine's administrator password.

Members who aren't trusted read `org` threads and nothing more. Everything they reach goes
through the access policy (§4), and phase 1 protects them fully.

Phase 1 ships anyway because a team that would already share one box loses nothing true, and the
rules it builds (§3–§6) are the ones phase 2 relies on.

### 3. Who is acting

Every request on an org host, on every transport (§4), resolves to one **principal**, decided by
one pure function (`apps/daemon/src/org-access/principal.ts`) from what the caller proved:

| Principal  | How it is proved                                                                                                                                                | What it is                                                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `member`   | A member grant at admission **and** a member standing proven on this socket or request (ADR 0206 §2.2), current, under the owner generation it was proven under | That member's account and role, their trust entry and their execution lease (§7). The only principal that owns trees or writes into them. |
| `host`     | The daemon's token, on a socket or as an HTTP bearer                                                                                                            | The host's operator: runs, updates and triages the daemon. Thread metadata only; owns nothing; answers nothing.                           |
| `agent`    | An ace MCP bearer minted for one tree, bound to that tree and its owner                                                                                         | That tree, for its owner, with at most the owner's rights, and writes only into the owner's own trees (§6).                               |
| `peer`     | A fleet call from another host of the same organization, carrying a child capability (§6.2)                                                                     | Exactly one child of one tree of one owner.                                                                                               |
| `admitted` | A member grant, standing not yet proven or lapsed                                                                                                               | Nothing member-scoped.                                                                                                                    |

- **Admission is not identity.** A member grant is a five-minute bearer token, and anyone
  relaying a socket can replay one (ADR 0190). Every thread-scoped action needs the proven
  standing, and its account must equal the admitted one.
- **The host's operator gets no member content** on any transport, including the app open on the
  host's own desktop until that window proves a member. It can read the disk anyway (§1); ace's
  own surfaces still never hand content to it.
- **Personal machines are unchanged.** There, `principal` returns today's actor and the policy
  allows what today allows.

Member A can't act as member B through ace: B's grant replayed fails the proof, which names this
socket's nonce and channel binding, and every write needs the owner's proof (§5.2). In phase 1
that holds only for intact endpoints (§1).

### 4. One access policy for every transport

#### 4.1 The entry points, as they are on origin/main (read 2026-11-21)

| Entry point                    | Where                                                                                                                                  | How it is checked today                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| JSON socket messages           | `server.ts` `receive`: `hostShellMessage`, then each service's `handle`                                                                | Scopes, `canReadThread(device, …)`; members `spadeOnly`                                                                                     |
| Binary frames                  | `server.ts` `receive` hands them to each service's `binary` (`services/browser.ts`, `services/files.ts`, `services/machine-tunnel.ts`) | **Before** the JSON checks; only "is there a device"                                                                                        |
| NK early reads                 | `relay-nk/early-reads.ts` `answerEarly`, called during hello (`server.ts`)                                                             | `canRead` on a thread, **before** confirmation and before any standing can be proven                                                        |
| Dedicated channels             | hello `channel` (tunnel, files, browser)                                                                                               | Refused to non-owner members                                                                                                                |
| Fan-out                        | broadcasts and subscriptions (`receiveBroadcasts`), notices, push                                                                      | Per device                                                                                                                                  |
| Attachments and uploads (HTTP) | `attachments-http.ts`, `attachments-upload.ts`                                                                                         | Own bearer (`auth.deviceBearer`, `auth.localBearer`) and `canReadThread(device.id, …)`, keyed by device: the host's bearer reads any thread |
| Previews (HTTP)                | `preview-http.ts`, `html-preview.ts`                                                                                                   | Own bearer                                                                                                                                  |
| ace MCP                        | `mcp.ts`: per-thread leases and `addAuthenticator`                                                                                     | Lease names a thread                                                                                                                        |
| Outside MCP clients            | `external-mcp/` (ADR 0122)                                                                                                             | Own principals, grants and OAuth                                                                                                            |
| Machine calls                  | fleet links and the machine tunnel (`machine-tunnel/`), parcels (`parcels/`), transfers (`transfers/`, incl. `http.ts`)                | ADR 0105 grants, `TargetThreads.owns` per calling device                                                                                    |
| Spade                          | `spade.http` proxy, `POST /v1/thread-asks`                                                                                             | Member stamp, daemon signature                                                                                                              |
| Pairing                        | `fleet.request pairing`, `POST /v1/pairings`, redemption; old paired credentials in `devices`                                          | Person bit per link; old devices keep machine-level scopes                                                                                  |

#### 4.2 The rule

- **One policy, deny by default.** `apps/daemon/src/org-access/` holds
  `decide(principal, operation, resource)`. On an org host every entry point above resolves its
  caller through `principal.ts` and asks `decide` before it reads or acts. An entry point that
  can't name a principal, an operation `decide` doesn't know, or a resource it can't place is
  denied. A new message type, HTTP route, channel or MCP tool is closed to members until someone
  classifies it.
- **Order.** On an org host the decision runs before any service's `handle` or `binary`. A binary
  frame is taken only on a channel whose opening request `decide` allowed, and only for the
  resource that opening named.
- **Early reads.** On an org host `answerEarly` answers nothing for a member admission; its
  subscribes wait for confirmation and a proven standing.
- **HTTP.** The bearer resolves to a principal like a socket does. The host's bearer is `host`,
  so it gets no member attachment, upload or preview. A member's HTTP request carries a proof for
  that request (ADR 0190 §6's intent proof shape, over method, path and body digest), since HTTP
  has no socket to have proven on.
- **Bound to a canonical tree.** Every handle is bound at creation to one tree's root id, fixed
  then and never re-derived from a later path or id: file streams and uploads, terminals,
  browser sessions, pages and profiles, MCP bearers, preview tokens, parcels, provider sessions,
  automation runs and fleet child capabilities. `decide` checks the handle's root, not what a
  later request says.
- **Access loss invalidates live handles.** A narrowed visibility, a lapsed standing, a revoked
  member, a transfer or a stop ends every live handle of that principal on that tree:
  subscriptions dropped (`thread.access.lost`), streams aborted, terminals closed, browser
  sessions detached, MCP leases and preview tokens revoked.
- **Queued effects are rechecked when they run.** A queued message or steer, a scheduled
  automation run, an approval answer in flight, a delegated child's start, an outbox send: each
  records the principal that queued it and is checked against current access and that owner's
  execution lease (§7) right before it runs. One that fails is dropped with a notice to its owner.
- **Pairing and moves are refused at both ends.**
  - An org host makes no pairing links and redeems none.
  - Turning member coding on revokes every paired device credential on the host (ADR 0115
    revocation, not only standing), so no older bearer reads members' threads.
  - Fleet links and transfers between an org host and a machine outside its organization are
    refused by the org host as issuer and as receiver. A personal machine refuses a link or
    transfer whose peer's signed owner is an organization. An older personal daemon doesn't
    check, so the org host's refusal is what holds, and a test covers that mix.
- **One test table** (§Tests) runs every entry point against every principal on another member's
  resource.

### 5. Threads

#### 5.1 Ownership and visibility

A thread tree has one **owner**, the member whose proven socket started it, and one
**visibility**. Both belong to the root and are inherited by every descendant, so a tree's status
(working, waiting, done) is always read whole by whoever reads it, and AGENTS.md priority 1 holds
for every reader.

| Visibility          | Who reads it through ace                |
| ------------------- | --------------------------------------- |
| `org`               | every member with standing on this host |
| `members` (phase 2) | the owner and the members named         |
| `private` (phase 2) | the owner only                          |

- **No role reads more.** Admins and owners of the organization read by visibility, like anyone.
- **Default.** `org` in phase 1, the only visibility it offers. From phase 2, `private`, unless
  the organization's policy sets `org`.
- **Sharing** is the owner's, from a proven socket; each change is stored and audited (§5.4).
  Narrowing ends access at once (§4.2). What was already received stays on the reader's device;
  the share menu says so ("They keep what they've already seen").

#### 5.2 Only the owner writes into a tree

Anything that can change what a tree executes is the owner's alone, in both phases: messages,
steers and queued messages, answers to approvals, questions, plans and browser help, access mode
and model, terminals, edits to its worktree's files, input to its browser pages, its MCP and
automation settings. A tree's processes run as its owner (as the owner's OS user in phase 2,
§9.2). No `act` right exists: in phase 2 it would let B make A's processes run B's commands as A.

Others still help:

- **Work on this.** A reader starts their own tree from a shared one. It is owned by them, runs as
  them on their credentials (phase 2: their OS user), and gets only that tree's data: a clone of
  its branch at a commit the reader picks, and ace's portable context of the shared transcript
  (ADR 0018). Its visibility starts no wider than the source's. The source tree's page lists it.
- **Stop.** The owner, and owners of the organization (§5.5), may stop a tree. A stop changes
  nothing a tree runs next; it halts it.
- **Approvals while the owner is away** wait for the owner. A tree waiting on its owner says so
  to its readers, and stays waiting, never done.

#### 5.3 Where it is kept

- A daemon table, `thread_access (root_id PRIMARY KEY, owner, visibility, readers, changed_at,
changed_by)`, written from an event, `thread.access.changed`, in the same transaction. Additive:
  a new table, nothing to fill, no index on an existing table (ADR 0170).
- **Threads from before enrollment** keep their person (ADR 0206 §2.1). Enrollment writes the
  previous owner's account into `ace-owner.json` (`{kind: "org", org, generation, before}`). A
  tree with no access row is read as owned by `before`, `private`, with no rewrite. A host with
  such trees can't turn member coding on (§2.2).
- **Enforced on the host, offline.** Decisions read this table, the caller's proof and the
  member roster (§7.2), all local. The backend is never asked per decision. New sockets need
  grants, which need the backend; that is availability, not access.

#### 5.4 The audit log, for what ace mediates

The daemon writes each entry into an outbox in the same transaction as the change, and forwards
it in order into Spade's signed, chained host log (ADR 0206 §4.2) and on to WorkOS; a restart
resends what wasn't confirmed, and Spade deduplicates by the entry's id.

**Coverage is what ace mediates**: operations that go through ace's own surfaces. A command an
agent runs itself (a raw `git push`, a `curl`, a provider's own tool) isn't seen. In phase 1 a
trusted member can also forge or drop entries before the next checkpoint (§2.1).

| Action                                       | Actor              | Targets               | Metadata (never titles, messages or file names)       |
| -------------------------------------------- | ------------------ | --------------------- | ----------------------------------------------------- |
| `thread.started`                             | member             | thread, project, host | visibility, provider account id, access mode          |
| `thread.shared`, `thread.unshared`           | member (the owner) | thread, members       | visibility before and after                           |
| `thread.forked`                              | member             | thread, source        | source commit                                         |
| `thread.transferred`                         | admin              | thread, from, to      | reason (`owner_left`)                                 |
| `thread.stopped_by_owner`                    | org owner          | thread                |                                                       |
| `thread.deleted`                             | member, org owner  | thread                | visibility, whether its owner had left                |
| `thread.full_access_raised`                  | member             | thread                |                                                       |
| `host.coding_enabled`, `host.trust_changed`  | org owner          | host, member          | before and after                                      |
| `member.revoked_seen`, `member.work_stopped` | host               | member                | roster version, what was stopped                      |
| `forge.action`                               | member             | repo, ref or number   | `push` (§9.3), `pr_create`, `merge`, `review_comment` |

A title is content: a private thread's title in a log the admins read would break §5.1.

#### 5.5 What others may know about a tree they can't read

- Admins and owners of the organization see, per member, **counts**: trees running, waiting and
  idle; their processes' CPU and memory; disk used. No titles, projects of private trees,
  branches or output.
- Owners of the organization may **stop** any running tree from that view without reading it
  (`thread.stopped_by_owner`; the tree's owner is told who stopped it).
- Search, `threads_find`, notifications, the Inbox, unread counts and push all go through `read`.

### 6. Agents and children

#### 6.1 On the host

- An agent's ace MCP calls run as `agent` for its tree. Reading another tree (`thread_read`,
  `threads_find`, `handoff_read`, parcels) needs its owner's `read`. Writing into a tree
  (`agent_message`, `thread_control`, `queue_edit`) is allowed only into the owner's own trees.
- `delegate` makes children in the same tree, with its owner and visibility.
- `@` a bot from an org thread (ADR 0198) reaches only the shared bots the owner may `talk` to.
- Agents never answer approvals (AGENTS.md), unchanged.

#### 6.2 On another host of the organization

A child on another machine is allowed only on another host of the same organization; on a
personal machine it is refused. Its authority is a **child capability**:

```
{ v: 1, kind: "org-child", org, from, to, root, owner, child, iat, exp, nonce }
```

- Signed by the parent host's **fleet key**, an Ed25519 key in its keychain, registered with the
  backend at enrollment beside the audit key (`org_hosts.fleet_key`) and served in the roster
  (§7.2), so the destination verifies it offline.
- It names one child of one tree of one owner, and expires in ten minutes. The parent host renews
  it only while that owner's execution lease (§7.1) is live.
- The destination accepts a call (start, status, message, parcel, cancel) only with a capability
  that names itself, its organization, that child and an owner active in its own roster, and runs
  the child as that owner (phase 2: the owner's OS user there). Cancel needs the capability too,
  so no other tree's parent can cancel it.
- An expired capability, or an owner the destination's roster shows revoked, stops the child
  there on the destination's own clock (§7), whether or not the parent host is reachable.

### 7. Execution leases and stopping work

#### 7.1 Leases

Every running tree, terminal, automation run and remote child holds an **execution lease** for its
owner, kept on the host, lasting 15 minutes. The host renews it only on a roster (§7.2) at most
two minutes old that shows the owner active. A tree whose lease runs out is stopped (§7.3),
marked "Stopped · couldn't confirm Arpan is still in Acme", and resumes when the owner next sends
from a proven socket.

**The outage trade-off.** A host that can't reach the backend can't renew. The policy's
`threads.offline_minutes` (default 60, at most 1,440) lets it renew on the last roster it holds
for that long after the roster's time; then work stops. Lower is stricter, so the key only
narrows. A longer allowance keeps work running through outages; a shorter one stops a removed
member's work sooner while the host is cut off.

#### 7.2 The roster and durable revocation

- **The roster** is the organization's member list as the backend signs it for this host:
  `{v: 1, kind: "org-roster", org, host, version, at, members: [{account, status, role}],
hosts: [{id, fleet_key}]}`, signed with the grant key, `version` increasing. The host fetches
  it with its organization credential every 60 seconds and on a relay nudge
  (`GET /v1/orgs/{org}/hosts/{hostId}/roster`). It never takes a lower version, so an old one
  can't be replayed to bring a removed member back. It also carries names and verified emails
  for display and git authorship (§9.3).
- **Revocation is durable.** When a roster shows a member not `active`, the host writes
  `member_revocations (account, version, seen_at)` in one transaction with an audit entry, then
  stops their work. Only a later roster showing them active clears it.
- **Reconciliation.** On start, after every roster and every 60 seconds, the host stops anything
  running whose owner is revoked or whose lease ran out: trees, terminals, browser sessions,
  automation runs, process groups and remote children. A missed nudge or a restart only delays
  that to the next pass.

#### 7.3 Containment

A provider's interrupt isn't enough: a process of the same user can leave its process group and
outlive it.

- **Linux:** each tree runs in its own systemd scope, made by the system manager without
  delegation, so its processes can't move out of its cgroup. Stopping kills the cgroup.
- **Phase 2, every OS:** each member's processes run as their OS user, so stopping all of a
  member's work is killing that user's processes, which no process of theirs can escape.
- **Phase 1 on macOS:** best effort (process group, session and descendant tracking). The host
  page says so.
- **Not contained, and not promised:** what has already left the host (pushes, comments, messages
  sent), and work a provider runs on its own servers.

#### 7.4 The clock

T0 is when WorkOS deactivates or deletes the membership (ace's Remove does it at once; for a
directory, when WorkOS applies the directory's change, which ace doesn't control).

| Bound                        | When, from T0                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| No new member grant          | ≤ 60 s: the backend's org check is reused for 60 s, and WorkOS refuses the next refresh (ADR 0206 §1.4)                                    |
| The host sees the revocation | ≤ about 3 min while online: the events consumer's minute plus the host's 60 s roster poll                                                  |
| Contained work stopped       | At the revocation pass that sees it, so ≤ about 3 min online; offline, by lease expiry: ≤ `offline_minutes` + 15 min after the last roster |
| Open sockets closed          | ≤ 60 s + 5 min + 30 s: the last grant's lifetime plus ADR 0111's grace, which starts at that grant's expiry                                |

The promise is scoped to what §7.3 contains and to a host whose daemon is intact; in phase 1 a
trusted member can stop the host from enforcing it (§1).

### 8. Policy keys

The organization's policy (ADR 0206 §3), which only narrows, gains one block:

```json
"threads": {
  "enabled": true,
  "default_visibility": "private",
  "full_access": "trusted",
  "offline_minutes": 60,
  "personal_provider_accounts": false
}
```

`enabled: false` refuses new coding threads on the organization's hosts. `full_access` is `never`,
`owners`, `trusted` (phase 1: owners and the trusted list) or `members` (phase 2 only).
`personal_provider_accounts` is phase 2 (§9.1). A host applies the lower of the policy and its
own setting.

### 9. Providers, git and the member boundary

#### 9.1 Whose account runs a member's thread

A provider CLI keeps its login in its home on disk or in the OS keychain, and ace never touches
it (ADR 0002, ADR 0018). ADR 0002 also forbids ace proxying a provider credential, so ace can't
hold an organization's key and lend it to a member's process. A third way, the CLI on the
member's machine with its tools on the host, isn't something the CLIs do.

- **Phase 1: the host's own provider accounts.** An org owner signs the host in through each
  CLI's own login, ideally a team or API account with a spending limit (§2.2; a personal
  subscription shared by a team is what ADR 0205's terms record warns about). Members pick among
  the accounts an owner marks for members; usage per member is shown to admins as counts and
  quota. Since every trusted member can read these logins (§2.1), they are scoped at the issuer.
- **Phase 2: a login inside the member's OS user.** The host's own accounts stay the host
  user's, unreadable to members' processes, and aren't used by members' threads, since lending
  them would mean copying them into a member's reach or proxying them. A member signs a provider
  CLI in from their own terminal on the host, inside their OS user's home (mode 0700): their seat
  on the organization's team plan (recommended), or their own personal login if the policy's
  `personal_provider_accounts` allows. The account page says: "Your login is kept on Acme's host.
  This machine's administrators can read it. Sign out here when you're done."

#### 9.2 The member boundary

Each member gets an OS user on the host, and everything started for that member runs as it: the
provider CLI and every command its agent runs, the tree's terminals, the member's browser
profile, their worktrees and their logins. `ACE_HOME`, the host's own sign-ins and the daemon
stay the host user's, mode 0700.

- **The helper.** `ace-member-host`, installed once by the machine's administrator (as Locked use
  installs its helper), does only this on the daemon's request: make or lock a member user, start
  a process as one with a fixed argv, environment and working folder, and stop a member user's
  processes. Requests come over a Unix socket only the daemon's user may open.
- **Collision-free users.** The helper keeps `account → uid` in its own table, allocating from a
  reserved range after checking the system's users and groups. A uid is never reused, even after
  the member leaves, since their files may remain. Each member user has its own primary group and
  no other.
- **Dropping privilege, verified.** Before running a member's program the helper clears its
  supplementary groups, sets the gid and then the uid, sets no-new-privileges, and checks that
  real, effective and saved ids and the group list are the member's and can't be regained. It
  closes every descriptor but the three it passes (`close_range`), builds the environment from an
  allowlist and starts in the member's tree. Any check that fails starts nothing.
- **No privileged reads of member paths.** A member controls their worktree, so a path inside it
  can be a link to the host's files. The daemon never opens a member's path with its own rights.
  It reads and writes member files through a reader process started as that member (diffs, file
  views, uploads, previews), which opens with traversal-safe calls (Linux `openat2` with
  `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS`; macOS `O_NOFOLLOW_ANY`) under the tree's root. The
  helper resolves a working folder the same way before using it.
- **Linux first, then macOS** (`dscl`, `posix_spawn` after the checks above), **Windows later**
  with its own ADR. Provider CLIs must be installed where member users can run them; the host's
  setup page checks.

**A same-user sandbox is not the boundary.** Processes of one user still see each other:
`/proc/<pid>/environ` holds each agent's ace MCP bearer, signals and debugging cross on Linux
kernels before Landlock's scoping, macOS hands the login keychain (where provider CLIs keep
tokens) to the user's processes, and macOS refuses a sandbox inside the sandbox providers apply.
A separate user closes these with what every OS already enforces.

#### 9.3 Git identity and pushing

- **Authorship is a default.** A tree's processes get `GIT_AUTHOR_*` and `GIT_COMMITTER_*` from the
  owner's name and verified email in the roster. An agent can change them, and a commit can name
  anyone; author fields prove nothing, and ace never treats them as who did something.
- **Phase 1** pushes with the host's forge sign-in, the team service account. A trusted member's
  agent can read that token and push anything it allows, so its scope is set at the forge
  (§2.2). Pushes ace makes for a member go through ace's forge actions and are audited; raw pushes
  aren't seen (§5.4).
- **Phase 2:** the host's forge token stays the host user's. A member's tree pushes through a
  **scoped operation**, the typed push of ADR 0171 decision 2: the tree's commits are fetched
  into a clean repository the host user owns and pushed from there, hooks and configuration left
  out, only to the project's remotes and only to branches under the tree's own prefix
  (`ace/<member>/…`), never forced. Each one is a `forge.action` audit entry with the member and
  the commits. A member may add their own forge sign-in inside their OS user; pushes with it are
  theirs and ace doesn't see them.
- Shared MCP servers with sign-ins follow the same rule: phase 1 shares them, named on the
  project page; phase 2 offers members only those exposed through scoped tools, plus their own.

#### 9.4 Projects and worktrees

- **A project on an org host is shared**: its checkout, remotes and settings are visible to
  every member (ADR 0206 §2.4). Admins (`hosts:manage`) add and remove projects.
- **Every member tree runs in its own worktree.** Working in the project checkout itself is
  refused to members' trees.
- **Phase 1**: `git worktree`s of the project's repository under `worktrees/<member>/<id>`; their
  commits sit in the shared object store, which is fine while every tree is `org`.
- **Phase 2**: each member's worktrees are their own clones, owned by their OS user, made by a
  process as that user from the project repository (read-only to members) with `--reference`, so
  objects aren't copied twice and unpushed commits are theirs.

#### 9.5 Transfers drain and rebind

An admin's transfer of a departed member's `org` or `members` tree (§11):

1. stops the tree and its remote children, revokes every handle, lease, MCP bearer and child
   capability bound to it (§4.2);
2. has a process as the old owner commit any uncommitted changes to a transfer commit and write
   a git bundle;
3. makes the new owner's clone from that bundle, as the new owner;
4. continues on the new owner's provider account through ace's portable context handoff, since a
   provider-native session lives in the old owner's home and doesn't move (ADR 0018), and says
   what was lost;
5. writes `thread.transferred`.

Nothing is changed in place, so no file the old owner controlled is opened with the new owner's
or the host's rights.

### 10. Surfaces

| Surface                                      | Phase 1                                                                                                                     | Phase 2                                           |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Provider session                             | Per tree, as the host's user, on the host's accounts; one provider process serves one member (ADR 0079 pool keyed by owner) | As the owner's OS user, on their own login (§9.1) |
| Approvals, questions, plans, browser help    | The owner only, from a proven socket (`answer-gate.ts` takes the principal); never the host or an agent                     | Same                                              |
| Transcript, diff, worktree files             | `read` to view; the owner to edit                                                                                           | Same, through the member's reader (§9.2)          |
| Terminal in a tree                           | Its owner, if trusted (it is the host's shell)                                                                              | Its owner, as their OS user                       |
| Host files and terminal outside trees        | Org owners' `host:shell` only, as today                                                                                     | Same                                              |
| Browser pages (ADR 0199)                     | One profile per member, bound to their trees; help goes to the owner                                                        | Same, owned by the member's OS user               |
| MCP servers                                  | The host's, shared, named on the project page; ace's own tools as §6                                                        | Scoped tools plus the member's own                |
| Forge through ace                            | The host's sign-in; the owner only; audited                                                                                 | Scoped push and actions (§9.3); audited           |
| Attachments, uploads, previews               | Through §4: `read` to fetch, the owner to add                                                                               | Same                                              |
| Automations                                  | Owned by their maker; runs are their trees, under their lease                                                               | Same                                              |
| Computer use (`screen_*`) and simulators     | **Refused** for coding trees                                                                                                | **Refused**                                       |
| Full access                                  | As policy allows, up to `trusted`; each raise audited                                                                       | Up to `members`, inside the member's OS user      |
| Moving trees off the host, cross-space links | **Refused** at both ends (§4.2)                                                                                             | **Refused**                                       |
| Pairing                                      | **Refused**; old paired credentials revoked                                                                                 | **Refused**                                       |

**Computer use is refused** because an org host has one screen, one input queue and one desktop
session: an agent driving it sees and steers whatever other members' work has open, and ADR 0171
amendment 7's switches and never-use list are a person's settings with no member in them. Shared
bots keep ADR 0206 §2.3's rules.

**Approvals and switches.** Provider approvals are the provider's own, answered in the composer;
the change is who may answer. ADR 0171 amendment 7's Permissions belong to Spade bots and stay as
ADR 0206 §2.3 has them. Coding trees have their access mode under the policy ceiling.

**Who may start a tree.** `code:use`, a new permission in the `member` role and above, plus, in
phase 1, being on the host's trusted list (owners always are); in phase 2, the member boundary on
the host. `code:use` is separate from `bots:use` (ADR 0206 §2.4 said `bots:use`), so an
organization can share bots without sharing a coding host.

### 11. Members leaving

| What                                 | What happens                                                                                                                                                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Their work on the host               | Stopped by §7: trees, terminals, automations, browser sessions and remote children, marked "Stopped · owner left Acme". Nothing shows done.                                                                                                     |
| Their sockets                        | Close by §7.4's bound.                                                                                                                                                                                                                          |
| Their queued effects                 | Dropped at their recheck (§4.2).                                                                                                                                                                                                                |
| Their `org` and `members` trees      | Kept. An admin may transfer one (§9.5).                                                                                                                                                                                                         |
| Their `private` trees (phase 2)      | Kept, unreadable through ace. Org owners may delete one. **Never transferred**: a transfer to oneself would be an owner reading a private tree.                                                                                                 |
| Their OS user (phase 2)              | Locked, its processes killed. The home is kept until an org owner deletes it (audited); ace deletes nothing on its own.                                                                                                                         |
| Their logins on the host (phase 2)   | ace runs each CLI's own sign-out for their homes, best effort: some CLIs only delete the local file, and only the provider can revoke a token. The departure notice tells the member and the admins to revoke it at the provider and the forge. |
| The host's shared sign-ins (phase 1) | A departed trusted member could have copied them. The notice lists them for the owners to rotate.                                                                                                                                               |
| Reactivation                         | A newer roster lifts the revocation; trees stay stopped until the owner resumes them.                                                                                                                                                           |

### 12. What ace can't promise, and how it says so

- **The host's administrators and `host:shell` read everything on its disk.** "Private" means
  private through ace and from other members, never from them. Under Private the share menu says:
  "Only you, through ace. Acme's owners and this machine's administrators can still read its
  disk."
- **In phase 1, trusted members can take over the host** (§2.3's words). The composer on such a
  host says once: "Everyone in Acme can read threads here, and trusted members can change
  anything on this host."
- **What was seen stays seen.** Unsharing ends access to what comes next.
- **Pushed work and sent messages are outside ace.** Visibility says nothing about who reads a
  pushed branch, and stopping a member can't undo what already left.
- **Audit covers what ace mediates** (§5.4), and authorship is a default (§9.3).
- **Signing out isn't revoking** (§11).
- **A compromised backend can mint a member's grant and sign a roster** (ADR 0111's consequence);
  a machine code stops a grant alone, and a roster only narrows what a host runs or names who it
  stops, except that it can mark someone active.

### 13. Clients

- On an org host every cache key holding thread data includes the space and the proven member's
  account, so a browser used by two members in turn never draws one's threads for the other.
- The threads list: the member's own trees first, then trees shared with them, with the owner's
  face. A tree the member doesn't own shows "Only Arpan can write here." and **Work on this**.
- The share control in the thread header (Private, Some members, Everyone in Acme), each with
  §12's sentence.
- iPhone: reading, answering in owned trees, the share control and Work on this; trusted lists
  and per-member load stay on desktop and web.

### 14. Threats

| Threat                                                       | What holds                                                                                                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A trusted member, hostile, in phase 1**                    | Nothing on the host (§1, §2.1). Bounded by: a dedicated clean host, issuer-scoped credentials, checkpoints already in WorkOS, other hosts' own rosters and leases. |
| **A acts as B over ace** (replayed grant, relayed socket)    | Proven standing on every transport; HTTP requests carry a per-request proof (§4.2).                                                                                |
| **A answers B's approval, or steers B's agent**              | Writes are the owner's alone (§5.2); agent principals write only into their owner's trees (§6.1).                                                                  |
| **B uses a shared tree to run code as A** (phase 2)          | No `act`; Work on this runs as B on B's credentials with only that tree's data.                                                                                    |
| **A reads B's thread through a side door**                   | One policy over every entry point of §4.1, binary frames and early reads included; handles bound to their tree; host bearer gets no content.                       |
| **Access lost, handle kept**                                 | Live handles invalidated; queued effects rechecked when they run.                                                                                                  |
| **A's agent reads B's work or the host from disk** (phase 2) | Separate OS users; `ACE_HOME` and host sign-ins 0700; no privileged reads of member paths; traversal-safe opens.                                                   |
| **The helper misused**                                       | Socket only the daemon's user opens; fixed operations; collision-free uids; verified privilege drop; descriptors closed; folders resolved under the member's tree. |
| **A forged or replayed fleet call**                          | Child capabilities: one child, one owner, ten minutes, checked against the destination's own roster, needed for cancel too.                                        |
| **Pairing or a move as a way out**                           | Refused at issuer and receiver; old paired credentials revoked.                                                                                                    |
| **Two members on one provider process**                      | Pool keyed by owner.                                                                                                                                               |
| **An admin or org owner reads a private tree**               | No role adds `read`; no transfer of private trees; counts-only load view; titles never audited.                                                                    |
| **A removed member's work keeps running**                    | Durable revocation, reconciliation, expiring leases, cgroup or per-user containment (§7); bound stated with its outage trade-off.                                  |
| **A removed member's tokens left on the host**               | Best-effort CLI sign-out plus a notice to revoke at the provider; in phase 1, shared sign-ins listed for rotation.                                                 |
| **Faked authorship**                                         | Author fields are a default only; audit names the member only for operations ace mediated.                                                                         |
| **Backend unreachable**                                      | Decisions are local; work runs on the offline allowance, then stops.                                                                                               |
| **Backend compromised**                                      | Can mint grants and mark someone active; machine codes stop a grant alone; it can't sign packages, rewrite checkpoints or reach personal machines.                 |
| **Root or the machine's administrators**                     | Out of scope; said (§12).                                                                                                                                          |

## Phases

1. **A dedicated host for a trusted team, `org` trees only.** §2's requirements and trusted list;
   principals and the one access policy over every entry point (§3, §4); `thread_access`,
   owner-only writes, Work on this, audit of mediated operations (§5); agents and child
   capabilities (§6); rosters, leases, revocation and Linux cgroup containment (§7); the policy
   block without `personal_provider_accounts`; host accounts and host forge sign-in; per-member
   browser profiles; the pool keyed by owner; departures; clients. **Done when:** three members on
   a staging org host run trees in one project for a week; an untrusted member can't open,
   subscribe to, fetch, write into or search a tree beyond its visibility on any entry point;
   every share, fork, transfer and stop has a verified audit entry; a removed member's contained
   work stops within §7.4's online bound and their sockets close within its socket bound.
2. **The member boundary and private trees.** `ace-member-host` on Linux, then macOS; per-member
   clones, readers, terminals, browser profiles and processes as the member's OS user; scoped
   push; logins inside the member's user; `private` and `members` visibility, `private` the
   default; departures' phase 2 rows. **Done when:** on a Linux org host, a full-access agent in
   A's tree can't read B's worktree, B's provider home, `ACE_HOME` or B's processes' environment,
   can't signal B's processes, can't push outside its prefix and can't make the daemon read a
   linked path, checked by process tests with real users; and the same on macOS.
3. **Later.** Windows member users (own ADR); FGA if per-project rights are asked for (ADR 0206
   §2.6); moving trees between a member's own machine and an org host under policy; delegation
   across spaces.

## Tests

Behaviour through public surfaces, at the right tier.

- **Pure (fast tier):** `decide` over a table of principals (owner, reader, admin, org owner,
  host, agent of the same owner and of another, peer with a good, expired or other-child
  capability, former member, `admitted`) and operations, including the tree read as `before`'s;
  an unclassified operation is denied; `answer-gate`'s new cases; the start rule; the policy
  block only narrows; lease renewal and the offline allowance; a lower roster version is ignored;
  a capability for one child refuses another.
- **Daemon, entry points (process; one table-driven file):** a real daemon as an org host, a local
  backend Worker minting grants and rosters, two member clients with their own device keys, the
  host token, an agent bearer. Each of §4.1's entry points is tried by each principal against
  another member's tree: JSON messages, a binary frame on a channel opened for another tree, an
  NK early read before proof, a dedicated channel, fan-out, attachment and upload with the host
  bearer, a preview, ace MCP, an outside MCP client, a parcel, a transfer, a thread ask, a pairing
  request and an old paired device. All refused.
- **Daemon, lifecycle (process):** narrowing ends a subscription and a terminal and an open file
  stream; a queued message from a member revoked before it runs is dropped; a restart keeps every
  access decision and every revocation; a roster that drops a member stops their tree, a process
  that left its process group inside the tree's cgroup included (Linux), and nothing shows done;
  an offline host stops work at the allowance; two members never share a provider process; audit
  rows survive a crash between the daemon's commit and Spade's confirmation and appear once.
- **Two hosts (process):** a child runs on a capability; a parent from another tree can't cancel
  it; it stops on its own host when the capability lapses or the destination's roster revokes the
  owner, with the parent host unreachable.
- **Member boundary (process, Linux in a container with real users; macOS on the Mac):** the
  helper's privilege drop (ids, groups, no-new-privileges, descriptors); A's command can't read
  B's worktree, B's provider home, `ACE_HOME` or B's `environ`, or signal B; a symlink in A's
  worktree to a host file isn't followed by a diff, a file view, an upload or a preview; a folder
  outside A's tree is refused; a scoped push outside the prefix or forced is refused; a transfer
  opens nothing of the old owner's with another user's rights.
- **Clients (jsdom):** two members in turn in one browser never see each other's cached threads;
  the share menu's and trusted list's sentences are the ones §12 and §2.3 give; a tree the member
  doesn't own shows the read-only line and Work on this.
- **On WorkOS staging, by hand, before each phase ships:** §7.4's bounds measured from a removal.

## Options considered

- **Private trees in phase 1 without the boundary.** Rejected: any trusted member's agent could
  read them from disk.
- **No member coding until phase 2.** Simpler to explain; rejected as the first slice only because
  phase 1 now promises nothing a hostile trusted member could break, and the rules it builds are
  needed either way. This is owner decision 1.
- **An `act` right for collaborators.** Rejected: in phase 2 it would let B run commands as A
  (§5.2).
- **A same-user sandbox as the boundary.** Rejected (§9.2).
- **Lending the host's provider accounts to members' isolated processes.** Rejected: it means
  copying a credential into a member's reach or ace proxying it, which ADR 0002 forbids.
- **One daemon per member on the host.** Rejected: shared projects, shared bots, one audit log and
  one relay registration per host would each be rebuilt across daemons, and the member boundary
  gives the same OS separation with one daemon.
- **Socket expiry as the stop for a removed member.** Rejected: sockets aren't the work. Leases,
  rosters and containment are.
- **The provider CLI on the member's machine, tools on the host.** Not something the CLIs do.
- **Admins read private trees for compliance.** Rejected by ADR 0206 §2.4; an organization that
  needs that sets `default_visibility: "org"`.
- **FGA for thread rights.** Rejected for now: rights must hold with the backend unreachable
  (ADR 0206 §2.6).

## Consequences

- An org host becomes multi-user. Every new entry point, message type, route or MCP tool must be
  classified in `decide` or it is closed to members.
- The daemon gains `thread_access`, `member_revocations`, leases, an audit outbox and a roster
  cache, all additive.
- The backend gains the roster route, `org_hosts.fleet_key` and the `code:use` permission in
  ace's role table.
- Phase 1 org hosts must be fresh, dedicated machines with issuer-scoped credentials; a person's
  daily machine given to an organization can share bots, never coding.
- Phase 2 adds a privileged helper installed by the machine's administrator, the first ace
  component that starts processes as other users.
- Org hosts with members cost more processes (one provider process per member per account) and,
  in phase 2, more disk (a clone per member, objects shared).

## Decided

The owner took each recommendation below on 2026-11-21. Phase 1 is built first; phase 2 follows
its phase gate.

1. **Phase 1: a dedicated, clean host for a trusted team.** Recommended: yes. Only owners and
   members on the host's trusted list code; the list says they can take over the host; every tree
   is `org`; the host must be enrolled fresh, have a machine code and run on issuer-scoped
   service accounts. Its identity, approval and audit guarantees hold only against intact
   endpoints. The alternative is no member coding until phase 2.
2. **The member boundary is one OS user per member,** through a small privileged helper, Linux
   first. Recommended: yes, rather than a same-user sandbox.
3. **Provider accounts: the host's own in phase 1; in phase 2, a login inside each member's OS
   user**, ideally their seat on the organization's team plan, with personal logins only if
   the policy allows. The host's own accounts aren't lent to members' isolated processes in phase 2. Recommended: yes.
4. **Admins see per-member load, and org owners may stop any tree without reading it.**
   Recommended: yes, with no titles anywhere.
5. **A former member's private trees are never transferred, only kept or deleted.** Recommended:
   yes. This changes ADR 0206 §6.
6. **Computer use stays refused for coding trees on org hosts.** Recommended: yes, in every phase.
7. **Pushing: the host's issuer-scoped forge sign-in in phase 1; in phase 2 a scoped push from a
   clean repository, to the tree's own branch prefix, never forced,** plus optional personal forge
   sign-ins. Authorship is a default, never proof. Recommended: yes.
8. **Only a tree's owner writes into it; others start their own tree from it.** Recommended: yes.
   It replaces the `act` right of the first draft.
9. **When the host can't reach the backend, members' work keeps running for
   `threads.offline_minutes` (default 60) on the last roster, then stops.** Recommended: yes, 60
   minutes; an organization may lower it.

## Verification

None yet: this is a design. Each phase's done line is its verification.

## Amendment 1 (2026-11-21): §7 as built in phase 1

Decided while building §7 (#2527) and after its two security reviews. Each is the simplest safe
choice.

- **Containment is under the user's systemd manager, so it stops accidental escapes, not a hostile
  member.** §7.3 asks for a scope made by the system manager. An unprivileged daemon can't make
  one: the system manager needs root or polkit's `manage-units`, which is the administrator's by
  default. So each member tree's provider processes start inside a transient scope under a slice
  of the tree's own, nested in the member's (`systemd-run --user --scope`, no delegation), in it
  before any of their code runs; a scope that can't be made starts nothing. A stop kills the tree's slice and counts only on positive word: systemd saying the slice doesn't exist, or the kernel's cgroup for it read as empty, or absent from where systemd makes it. A cgroup that can't be read stays unconfirmed. The slice is in the host user's own systemd tree, which that user can write, so a
  process set on leaving it can. That matches §1: against a hostile trusted member nothing on
  the host holds in phase 1. It contains dev servers, daemonizing tools and `setsid`. Needs
  systemd 254 or later.
- **macOS, phase 1:** a member's processes are their sessions' process groups, which a stop
  kills. Best effort, as §7.3 says.
- **The roster carries an epoch and, per member, when WorkOS made their state.** The epoch is the
  backend's restore generation, `ACE_ROSTER_EPOCH`, a Worker secret kept outside D1 so a restore
  can't lower it. It is never assumed: unset or malformed, no roster is served
  (`roster_epoch_unset`). The database records the epoch of each roster it versioned; a Worker
  whose epoch is behind that serves none (`roster_epoch_behind`), and a higher one starts a new
  series. **A restore of the accounts database must raise the epoch** before the Worker serves
  again (runbook: `docs/release/workers.md`). A host refuses a lower epoch, versions compare
  within one, the same version is taken again only with the same body, and a revocation is
  lifted only by a roster showing the member active in a state WorkOS made after the revoking
  one, so even a restore without the bump can't bring a removed member back.
- **The backend versions and dates one committed snapshot.** A roster's members, hosts and last
  version are read in one transaction. Serving the same version again, or taking the next, both
  happen only while the members are still at that snapshot's revision; the roster is dated with
  the snapshot's read time, never the time of signing.
- **The offline allowance is for transport failure only.** No TCP or TLS answer, or no headers in time. Once headers arrive the backend has answered: a refusal is refused before its body is read, and a body that stalls or is cut short earns only the two-minute window too. Every HTTP answer is the backend's word and earns only the two-minute window:
  a refusal, the origin's own contention (503 `busy`), an unset or behind epoch, a proxy's or the
  edge's 5xx, a redirect (never followed). Someone on the path who drops the backend's replies
  gets the bounded outage behaviour (allowance plus a lease) by design; one who forges an answer
  gets less. Leases run on a clock that never goes back and never runs slower than the monotonic
  clock; a host whose clock starts behind the last time it recorded renews nothing on a roster
  from before the restart. A lease that ran out is stopped, never renewed.
- **Every call that makes work holds the lease.** A session open (before spawn, also a resume),
  every input, every answer to a provider's request and every goal takes or renews the owner's
  lease first, and is refused past an expired one, while a stop is under way, or on a tree a stop
  ended. Nothing on that path clears a stop: not an engine continuation, a retry, an automation
  or a send whose origin is unknown. Only the owner's own proven input does, which the access
  policy passes on (`MemberWork.resume`) when it admits a command from a socket that proved that
  member's standing.
- **A stop is pending until confirmed, tree by tree.** It is recorded before anything is torn
  down. Every affected tree is fenced at once, then each tree's teardown runs on its own within a
  bound, so one that hangs holds back neither the others nor the next pass. It counts only once
  the tree's sessions are closed (retained ones too), its slice is confirmed empty and every child
  it delegated to another host is confirmed ended by that machine. Every affected tree's teardown and its containment kill start together and are each bounded, so processes die even while a session close hangs; a tree whose try outlives the bound is tried again by the next pass.
- **A member's child on another host carries its owner and a deadline that host enforces.** The delegate call names the member and how long the child may run (the offline allowance plus a lease), counted on the destination's own clock from when it makes the child. The destination records that deadline in the transaction that makes the child, tears the child down by it without hearing from the source, and refuses it any further work; nothing renews it. A target that doesn't know the field refuses the call. On the source, a stop stays pending until the destination confirms the child ended, or until that deadline (plus a pass and a stop's bound there) has passed. A delegation is recorded before it is sent. One the target refused, or that never left, holds nothing; one whose answer was lost after it may have arrived is kept, with its target and request id, until the target says: a probe asks without making a child, names it if there is one (it then gets the cross-machine stop), and otherwise withdraws the request there, so a late copy of the original is refused too. A child that lands after the stop gets the cross-machine stop at once. The fixed deadline caps a member's remote child at the allowance plus a lease in phase 1; renewable child capabilities (§6.2) replace it.
- **A member stop reads failed, with why.** Thread status has no interrupted state, and a
  deliberate stop reads done. So what was unsettled ends as failed with "Stopped · its owner is
  no longer in this organization" (or "…couldn't confirm…"), recorded for the whole tree before
  anything is awaited.
- **The gate.** Before a provider process is spawned, before anything that makes it run work
  reaches it, and before work is delegated to another host, an owned thread's owner must be able
  to run work here. Who owns a thread is a resolver that answers none on personal machines and
  for the host's own threads; the access policy fills it in from `thread_access`.
