# 0189: Clones of one repository are one project, with no setup

Date: 2026-11-18. Status: accepted. Decided by: the owner. **Amends
[ADR 0180](0180-logical-project-identity.md)**, which kept remotes as suggestions only and
grouped checkouts only after a link, a merge or a marker (ADR 0181).

## Context

ADR 0180 groups a person's checkouts into one logical project only once they link them. Nobody
did: the owner's three machines each have a checkout of ace, and New thread in… listed three
projects (`ace · Mac`, `ace · Rijan's Mac`, `ace · omarchy`). The Threads panel's project filter
was worse: it read only this window's daemon, so with the device filter on two machines it
listed one machine's projects and filtered threads by one machine's project id.

## Decision

### Same remotes at the same folder is one project

Checkouts whose Git remotes are the same set, at the same folder inside the repository, are one
logical project, with nothing to link. Remote URLs compare by `normalizeRemoteUrl`, so the ssh,
https and `.git` spellings of one repository match.

- **Forks stay apart.** A fork's checkout has another remote set (its own `origin`, often an
  `upstream` too), so its key differs. Linking it by hand still works.
- **Monorepo folders stay apart.** `apps/web` and `apps/ios` of one repository are two projects;
  each groups with its own clones.
- **A folder outside Git, or a repository without a remote,** has no key and groups only
  through its identity, as before.
- **Remotes on the machine's own disk** (`/srv/git/app.git`, `file://`, a drive or a share) are
  left out of the key: the same path on two machines is two repositories. A checkout with only
  those has no key.

### The daemon reports the key; the client groups

`Project.remoteKey?: {remotes, subpath}` is a new optional field in `workspaces.list` and in
`workspace.changed`. The daemon keeps it in `workspace_remote_key(workspace_id PK, remotes,
subpath, read_at, apart)`, made empty at open. Nothing reads Git at open (ADR 0170): when a
client connects, and when a project is added, a background sweep walks the registrations by
id, 64 per page with a pause between pages. Each page is a range read on the primary key, so no
step scans or sorts every registration and no index is needed. It reads from Git, four at a
time, those whose key is unread or older than ten minutes, and pushes `workspace.changed` for
each whose key changed. A remote changed meanwhile is seen on the next sweep after its read
goes stale.

`groupProjects` in `@ace/ui-core` stays the only grouping. The remote key is one more kind of
edge in its union-find, beside identity ids and aliases, so web and iOS group the same way. A
group's key is its smallest identity id, else its remote key, else its one checkout. An older
daemon reports no key: its projects stay singletons, as today.

### Explicit choices still win

- **Unlink keeps a checkout apart for good.** `workspace.identity.unlink` sets `apart` on that
  registration, and a daemon never reports a key for one kept apart, however often it reads
  it. It then groups only through its identity: a later link or merge puts it in a group, and
  remote grouping never does.
- **Links and merges add edges.** They work as in ADR 0180; a remote edge can only add to a
  group, never split one.
- Transfers are unchanged: a transfer lands by identity and origin as ADR 0180 says; a remote
  key decides nothing on the daemon.

### The Threads panel's project filter lists logical projects

The filter lists one row per logical project with a checkout on any machine in the panel's
device filter, as New thread in… groups them, beside this machine's projects that only threads
still mention. A row's count adds up its threads on those machines. Choosing a row filters the
list to the threads in any of its checkouts, on every machine. The stored choice stays one
checkout: this machine's project id when it has one (so every screen that reads it as before
keeps working), else `machine/project`. This daemon's list is narrowed server-side only when the
project has exactly one checkout here; otherwise the panel narrows it.

A row's actions (⋯ and its context menu) act on this machine's checkout of it, the most
recently used if there are two. A project with no checkout here has no actions in the filter:
the project dialogs act on this window's machine. Its row names the machines it is on
(`ace-fork · omarchy`), as New thread in… does.

## Consequences

- Clones group on first sight, with no marker and no link, on every machine that runs a daemon
  with this change.
- Two checkouts on one machine with the same remotes (a project and a worktree registered
  beside it) are one project with two checkouts; New thread asks which.
- Unlinking a remote-grouped checkout splits that checkout off and keeps it off; there is no
  "regroup by remote" button. Linking it again is the way back.
- The first sweep on a machine with many projects reads Git for each, in the background, a few
  at a time; each key that arrives is one `workspace.changed`. Clients put each push in place
  and keep it for any list read still paging, applying it again when that read lands, so a
  read never undoes a push and pushes never restart a read. The pool also keeps each push on
  the device for when that machine goes offline.

## Rejected

- **Grouping on any shared remote.** A fork shares the upstream's remote; it would merge with
  the project it forked.
- **Keeping remotes as suggestions only (ADR 0180).** Nobody linked, so nothing grouped.
- **Reading remotes in the client** (`workspace.checkout` per project per machine): one request
  per project per machine on every list, on links as slow as 3G.
- **Recording the opt-out as a new identity source.** `ProjectIdentitySource` is a strict enum;
  older clients would refuse every project carrying the new value.

## Verification

`packages/ui-core/src/project-groups.test.ts` (clones, remote order, forks, monorepo folders,
an unlinked checkout, mixed identity and remote edges, stable keys);
`apps/daemon/src/project-remote-key.test.ts` (reported once read and announced once, stale
reads, unlink keeps apart even after a link, failed reads, bounded reads, the paged walk and
its query plan, local remotes); `packages/git/src/checkout-facts.test.ts` (folders named
`..tools`); `apps/web/src/lib/project-pushes.test.ts` and `pool-projects.test.ts` (pushes win
over reads out, and are kept offline);
`apps/web/src/features/home/project-scope.test.ts` (rows across the device filter, summed
counts, choosing covers every machine's checkouts, forks, projects only threads mention, the
archive across two checkouts here).
