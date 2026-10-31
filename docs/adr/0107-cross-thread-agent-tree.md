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
- **Loading is lazy and bounded.** `useAgentForest` subscribes to each delegated thread the tree
  reaches through the client's normal thread leases, one hidden loader per thread, only while the
  Summary tab is mounted. Threads are found breadth first and capped at six levels and sixteen
  threads (`forestBounds`): the client holds at most 32 thread subscriptions, shared with every
  other open view. A thread past the bound still shows as its delegate's row, without its agents.
  A delegation on another machine has no local thread; its delegate row stands alone.
- **Cycles.** A thread is placed once, under the first delegate that reaches it; the
  breadth-first walk never revisits a thread, so delegation loops end.
- **Cost.** A thread's change replaces only that thread's entry; the join is linear in the
  loaded agents and tasks (bounded live entities, never history).
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
