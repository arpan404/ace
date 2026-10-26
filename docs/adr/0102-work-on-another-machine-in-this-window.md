# 0102: Another machine's work in this window

Status: accepted. Date: 2026-10-23.

## Context

One window reaches several of the person's machines through the client's machine pool
(ADR 0059): one client per machine, each pinned to that machine's host id. Add project could
already add or clone a project on another machine, but every other screen used this window's
own daemon through `useClient()`. A project added on the build server could not get a thread,
and a thread started there could not be opened here.

## Decision

### Routing

Another machine's work uses the same routes with `?machine=<hostId>`:

- `/new?machine=<hostId>&project=<projectId>`: New thread on that machine.
- `/t/<threadId>?machine=<hostId>`, and `/t/<threadId>/agents/<agentId>?machine=<hostId>`.

No `machine`, or this window's own host id, means this window's daemon. `threadOn` and
`newThreadOn` (`apps/web/src/lib/machine-routes.ts`) build these addresses; every link to
another machine's thread uses them. A search parameter, not a path prefix, keeps one route,
one view and one set of route chunks for both cases, and leaves existing links untouched.

### Client scoping

The route renders its view inside `MachineScope` (`apps/web/src/lib/machine-scope.tsx`): a
`ClientProvider` for the pool's client of that machine and a query cache of its own. Every hook
below it (projects, catalogs, branches, access modes, draft scopes, the create command, the
thread subscription, the pending start) reads and writes that machine without knowing it. Nothing
falls back: a machine that is offline, refusing this device or not in the pool shows one line
saying so, and its view mounts again when it is back. Inside a scope `useMachines()` still lists
the window's machines, and `useScopedMachine()` names the scope's machine, so links from a
scoped view (`useMachineSearch()`) stay on it.

### New thread

The machine is a line under the page's question, "on Build server", the way the iOS sheet shows
it. It appears while more than one device is connected and is a picker while more than one
machine is online (or the page is already on another one); the composer's strip keeps only the
worktree and branch. Offline machines show their status and can't be picked.
Picking one moves the page to it. The palette's "New thread in…" step does the same: while more
than one machine is online a chip in its field names the machine whose projects it lists (the one
New thread used last, else this one), and choosing the chip lists the machines. A project chosen
there opens New thread on its machine, and the sidebar's New thread asks through that step
whenever another machine is online. A folder typed into the project picker is created on the
page's machine, never another. A draft already names its machine through its key
(`newThreadDraftKey(hostId, …)`), so reopening a draft reopens its machine. Bare ⌘N opens the
machine picked last while it is online, and each machine remembers its own last project. A
project added on another machine opens New thread there.
`other-machine-thread.test.tsx`: the header names the machine only on another machine's thread,
and forking it forks there and opens the fork there. `other-machine-organize.test.tsx`: pin,
archive, delete (after its question), rename and move on a build server row run on the build
server, the picker lists only its projects, and rows picked on both machines archive each on its
own.

Create-attempt recovery is kept per machine: a start on another machine is recorded under
`createAttemptsKey("machine:<hostId>", deviceId)` and recovered only by that machine's client,
so one machine's unsettled start never reads as "belongs to another daemon" on another.

### Home

Home stays one flat task list. Other machines' threads come from the pool's merged store and
are ordered with this window's own by the same rule (`arrange`), under a row id that names the
machine (`machine:[hostId,threadId]`), so equal thread ids on two daemons stay two rows. Each row
renders under its machine's scope and is marked with the machine. While a machine is offline
its rows say so instead of a status, because the last status heard may no longer hold. Other
machines' unsent drafts join the Unsent rows the same way.

### Thread header and links

Another machine's thread names its machine first in the header's crumb (`Build server / api /
Title`), with the mark and name every machine uses; a thread on this window's own machine names
none. Every link and navigation inside a scoped thread and its panels keeps `?machine=`
(`useMachineSearch()`): subagents, parents, forks (`/t/<id>/fork?machine=`), merges back, a
continued or retried thread, search hits, requests, and the PR panel's linked tasks. Where a
destination reads only this window's daemon it is left out instead: issue pages (issue links
stay on GitHub), and the Sign in, Usage and Advanced settings links. "Machine settings…" opens
that machine's page in Fleet.

### Organizing another machine's threads

Every organize action works on another machine's rows and threads: pin, snooze, settle, read,
archive, restore, rename, delete, move, drag and bulk select. Each runs as that machine's own
durable command through that machine's client and its own pending overlay, so the row changes at
once and Undo and refusals behave as they do here.

- The Home selection, the project picker and the delete and archive questions are one per window
  (`perWindow`, `OrganizeWindow`), as the transfer chooser is, so a menu inside a `MachineScope`
  reaches the dialog the shell hosts. A request carries the client it was made with; the picker
  carries the machine (`MoveRequest.hostId`) and runs in its scope, so Move to project lists only
  that machine's projects. A thread never moves between machines that way; that is Continue on.
- The list works in row ids: another machine's thread is picked, renamed and dragged as
  `machine:[hostId,threadId]`. `useWindowThreads()` resolves a row to its machine's actions and
  entry (`routedThreadActions`); actions on several rows run once per machine, each with its own
  Undo. Bulk Move shows only while every picked row is on one machine.
- Order across machines: each machine stores the pin and hand-sorted places (`pinOrder`,
  `listOrder`) of its own threads. Both are numbers on one scale (a time, or a place between two
  neighbours'), so the merged list compares them directly, then by activity, then by row id. A
  drop between two rows of different machines sends the place between their numbers to the
  dropped row's machine only, and the merged order is the same on every reload.
- Other machines' archived threads are restored from their thread's menu; the Archive screen
  still lists this window's daemon only.

## Rejected

- **A path prefix (`/m/<hostId>/t/<id>`).** A second copy of every thread route and its
  loaders, for no gain over a search parameter.
- **Passing a client to each hook.** Dozens of hooks and components would each need it, and
  one missed would quietly use this window's daemon. Scoping by context makes the wrong machine
  impossible below the scope.
- **Grouping Home by machine.** Home is one flat task list (docs/design/visual-language.md).

## Follow-ups

- The Archive screen across machines.
- Issue and pull request pages (`/issues`, `/pulls`) on another machine's projects.
- iOS and Android use the same addressing when they gain the pool.

## Verification

UI tests against fake daemons in a real machine pool (`new-thread-machines.test.tsx`,
`add-project-machines.test.tsx`): starting on the build server creates the thread there and
not here, opens it here and lists it in Home marked with the machine; an offline machine can't
be picked; a draft reopens on its machine; an offline machine's thread says so; a project added
on another machine opens New thread there.
`other-machine-thread.test.tsx`: the header names the machine only on another machine's thread,
and forking it forks there and opens the fork there. `other-machine-organize.test.tsx`: pin,
archive, delete (after its question), rename and move on a build server row run on the build
server, the picker lists only its projects, and rows picked on both machines archive each on its
own.
