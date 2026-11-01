# 0107: The Summary's agent tree spans delegated threads

Status: accepted. Date: 2026-10-31. Refines [ADR 0052](0052-agent-control.md) (delegation) and
[ADR 0004](0004-canonical-agent-model.md) (the agent tree) for the Summary tab.

## Context

A thread's agent tree is built from that thread's agents by `parentId`. A delegated thread shows
in its parent's tree as one agent (`Agent.childThreadId`), whose status the daemon keeps in step
with the child thread (`agent.external`). The child's own subagents, its background commands and
the threads it delegated in turn never showed: a parent three levels up read "working" with no
way to see what worked, and a request four threads down was invisible from where the person
looked.

The link already exists on the client: every delegate agent names its child thread. No new
daemon projection or protocol schema is needed.

## Decision

- **Pure join, in `@ace/ui-core` (`agentForest`).** Input: the viewed thread's id and, per
  thread, its live entities (agents, background tasks, pending requests, status). Output: one
  tree. Within a thread, agents nest by `parentId` and an earlier run of an agent a provider
  restarted folds into its latest run. A delegate agent carries its child thread's agents under
  it; the child's main agent is the delegate's own work, so its children hang directly under the
  delegate and its state and requests are the delegate's. Running background commands are rows
  under the agent that started them.
- **Liveness across threads.** A row is live while it, or anything under it at any depth in any
  thread, works or waits. Each thread's own rule (`agentTreeWork`) decides its agents; the join
  ORs children upward. A branch never reads done while a delegated great-grandchild still runs.
- **Loading is lazy, bounded and optional.** `useAgentForest` subscribes to each delegated thread
  the tree reaches, one hidden loader per thread, only while the Summary tab is mounted. Threads
  are found breadth first and capped at six levels and sixteen threads (`forestBounds`). The
  client holds at most 32 thread subscriptions, shared with every other open view, so the
  Summary's leases are *optional* (`ClientApi.thread(id, { optional })`, `OptionalLeaseScope`):
  they take a slot only while more than `threadReserve` (8) stay free, a thread the person opens
  takes the slot of one only optional views hold, and a refused or displaced lease reads
  `no_room` as its store's error. The tree then shows that delegate's row with "not loaded" and
  tries again when `threadRoom` rises. A thread past the bound, or on another machine, also shows
  as its delegate's row alone.
- **Facts must be current to read as settled.** Each thread's entry carries how current it is
  (`ThreadWork.facts`: live, syncing, not loaded). A branch whose thread is syncing, unconfirmed or
  still loading reads "syncing" (or "last seen …" while live), never "finished", and its mark
  holds still. Now says Done only when no root of the tree is live and every loaded thread is
  confirmed (`AgentForest.confirmed`); otherwise "Working" or "Syncing".
- **Cycles.** A thread is placed once, under the first delegate that reaches it; the
  breadth-first walk never revisits a thread, so delegation loops end.
- **Cost.** A thread's change replaces only that thread's entry, and each thread's own shape is
  kept by its facts object (`forestLayers`), so an unchanged thread isn't worked out again. The
  join appends into buckets and counts each row's tally once, bottom-up: linear in the loaded
  agents and tasks (a test joins 4,000 agents against 500).
- **Order and folding.** Under a parent, rows waiting on the person come first, then failed,
  working, running commands, and finished. Two or more finished siblings (settled, confirmed,
  loaded, not failed) fold into one "N done" line that opens in place; that choice is kept with
  the other folds.
- **Status without glyphs.** In the tree, the provider mark is the only status mark: it breathes
  (`.fx-alive`, opacity and scale over 2.4s) while its branch is live, rests when idle and dims to
  55% when done. Colour is reserved for words: the warning colour for a request, red for a
  failure.

## Consequences

- The Summary names the agent that needs the person even when it lives in a delegated thread,
  with Open going to that agent.
- Folds are per row key (`thread/agent`) and kept with the viewed thread's Summary tab.
- The breathing mark is a looping animation, which `visual-language.md` otherwise forbids for
  idle-CPU reasons (a looping indicator measured 6% → 39% idle CPU). It is accepted here as an
  owner decision, bounded to the open Summary and to live branches, and still under reduced
  motion and stale facts. If it shows up in battery or CPU measurements, the fallback is a still
  foreground mark.
- Pull request checks and size show only once the PR panel has read the PR's detail; the Summary
  never reads the forge on its own.
