# 0209: Members of an organization work in projects and threads on one shared org host

Status: proposed. Date: 2026-11-21. Asked for by the owner (2026-11-21: build ADR 0206 §2.4's
phase 3, coding threads on org hosts). Nothing here is built until the owner approves it; the
decisions that need the owner are listed at the end, each with a recommendation.

Amends:

- [ADR 0206](0206-organizations-on-workos.md) §2.2 (what a member may do on an org host), §2.4
  (made concrete; private threads wait for the member boundary, §5), §3 (four narrowing policy
  keys) and §6 (a former member's private threads are never transferred).
- [ADR 0190](0190-a-machine-keeps-a-machine-credential.md): on an org host the threat model's
  "out of scope" list (writing `ACE_HOME`, replacing the daemon) is in scope for every member
  but its owners, because members' agents run on the same machine. §2 says what holds that line.
- [ADR 0079](0079-shared-provider-processes.md): on an org host the provider process pool is also
  keyed by the thread's owner.

Builds on [ADR 0002](0002-local-cli-providers.md) (providers only through installed, logged-in
CLIs), [ADR 0018](0018-accounts-and-session-portability.md) (provider account homes),
[ADR 0111](0111-account-machine-access.md) (grants, machine codes),
[ADR 0167](0167-spade-security-boundaries.md) and [ADR 0171](0171-spade-decides-on-effects.md)
amendment 7 (Permissions switches), [ADR 0170](0170-daemon-never-blocks-on-history-sized-work.md)
(no history-sized work at open), [ADR 0182](0182-agents-send-data-to-each-other.md) (data along
the agent tree), [ADR 0186](0186-the-daemon-outlives-the-app.md) and
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
needs their proven `host:shell` (`org-socket.ts` `hostShellMessage`). Shared bots carry their own
access lists inside Spade, and an answer for one carries a member stamp.

Coding threads are different in kind. A thread's agent runs a provider CLI that executes commands
on the host as the host's operating-system user, reads files, holds a provider login, pushes with
whatever git credentials the host has, opens browsers and terminals, and asks for approvals. Two
members' threads on one daemon make the daemon multi-user, and the honest starting fact is this:

**On a shared host, every member's agent is the host's OS user.** Whatever access mode a thread
runs in, its provider CLI and the commands it runs can at least read most of the disk. That
includes `ACE_HOME` (the host token, so the daemon's whole local authority), every other
member's worktree, every provider login and every forge sign-in on the machine. ADR 0190 can call
that reader out of scope because on a personal machine it is the person. On an org host it is
any member's agent, steered by anything the agent read. Nothing ace checks over a socket closes
that. Only an OS boundary between members does.

So the design has two parts that can ship apart:

- **Who is acting**, and what each of them may do through ace, enforced on the host. This is
  needed whatever the OS does.
- **The member boundary**: an OS-level separation between members' processes, without which
  "private" would be a word, not a fact.

## Decision

### 1. Who is acting

Every socket and every request on an org host resolves to one **principal**, decided once per
message by one pure function (`apps/daemon/src/org-threads/principal.ts`) from what the socket
proved:

| Principal  | How it is proved                                                                                                                                                     | What it is                                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `member`   | A member grant at hello **and** a proven member standing on this socket (`account.standing`, ADR 0206 §2.2), current, under the owner generation it was proven under | That member's account, role and the host's trust list entry (§4). The only principal that owns or acts on threads. |
| `host`     | The daemon's token file on loopback (`hostCredential()` in `server.ts`)                                                                                              | The host's OS user: runs, updates and triages the daemon. Never a member, owns nothing, answers nothing.           |
| `agent`    | An ace MCP bearer the daemon minted for one thread's agent                                                                                                           | That thread, acting for its owner with at most the owner's rights, never `act` on another member's tree (§3.5).    |
| `machine`  | A machine grant or a fleet link (ADR 0105)                                                                                                                           | Another machine. On an org host, only another host of the same organization, for its own delegated children.       |
| `admitted` | A member grant at hello, standing not yet proven or lapsed                                                                                                           | Nothing member-scoped: the welcome, `account.standing`, Spade's main channel as today.                             |

- **Admission is not identity.** A member grant is a five-minute bearer token; ADR 0190 already
  refused standing from bearer tokens because anyone relaying a socket can replay one. Every
  thread-scoped action needs the proven standing, and its account must equal the admitted one
  (`server.ts` checks this for the member branch of `account.standing` today).
- **Standing lapses close the door, not just the socket.** When a member socket's standing runs
  out without a fresh proof, the daemon drops every thread subscription that socket holds and
  sends `thread.access.lost {threadId, reason: "standing"}`; ADR 0111's grace then closes it.
  A client proves again every few minutes, as today, so this is silent in normal use.
- **The host token is an operator, not a member.** On an org host it may run the daemon, change
  host Settings that its owners may change, update and triage. It gets thread metadata (§3.4),
  never a member thread's content, and never answers an approval, question, plan or browser-help
  request. It can read the disk, and §6 says so; ace's own surfaces still never hand member
  content to it, so the app open on the host's own desktop shows a member's threads only after
  that window proves a member's standing like any other client.
- **Paired devices on an org host** carry no member. Pairing links on org hosts are refused,
  and devices paired before enrollment lost their standing when the owner changed (ADR 0190 §3a);
  they keep machine-level access only. The iPhone joins an org host through the account route
  (ADR 0206 §1.5).
- **Personal machines are unchanged.** On a machine whose owner is a person, `principal` returns
  today's actor and every rule below answers "allowed" for it, so nothing on the personal path
  moves.

**Member A can never act as member B** because the only principal that acts is `member`, and
its account comes from a grant naming A's account, A's device key and this host, signed over this
socket's nonce and channel binding. B's grant, replayed, fails the proof. B's answers need B's
proof. A's agent holds a bearer that names A's thread, and §3.5 keeps it inside A's trees.

### 2. Deny by default on member sockets

Today a member socket reaches Spade only. Widening it to threads is done by an allowlist, not by
removing the `spadeOnly` check:

- `apps/daemon/src/org-threads/member-messages.ts` lists each client message type a member
  socket may send on an org host, with **how its thread is found** (`threadOf(message)`:
  `message.threadId`, a turn's thread, a subscription scope's thread, a project for listing) and
  **the right it needs** (`read`, `act`, `share`, `start`, `stop`).
- A message type not on the list is refused on a member socket with `forbidden`, whatever it is.
  A new message type is therefore closed to members until someone classifies it.
- One check in `server.ts`'s dispatch, beside today's `hostShellMessage` check, runs the
  principal and the list before any service sees the message. Services keep their
  `canReadThread` checks; on an org host `canReadThread` is this rule's `read`.

### 3. Threads

#### 3.1 Ownership and visibility

A thread tree has one **owner**, the member whose proven socket started it, and one
**visibility**. Both belong to the root and are inherited by every descendant: a child never
differs from its root, so a tree's status (working, waiting, done) is always read whole by
whoever reads it, and AGENTS.md priority 1 holds for every reader.

| Visibility          | Who reads it through ace                | Who acts in it (message, steer, stop, answer, queue) |
| ------------------- | --------------------------------------- | ---------------------------------------------------- |
| `org`               | every member with standing on this host | the owner, and members the owner names with `act`    |
| `members` (phase 2) | the owner and the members named         | the owner, and named members given `act`             |
| `private` (phase 2) | the owner only                          | the owner only                                       |

- **No role reads more.** Admins and owners of the organization read a thread only by
  visibility, like anyone else. ADR 0206 §2.4 stands.
- **Default.** `org` in phase 1, the only visibility it offers. From phase 2 the default is
  `private` (ADR 0206 §2.4), and the organization's policy may set it to `org` (§3.6).
- **Who may share.** Only the owner, from a proven socket. Each change is stored and audited
  (§3.3).
- **Narrowing is immediate.** When visibility narrows or a member's `act` is removed, the daemon
  ends that member's subscriptions to the tree at once (`thread.access.lost`) and stops their
  pending writes. What they already received stays on their device: ace can't unsend it, and the
  share menu says so ("They keep what they've already seen").
- **Threads from before enrollment** keep their person (ADR 0206 §2.1: "they stay theirs"). The
  enrollment writes the previous owner's account into `ace-owner.json`
  (`{kind: "org", org, generation, before}`). A tree with no access row is read as owned by
  `before`, `private`, with no rewrite of any thread (ADR 0170). Until phase 2 those trees are
  readable by their person only, and only once that person proves a member's standing on the host;
  if `before` isn't a member, nobody reads them through ace.

#### 3.2 Where it is kept

- A daemon table, `thread_access (root_id PRIMARY KEY, owner, visibility, readers, actors,
  changed_at, changed_by)`, written from an event, `thread.access.changed`, in the same
  transaction, so a restart reads what was decided and an event replay rebuilds it. The migration
  is additive: a new table, no default to fill, no index on an existing table.
- **Enforced on the host, offline.** Every decision reads this table and the socket's proven
  grant, both local; the backend is never asked. While the backend is unreachable, members whose
  grants are current keep working and the rules still hold. New sockets can't open once grants
  run out (minting a grant needs the backend), which is availability, not access. Running work
  never stops for that.
- **The rights function** is pure and small: `threadRights(principal, access, membership)` in
  `apps/daemon/src/org-threads/rights.ts` returns `{read, act, share, stop}`. Every surface in §4
  calls it; nothing else decides.

#### 3.3 The audit log

The daemon writes its rows through Spade's loopback API into the host's signed, chained log
(ADR 0206 §4.2), and from there to WorkOS. Because the daemon and Spade are separate stores, the
daemon writes each audit entry into an outbox in its own transaction with the change, and
forwards it in order until Spade confirms; a restart resends what was not confirmed, and Spade
deduplicates by the entry's id.

| Action                                                   | Actor               | Targets               | Metadata (never titles, messages or file names)     |
| -------------------------------------------------------- | ------------------- | --------------------- | --------------------------------------------------- |
| `thread.started`                                         | member              | thread, project, host | visibility, provider account id (§5.2), access mode |
| `thread.shared`, `thread.unshared`, `thread.act_changed` | member (the owner)  | thread, members       | visibility before and after                         |
| `thread.transferred`                                     | admin               | thread, from, to      | reason (`owner_left`)                               |
| `thread.stopped_by_owner`                                | org owner           | thread                |                                                     |
| `thread.deleted`                                         | member or org owner | thread                | visibility, whether its owner had left              |
| `host.trust_changed`                                     | org owner           | member, host          | before and after (§4.1)                             |
| `thread.full_access_raised`                              | member              | thread                | right used                                          |
| `forge.action`                                           | member              | repo, number          | action (`pr_create`, `merge`, `review_comment`)     |

A title is content: a private thread's title in an audit log the admins read would break §3.1,
so no thread entry carries one.

#### 3.4 What others may know about a thread they can't read

Running agents share one machine's CPU, memory, disk and provider quota, so the host's admins
need to see load without seeing work:

- Admins and owners of the organization see, per member, **counts**: trees running, waiting and
  idle; their processes' CPU and memory; disk used by their worktrees. No titles, projects of
  private threads, branch names or provider output.
- Owners of the organization may **stop** any running tree from that view, without reading it
  (`thread.stopped_by_owner`, audited, and the thread's owner is told who stopped it). They hold
  the host's shell and could kill the processes anyway; this way the stop is clean and recorded.
- Search, `threads_find`, notifications, the Inbox, unread counts and push all pass through
  `read`. A push for a private thread goes only to its owner's devices.

#### 3.5 Agents and other threads

- An agent's ace MCP calls run as principal `agent` for its thread. Reading another thread
  (`thread_read`, `threads_find`, `handoff_read`, parcels of ADR 0182) needs its owner's `read`
  on that thread. Acting on another tree (`agent_message`, `thread_control`, `queue_edit`) is
  allowed only within the owner's own trees, whatever `act` the owner holds elsewhere, so a
  prompt in A's thread can't steer B's agent through A's rights.
- `delegate` makes children in the same tree (inherited owner and visibility). A child on another
  machine is allowed only on another host of the same organization; on a personal machine it is
  refused (cross-space, ADR 0206 §8). Delegating from a personal machine to an org host is refused
  in these phases.
- `@` a bot from an org thread (ADR 0198) reaches the shared bots the owner may `talk` to and
  nothing else; the context pack is built only from the thread itself.
- **Agents never answer approvals** (AGENTS.md) holds unchanged.

#### 3.6 Policy keys

The organization's policy (ADR 0206 §3), which only narrows, gains one block:

```json
"threads": {
  "enabled": true,
  "default_visibility": "private",
  "full_access": "trusted",
  "personal_provider_accounts": false
}
```

`enabled: false` refuses new coding threads on the organization's hosts. `full_access` is
`never`, `owners`, `trusted` (owners and the host's trusted members, §4.1) or `members` (phase 2
only). `personal_provider_accounts` is phase 2 (§5.2). A host applies the lower of the policy and
its own setting.

### 4. Surfaces

#### 4.1 Who may start a coding thread on a host

Starting a thread needs `code:use`, a new permission in the `member` role (and every role above
it), and one of:

- the host has the **member boundary** (§5) on, or
- the member is an owner of the organization, or
- an org owner put the member on the host's **trusted list**.

The trusted list is kept on the host, set only from an org owner's proven socket, and audited
(`host.trust_changed`). It exists because without the boundary a member's agent can do whatever
the host's shell can: the list's page says it in those words ("Trusted members' agents can read
and change everything on this host, including other members' work and the host's sign-ins"). It
makes visible a trust that would otherwise be given without anyone saying so.

`code:use` is separate from `bots:use`, so an organization can share bots without sharing a
coding host. ADR 0206 §2.4 said `bots:use`; this ADR replaces that.

#### 4.2 Per member, shared, or refused

| Surface                                      | Phase 1 (no member boundary)                                                                                                                             | Phase 2 (member boundary on)                                                                             |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Provider session (the agent)                 | Per thread, on the host's own provider accounts (§5.2); one provider process never serves two members (§4.3)                                             | Per member, as the member's OS user, on the host's accounts or (if policy allows) the member's own login |
| Approvals, questions, plans, browser help    | Answered only by the thread's owner or a member with `act`, from a proven socket (`answer-gate.ts` gains the principal); the host token and agents never | Same                                                                                                     |
| Transcript, diff, worktree files of a thread | `read` to view, `act` to edit                                                                                                                            | Same                                                                                                     |
| Terminal in a thread                         | Trusted members and owners, for threads they `act` in (it is the host's shell)                                                                           | Any member with `act`, running as the thread owner's OS user                                             |
| Host files and terminal outside threads      | Org owners' `host:shell` only, as today                                                                                                                  | Same                                                                                                     |
| Browser pages (ADR 0199)                     | One browser profile per member; a member's cookies and sign-ins never reach another member's threads; browser help goes only to the owner                | Same, the profile owned by the member's OS user                                                          |
| MCP servers                                  | The host's configured servers, shared, with their sign-ins (said in the project's page); ace's own MCP tools scoped as §3.5                              | Per member configuration added beside the host's                                                         |
| Forge (PRs, reviews, merges through ace)     | The host's forge sign-in; ace's own forge actions need `act` and are audited (`forge.action`)                                                            | The member's own forge sign-in if they add one, else the host's                                          |
| Attachments and uploads                      | `read` to fetch, `act` to add                                                                                                                            | Same                                                                                                     |
| Automations                                  | Owned by the member who made them; their runs are threads owned by that member; paused when the member leaves                                            | Same                                                                                                     |
| Computer use (`screen_*`) and simulators     | **Refused** on org hosts for coding threads                                                                                                              | **Refused**                                                                                              |
| Full access                                  | Owners and trusted members, as policy allows (`full_access`); each raise audited                                                                         | As policy allows, up to `members`, since it runs inside the member's OS user                             |
| Moving a thread off the host (ADR 0101/0192) | **Refused**                                                                                                                                              | **Refused**; a policy key later                                                                          |
| Pairing links                                | **Refused**                                                                                                                                              | **Refused**                                                                                              |

**Computer use is refused** because an org host has one screen, one input queue and one desktop
session for everyone: a member's agent driving it sees and steers whatever other members' work
has open, and the never-use list and Permissions switches (ADR 0171 amendment 7) are a person's
settings with no member in them. Spade's shared bots keep their own rules (ADR 0206 §2.3); this
refusal is about coding threads.

**Approvals and switches per member.** Provider approvals are the provider's own (each thread's
access mode, answered in the composer); the only change is who may answer, above. The Permissions
switches of ADR 0171 amendment 7 belong to Spade bots: on an org host they are the shared bots'
and stay as ADR 0206 §2.3 has them, set by an owner or admin. Coding threads have no switch of
their own beyond their access mode and the policy ceiling.

#### 4.3 Shared provider processes

ADR 0079 shares one provider process across an account's threads, and its frame router falls back
to "every channel receives the frame" when it can't read a frame's ancestry. On an org host two
members' threads on one process would make that fallback a leak. **On an org host the pool key
includes the thread's owner**, so a process serves one member's threads only. It costs a process
per active member per account, which is the price of the rule.

### 5. Providers, git and the member boundary

This is the hard part, so it starts with what can't be done.

#### 5.1 Why a member's own provider login can't simply run there

A provider CLI keeps its login in its home on disk (or the OS keychain), and ace never touches it
(ADR 0002, ADR 0018). Running member A's own login on the host means A's provider token sits on a
machine that:

- every other member's agent can read, since they are the same OS user (phase 1);
- the host's administrators can read, whatever ace does (always).

The first makes a member's subscription every member's. The second is the same as ADR 0206 §2.4's
disk warning. A third option, running the CLI on A's own machine while its tools act on the
host's files, isn't something the CLIs do: they run their tools where they run.

#### 5.2 Whose account runs a member's thread

- **Phase 1: the host's own provider accounts only.** An org owner signs the host in to each
  provider through the CLI's own login, as ADR 0018 accounts on the host, ideally the provider's
  team or API plan (the setup page says why: a personal subscription shared by a team is the case
  ADR 0205's terms record warns about). ADR 0002 holds as written: ace drives installed, logged-in
  CLIs and holds no credential; the party logged in is the organization. Members pick among the
  accounts an owner marks for members. Usage per member is shown to admins (counts and quota, not
  content), so a member draining a shared account is visible.
- **Phase 2: the member's own login, opt-in, inside their OS user.** With the member boundary on
  and `personal_provider_accounts` allowed by policy, a member may sign in a provider CLI on the
  host from their thread's terminal. Its home lives in their OS user's home, mode 0700, which
  other members' agents and the host's own user can't read. The account page says plainly:
  "Your login is kept on Acme's host. Its administrators can read it. Sign out here when you're
  done; ace signs it out when you leave Acme." ace never moves, copies or reads it.

#### 5.3 Git identity and whose token pushes

- **Authorship is the member's.** A thread's processes get `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`,
  `GIT_COMMITTER_NAME` and `GIT_COMMITTER_EMAIL` from the member's name and verified email in the
  host's member directory (below). That is attribution, not security: an agent can override it,
  and forges show the pusher separately.
- **Pushing is the host's sign-in in phase 1**, the team service account ADR 0206 §2.1 recommends,
  as shared bots already do. The project page says "Pushes from this host use acme-bot".
- **Phase 2:** a member may add their own forge sign-in inside their OS user, used for their
  threads only, under the same warning as §5.2.
- **The member directory** is a cache on the host of the organization's members (account, name,
  verified email, status), fetched with the host's organization credential
  (`GET /v1/orgs/{org}/hosts/{hostId}/members`, a new backend route) on connect and on a relay
  nudge when the mirror changes. It is for display, attribution and noticing a departure (§7). It
  never authorizes: that is always the socket's proven grant.

#### 5.4 Projects and worktrees

- **A project on an org host is shared**: its checkout, its remotes and its project settings are
  visible to every member (ADR 0206 §2.4). Admins (`hosts:manage`) add and remove projects; a
  member can't, so what the host clones with its sign-ins is the organization's choice.
- **Every member thread runs in its own worktree.** Working in the project checkout itself is
  refused to members' threads on an org host: two members' agents in one working tree overwrite
  each other, and every reader of the project would see either one's files.
- **Phase 1** worktrees are `git worktree`s of the project's repository, under
  `worktrees/<member>/<id>`. Their commits and branches live in the shared object store, so any
  member's agent can read them; that is fine while every thread is `org`.
- **Phase 2** a member's worktrees are their own clones (`git clone --reference` the project's
  repository, read-only to members, so objects aren't copied twice), owned by their OS user, so
  their unpushed commits are theirs. The daemon reads them through a group it shares with each
  member user, which is the same as the host's shell reading them (§6).

#### 5.5 The member boundary

**Each member gets an OS user on the host** (`ace-m-<8 hex of the account>`), and everything
started for that member runs as it: the provider CLI and every command its agent runs, the thread
terminal, the member's browser profile and their worktrees. `ACE_HOME`, the host's provider homes
and its forge sign-ins stay the host user's, mode 0700. Then:

- a member's agent can't read another member's work, the host token or the host's sign-ins, even
  in full access;
- a private thread is private from every other member and every member's agent. The host's own
  user (who holds `host:shell`) and the machine's administrators can still read it, as §6 says.

How it is built:

- A small privileged helper, `ace-member-host`, installed once by an administrator of the machine
  (the way Locked use installs its helper), does only three things on the daemon's request: make
  or lock a member user, start a process as one with a fixed argv, environment and working
  folder, and stop a member user's processes. Its requests come over a Unix socket only the
  daemon's user may open, and it checks that a working folder lies under that member's tree.
- **Linux first** (always-on team boxes are mostly Linux): users made with `useradd --system`,
  processes started under a systemd scope per member, so stopping a member stops all of theirs.
  **macOS** next: users through `dscl`, processes through the helper's `posix_spawn` after
  `setuid`. **Windows** later, with its own ADR.
- Provider CLIs must be installed where member users can run them; the host's setup page checks
  and says which aren't.

**A same-user sandbox was considered and is not the boundary.** Running each member's agent in
ADR 0167's sandbox as the host's user would deny file reads, but processes of one user still see
each other: `/proc/<pid>/environ` (which holds each agent's ace MCP bearer), signals and debugging
on Linux kernels before Landlock's scoping, the login keychain on macOS (where provider CLIs keep
tokens), and macOS refuses a sandbox inside a sandbox, which providers' own sandboxes need. A
separate user closes all of these with what every OS already enforces.

### 6. What ace can't promise, and how it says so

- **The host's shell and the host's administrators read everything on its disk.** Org owners hold
  `host:shell`, the host's OS user and the machine's administrators hold more. "Private" means
  private through ace and from other members, never from them. The share menu says, under
  Private: "Only you, through ace. Acme's owners and this machine's administrators can still read
  its disk." Setup, the host page and the guide say private work that must stay private belongs on
  members' own machines.
- **Without the member boundary, members' agents read each other's work.** Phase 1 offers no
  private visibility for that reason, and the composer on such a host says once, above the first
  message: "Everyone in Acme can read threads on this host."
- **What was seen stays seen.** Unsharing ends access to what comes next.
- **Pushed work is the forge's.** Visibility in ace says nothing about who reads a pushed branch.
- **A compromised backend can mint a member's grant** for any account, as it can mint a person's
  (ADR 0111). A machine code on the host stops a grant alone; it is recommended for every org host
  and the enroll page asks for one.
- **Shared sign-ins are shared.** The host's provider accounts, forge sign-in and MCP servers'
  sign-ins act for whoever's thread uses them; the project and account pages name them.

### 7. Members leaving

When the host learns a member is gone (their grants stop; the member directory, nudged by the
backend's events consumer, shows them removed, `inactive` or deprovisioned by the directory):

| What                            | What happens                                                                                                                                                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Their sockets                   | Close when their standing lapses (ADR 0206 §6: at most five minutes plus 30 s).                                                                                                                                                                                    |
| Their running trees             | Interrupted, as a user stop does (ADR 0079: the tree first, never its neighbours), and marked "Stopped · owner left Acme". Nothing is shown as done.                                                                                                               |
| Approvals they owned            | Withdrawn with the stop. Requests in trees where they were only an `act` member stay open for the others.                                                                                                                                                          |
| Their `org` and `members` trees | Kept. An admin may transfer one to another member (`thread.transferred`), who can then resume it.                                                                                                                                                                  |
| Their `private` trees (phase 2) | Kept, unreadable through ace. Org owners may delete one (`thread.deleted`). **Never transferred**: a transfer to oneself would be an owner reading a private thread, which §3.1 forbids.                                                                           |
| Their automations               | Paused, kept; an admin may transfer them with the trees they make.                                                                                                                                                                                                 |
| Their OS user (phase 2)         | Locked and its processes stopped. Each provider CLI's and forge CLI's own sign-out runs for their homes, so their tokens are revoked by the tool that holds them. The home itself is kept until an org owner deletes it (audited); ace deletes nothing on its own. |
| Reactivation                    | Undoes the lock; trees stay stopped until the member resumes them.                                                                                                                                                                                                 |

This changes ADR 0206 §6's line for phase 3 ("an owner may transfer them") to the table above.

### 8. Clients

- The space switcher (ADR 0206 §1.5) is unchanged. On an org host, every cache key that holds
  thread data includes the space **and the proven member's account**, so a browser used by two
  members in turn never draws one's threads for the other.
- Threads list on an org host: the member's own trees first, then trees shared with them, each
  row with its owner's face for others' trees. The share control sits in the thread's header:
  Private, Some members, Everyone in Acme, with the sentence from §6 under each.
- The thread owner's face and "Shared by …" appear on trees a member reads but doesn't own;
  without `act`, the composer is replaced by one line: "Only Arpan can write here."
- iPhone: reading, answering in owned and `act` trees, and the share control; host trust and
  per-member load stay on desktop and web.

### 9. Threats

| Threat                                                    | What holds                                                                                                                                                                                                        |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A acts as B over ace** (replayed grant, relayed socket) | Thread actions need proven member standing: B's grant with A's proof fails, and a proof names this socket's nonce and Noise handshake hash (ADR 0190 §3).                                                         |
| **A answers B's approval**                                | `answer-gate.ts` takes the principal: only the owner or an `act` member, from a proven socket. Agents and the host token never.                                                                                   |
| **A reads B's private thread through ace**                | `read` on every surface through one rights function; unclassified message types refused on member sockets (§2); fan-out, search, push and notices filtered by `read`.                                             |
| **A's agent reads B's work or the host token from disk**  | Phase 1: possible, so no private threads exist and only owners and trusted members code (§4.1). Phase 2: separate OS users; `ACE_HOME` and host sign-ins 0700 to the host user.                                   |
| **A's agent steers B's agent**                            | Agent principals act only within their owner's own trees (§3.5).                                                                                                                                                  |
| **Two members on one provider process**                   | Pool keyed by owner on org hosts (§4.3).                                                                                                                                                                          |
| **An admin or org owner reads a private thread**          | No role adds `read`; transfer of private trees refused; the load view carries counts only; audit entries carry no titles.                                                                                         |
| **The host token, or the app on the host's own desktop**  | Operator only: metadata, never content or answers, until that window proves a member.                                                                                                                             |
| **Prompt injection in an `org` thread**                   | As on any machine: the provider's access mode and approvals. Full access is policy-limited, and in phase 1 only owners and trusted members have it, who hold the shell anyway.                                    |
| **Cross-member browser sign-ins**                         | One browser profile per member; browser help only to the owner.                                                                                                                                                   |
| **Shared MCP server sign-ins**                            | Shared by design in phase 1 and named on the project page; per-member configuration in phase 2.                                                                                                                   |
| **A departed member's agents keep pushing**               | Their trees are interrupted on departure; their OS user locked in phase 2.                                                                                                                                        |
| **A departed member's tokens left on the host**           | Phase 1 has none (host accounts only). Phase 2 runs each CLI's sign-out and locks the user.                                                                                                                       |
| **Backend unreachable**                                   | Rules read only local state and the proven grant; running work continues; new sockets wait for grants.                                                                                                            |
| **Backend compromised**                                   | Can mint member grants (ADR 0111's consequence); a machine code stops a grant alone; it can push a policy, which only narrows.                                                                                    |
| **The `ace-member-host` helper misused**                  | Socket open only to the daemon's user; fixed operations; working folders checked against the member's tree; a reader of `ACE_HOME` is already the host user, who could start processes as itself, not as members. |
| **Root or the host's administrators**                     | Out of scope: they read and change everything. Said in §6.                                                                                                                                                        |

## Phases

1. **Org-visible threads for a trusted team.** Principals and the member allowlist (§1, §2);
   `thread_access`, ownership, `org` visibility, `act` lists, audit (§3); `code:use` and the host's
   trusted list (§4.1); answers by owner and `act` only; per-member browser profiles; the pool
   split by owner; host provider accounts and host forge sign-in with member authorship (§5);
   worktree per thread; departures (§7, first five rows); the policy block without
   `personal_provider_accounts`; clients (§8). No private or `members` visibility, no member
   boundary. **Done when:** three members on a staging org host each run threads in one project
   for a week; none can open, subscribe to, answer in or search another's tree beyond its
   visibility; every share, transfer and stop has a verified audit entry; a removed member's
   trees stop and sockets close within six minutes.
2. **The member boundary and private threads.** `ace-member-host` on Linux, then macOS; per-member
   clones, terminals, browser profiles and processes as the member's OS user; `private` and
   `members` visibility, with `private` the default; per-member provider and forge sign-ins under
   policy; departures' phase 2 rows. **Done when:** on a Linux org host, an agent in full access
   in A's thread can't read B's worktree, B's provider home, `ACE_HOME` or B's processes'
   environment, checked by a process test with real users; and the same on macOS.
3. **Later.** Windows member users (own ADR); FGA if per-project rights are asked for (ADR 0206
   §2.6); moving a thread between a member's own machine and an org host under policy; delegation
   across spaces.

The smallest safe slice is phase 1 because it promises only what one OS user can keep: everyone
on the host reads everything, and ace makes sure everyone knows who is acting and who allowed it.

## Tests

Behaviour through public surfaces, at the right tier.

- **Pure (fast tier):** `threadRights` over a table of principals (owner, reader, `act` member,
  admin, org owner, host token, agent of the same and of another owner, former member,
  `admitted` without standing) and visibilities, including the tree with no access row read as
  `before`'s; the member allowlist refuses a message type it doesn't list; `answer-gate`'s new
  cases; the start rule (`code:use` with and without boundary, trusted list, owner); the policy
  block's narrowing (a host never loosens past it).
- **Daemon (process, one file for the wiring):** a real daemon as an org host, a local backend
  Worker minting member grants, two member clients with their own device keys. B's client can't
  subscribe to, read, attach to, answer in or search A's tree; A's `org` tree appears for B and
  its composer refuses B's message until A gives B `act`; narrowing ends B's subscription with
  `thread.access.lost`; a lapsed standing drops subscriptions; the host token gets metadata only
  and its answer is refused; A's agent's `agent_message` to B's tree is refused; a restart keeps
  every access decision; two members' threads never share a provider process (fake provider
  CLI); a departure interrupts the tree and nothing shows done; audit rows survive a crash
  between the daemon's commit and Spade's confirmation and appear once.
- **Member boundary (process, Linux, in a container with real users; macOS on the Mac):** an
  agent command run as A's member user can't read B's worktree, B's provider home, `ACE_HOME`,
  or B's processes' environment, and can't signal B's processes; stopping A stops all of A's
  processes; a working folder outside A's tree is refused by the helper.
- **Clients (jsdom):** two members in turn in one browser never see each other's cached
  threads; the share menu's sentences are the ones that match what the daemon enforces; a tree
  without `act` shows the read-only line.
- **On WorkOS staging, by hand, before each phase ships:** a removed member's threads stop and
  their sockets close within six minutes.

## Options considered

- **Private threads in phase 1 without the boundary.** Rejected: any member's agent could read
  them from disk, so the label would be false.
- **Members' coding threads only after the boundary.** Possible, and simpler to explain; rejected
  as the first slice because teams that already trust each other with one box lose nothing true
  under phase 1, and the per-socket rules it builds are needed either way.
- **A same-user sandbox as the boundary.** Rejected as the boundary (§5.5); still used for what
  it already does in ADR 0167.
- **One daemon per member on the host.** Each member's own daemon under their own OS user, the
  host's daemon only routing. Rejected: shared projects, shared bots, one audit log and one relay
  registration per host would each be rebuilt across daemons, and the member boundary gets the
  same OS separation with one daemon.
- **Members' own provider logins in phase 1.** Rejected (§5.1).
- **The provider CLI on the member's own machine, tools on the host.** Not something the CLIs do.
- **Admins read private threads for compliance.** Rejected by ADR 0206 §2.4. An organization that
  needs that sets `default_visibility: "org"` and doesn't offer private.
- **FGA for thread rights.** Rejected for now: rights must hold with the backend unreachable, and
  they live where the threads are (ADR 0206 §2.6).

## Consequences

- An org host becomes multi-user. Every new client message type must be classified for member
  sockets or it is closed to them.
- The daemon gains `thread_access`, an audit outbox and a member directory cache, all additive.
- The backend gains one route (the host's member directory) and the `code:use` permission in
  ace's role table.
- Phase 2 adds a privileged helper installed by a machine administrator, the first ace component
  that starts processes as other users.
- Org hosts with members cost more processes (one provider process per member per account) and
  more disk in phase 2 (one clone per member, objects shared).

## For the owner

1. **Phase 1 without the member boundary, as "a trusted team".** Recommended: yes. Members code
   only if an org owner puts them on the host's trusted list, which says their agents can read the
   whole host; everything is org-visible. The alternative is no member coding until phase 2.
2. **The member boundary is one OS user per member,** through a small privileged helper, Linux
   first. Recommended: yes, rather than a same-user sandbox, which leaks between processes of one
   user.
3. **Providers on org hosts: the organization's accounts only in phase 1; members' own logins
   opt-in in phase 2,** inside their OS user, with "this machine's administrators can read it".
   Recommended: yes. The stricter alternative is never allowing personal logins on org hosts.
4. **Admins see per-member load (counts, CPU, memory, disk) and org owners may stop any thread
   without reading it.** Recommended: yes, with no titles anywhere.
5. **A former member's private threads are never transferred, only kept or deleted.** Recommended:
   yes. This changes ADR 0206 §6, which let owners transfer them.
6. **Computer use stays refused for coding threads on org hosts.** Recommended: yes, in every
   phase, until a host has a desktop per member.
7. **Pushes use the host's forge sign-in, with the member as author.** Recommended: yes for phase
   1; members' own forge sign-ins in phase 2 alongside provider logins.

## Verification

None yet: this is a design. Each phase's done line is its verification.
