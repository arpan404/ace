# 0180: One logical project above each machine's checkouts

Date: 2026-11-17. Status: accepted. Decided by: the owner, after a technical review
([docs/plans/project-identity-review.md](../plans/project-identity-review.md)). Builds on
[ADR 0063](0063-client-project-management.md), [ADR 0101](0101-work-on-another-machine.md) and
[ADR 0102](0102-work-on-another-machine-in-this-window.md). The opt-in project marker is
ADR 0181, in a pull request of its own.

## Context

A project is a daemon's workspace: an id that one daemon made, bound to one folder. The same
repository checked out on a laptop and a build server is two unrelated projects, and nothing
says they are the same work. Clients guessed: New thread matched another machine's checkout by
`origin` (`workspaces.match`) and remembered copies in `ace.home.copiedProjects`, one browser at
a time. That guess read only the first 64 projects, picked the lowest id among several
checkouts, ignored every remote but `origin`, and could not tell two folders of one monorepo
apart. iOS had no cross-machine matching at all.

## Decision

### Four levels, and identity is not provider data

A **logical project** sits above each machine's **registrations** (checkouts), which sit above
**threads**, which sit above provider sessions. Threads keep their `workspace_id`; providers
and sessions never learn about logical projects, and a link, unlink or merge never changes a
thread's project, provider or session.

### The daemon keeps identity, lazily

`ProjectIdentity` is a UUID. Two side tables hold it:

- `workspace_identity(workspace_id PK, identity_id, source, linked_at)`, `source` one of
  `created`, `linked`, `transfer`, `marker`;
- `identity_alias(from_id PK, to_id, at)`.

A registration with no row is a project of its own; clients key it `hostId/workspaceId`.
Nothing is backfilled and opening the daemon reads no Git and no marker (ADR 0170): the tables
are made empty, with their indexes, the first time. An identity is minted (injected id
generator) when a project is added, cloned or created, when an unlink splits one off, and when
a sender carries one that has none.

Aliases are stored flat: merging Q into P re-points every alias that named Q to P, drops a
self-alias a merge back would leave, and records Q→P, all in one transaction. Either side of a
merge, a link's id and a transfer's id first resolve through an alias kept here, so an id merged
here already stands for the one it went into and a group never splits. A paired machine's
aliases are kept pointing at what its id stands for here, never for an id a registration here
still holds. A registration reports at most the 32 most recent aliases of its identity.

### Wire

- `Project.identity?: {id, aliases (≤32), source}` and `Project.openedAt?`. Both optional;
  older clients strip them.
- Commands (`projects` authority, durable receipts per ADR 0057, so a repeat under the same id
  answers once): `workspace.identity.link {workspaceId, identityId}`,
  `workspace.identity.unlink {workspaceId}`, `workspace.identity.merge {from, into}`. Each pushes
  `workspace.changed` for every registration whose reported identity changed. Merging a project
  into itself, or into one it is merged into already, changes nothing.
- Requests: `workspace.checkout {workspaceId}` (every remote's normalized key and the folder
  inside the repository) and `workspaces.identitySuggestions {remotes, subpath, after?, limit}`
  (registrations sharing any remote at the same subpath, one bounded page of registrations at a
  time, with a cursor; reads are cached as `OriginCache` does).
- An older daemon refuses the new requests as `invalid_message`. A client treats that as "keeps
  no identities": its projects are singletons, linking is hidden for it and nothing is sent.
  No handshake field is added.

### Only the person's own daemons decide

An identity changes only when the person links, unlinks or merges, or when one of their paired
machines transfers work. Remotes are suggestions only: a shared remote at another subpath is not
one, a different remote set reads as "fork of …", and nothing links until the person confirms a
choice that names both sides by machine and path. Suggestions are never preselected.

### Grouping happens in the client

`groupProjects` in `@ace/ui-core` is the only grouping, used by web and iOS: connected
components (union-find) over every machine's reported ids and alias edges. Chains across
machines (A: Q→P, B: P→R) are never flattened locally. Merging Q into P is sent to every online
machine that keeps identities, so the alias reaches as many as possible; a machine offline at the
time still reports Q and joins the group through the alias. Linking one registration records no
alias, and unlinking gives it a fresh id without deleting any alias.

