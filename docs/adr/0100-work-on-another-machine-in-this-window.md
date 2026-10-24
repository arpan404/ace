# 0100: Another machine's work in this window

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

The composer's top strip holds a machine picker while more than one machine is online (or the
page is already on another one). Offline machines show their status and can't be picked.
Picking one moves the page to it. A draft already names its machine through its key
(`newThreadDraftKey(hostId, …)`), so reopening a draft reopens its machine. Bare ⌘N opens the
machine picked last while it is online, and each machine remembers its own last project. A
project added on another machine opens New thread there.

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

## Rejected

- **A path prefix (`/m/<hostId>/t/<id>`).** A second copy of every thread route and its
  loaders, for no gain over a search parameter.
- **Passing a client to each hook.** Dozens of hooks and components would each need it, and
  one missed would quietly use this window's daemon. Scoping by context makes the wrong machine
  impossible below the scope.
- **Grouping Home by machine.** Home is one flat task list (docs/design/visual-language.md).

## Follow-ups

- Organize actions (pin, snooze, settle, archive, rename, drag, bulk) on another machine's
  rows. They answer to this window's daemon today, so those rows only open.
- Thread-to-thread steps (⌥⌘↓) and the palette's thread search across machines.
- Links inside a scoped thread that don't use `useMachineSearch()` yet (fork, merge, forge
  pages) still open on this window's daemon.
- iOS and Android use the same addressing when they gain the pool.

## Verification

UI tests against fake daemons in a real machine pool (`new-thread-machines.test.tsx`,
`add-project-machines.test.tsx`): starting on the build server creates the thread there and
not here, opens it here and lists it in Home marked with the machine; an offline machine can't
be picked; a draft reopens on its machine; an offline machine's thread says so; a project added
on another machine opens New thread there.