Metadata stays per registration in v1: name, icon, badge, notes, defaults and repositories are
each machine's own, never synced. The group's label is this machine's registration name, else
the most recently used one's; a group whose names differ shows them on a second line.

### Lists

- The palette's "New thread in…" lists one row per logical project across the pool's machines.
  Choosing one opens its checkouts (machine · path, the repository-relative folder and the
  primary repository); a single selectable checkout is used at once. A machine's default
  checkout is its most recently used one: `workspace_recent` is written on add and now also when
  a thread starts there (imported threads excepted). Offline machines' cached registrations stay
  listed, marked offline, and are never the default or selectable.
- New thread's machine move resolves identity first: the registration on the other machine in
  the same group (its most recent, or a choice when it has two or more), then the old fallbacks
  (`copiedProjects`, `workspaces.match` with the subpath).
- Edit project's "Same project elsewhere" lists linked checkouts with Unlink, and loads
  suggestions from each machine lazily, with Link (or merge, when both sides are in shared
  groups). A link that half fails (one machine refused) shows as half-linked with Retry, which
  sends the same identity again and converges.

### Transfers negotiate

`TransferBegin` and `TransferCommit` are strict, so an older target rejects any new field. The
target's reply advertises `identity: true`; only then does the sender put `identity {id,
aliases}` in `commit`, minting one (`created`) when its registration has none.

- A new landing takes the sender's identity (`transfer`); so does a reused registration with
  none. A reused registration in another logical project keeps its own; the result carries
  `identityConflict {identityId}` so the client may offer to link.
- At commit, a registration here in the sender's group is the landing where it fits the method:
  for `remote`, only with the same normalized origin; for a bundle, a repository; for an archive,
  a plain folder. Otherwise the existing rules apply (same origin, then the earlier copy).
- A registration whose identity came from a marker is never a landing by identity: reuse merges
  `.env` and other ignored files into the checkout, and a marker is repository data anyone can
  copy.

### The legacy matcher, fixed

`workspaces.match` reads every registration, most recently used first, with bounded
concurrency and a TTL cache. It returns the first at the asked subpath, else the most recently
used match. A transfer target's same-origin reuse uses the same order, through its own short
cache, over the 256 most recently used registrations, so a begin answers within the sender's
wait however many projects a machine has. A bundle lands by identity only at a repository's
top, never in a folder inside another repository.

## Consequences

- Unlinking the last registration here that held P leaves the aliases into P kept but no longer
  reported from this machine; a machine still on an old id then joins only through another
  machine that received the merge.

- A person sees one project per repository folder across their machines once they link it,
  and nothing changes for anyone who never does.
- Two daemons that never talk agree on an id only through a link, a merge or a transfer the
  person made: there is no shared registry, and no silent merge.
- Metadata may differ between a group's checkouts. Syncing it is left for later.

## Rejected

- **A committed marker as the main mechanism.** ADR 0120 keeps per-project choices out of the
  repository, read-only and upstream repositories can't carry one, and anyone can copy it. It
  stays an opt-in hint (ADR 0181).
- **Grouping in the daemon.** A daemon sees only its own registrations; the pool is the
  client's.
- **Backfilling identities at open.** Work that grows with history at open is banned (ADR 0170),
  and a backfill could only guess.

## Verification

Daemon (`apps/daemon/src/project-identity.test.ts`, `project-origin.test.ts`,
`project-identity.process.test.ts`, `transfers/transfer-identity*.process.test.ts`): an existing
home keeps ids and bindings and reads no Git at open; link, merge (aliases, chains, cap of 32),
unlink, authority and durable idempotence; threads untouched; monorepo subpaths, any-remote and
fork suggestions, paging; 100+ projects, subpath then recency; new and old senders and targets,
adoption, `identityConflict`, the origin check for remote reuse and git-ness for bundles.
Clients: `packages/ui-core/src/project-groups.test.ts` and the web and iOS bridge tests named in
the PR.
