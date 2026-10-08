import type { Fact } from "@ace/core";
import type { CommandResult } from "@ace/protocol";
import type { ThreadHost } from "./thread-host.ts";
import type { FakeTerminals } from "./terminals.ts";

type Alive = NonNullable<CommandResult["alive"]>;

/** Exited shells stay listed until delete or move releases them, as on the daemon. */
export function reconcileFakeTerminals(host: ThreadHost, terminals: FakeTerminals): void {
  for (const info of terminals.list(host.id)) if (info.exitCode !== null) terminals.close(info.id);
}

/**
 * A provider that dies holds its queued input for an explicit resume (ADR 0053), and a
 * notice says the agent stopped when the death cost work.
 */
export function withExitFacts(host: ThreadHost, facts: readonly Fact[], now: number): Fact[] {
  const exit = facts.find((fact) => fact.type === "process.exited");
  if (!exit || exit.deliberate || host.state.processExit) return [...facts];
  host.queue.paused = true;
  host.queue.reason = "stopped";
  host.queueDirty = true;
  const lost = !["new", "done"].includes(host.view.thread.status.state);
  return [
    ...facts,
    { type: "queue.changed", source: "provider", count: 0 },
    ...(lost
      ? [
          {
            type: "item.upsert",
            agent: host.state.rootKey ?? "root",
            item: `liveness:stopped:${now}`,
            draft: {
              type: "notice",
              level: "warning",
              code: "agent_stopped",
              text: "The agent stopped unexpectedly",
              complete: true,
            },
          } satisfies Fact,
        ]
      : []),
  ];
}

/**
 * Plain delete returns what is still alive in the tree; force (or a stopped thread) stops
 * every agent, cancels its approvals and closes its terminals first. Undefined means go ahead.
 */
export function prepareFakeDelete(
  host: ThreadHost,
  lookup: (id: string) => ThreadHost | undefined,
  terminals: FakeTerminals,
  force: boolean,
  apply: (id: string, facts: Fact[]) => void,
): Alive | undefined {
  const tree = fakeThreadTree(host, lookup);
  const alive: Alive = { agentsRunning: 0, terminalsOpen: 0, operationsRunning: 0 };
  for (const owner of tree) {
    reconcileFakeTerminals(owner, terminals);
    const owned = fakeAlive(owner, terminals);
    alive.agentsRunning += owned.agentsRunning;
    alive.terminalsOpen += owned.terminalsOpen;
    alive.operationsRunning += owned.operationsRunning;
  }
  if (!force && Object.values(alive).some((count) => count > 0)) return alive;
  if (!force && !host.state.processExit) return undefined;
  for (const owner of tree.toReversed()) {
    apply(owner.id, stopFakeThread(owner));
    for (const info of terminals.list(owner.id)) terminals.close(info.id);
  }
  return undefined;
}

function fakeAlive(host: ThreadHost, terminals: FakeTerminals): Alive {
  const active =
    !host.state.processExit && !["new", "done", "failed"].includes(host.view.thread.status.state);
  return {
    agentsRunning: active
      ? Math.max(
          1,
          Object.values(host.state.agents).filter(
            (record) => !["idle", "interrupted", "failed"].includes(record.agent.status.state),
          ).length,
        )
      : 0,
    terminalsOpen: terminals.list(host.id).filter((info) => info.exitCode === null).length,
    operationsRunning:
      !host.state.processExit && host.queued.length > 0 && !host.queue.paused ? 1 : 0,
  };
}

function stopFakeThread(host: ThreadHost): Fact[] {
  host.queued.length = 0;
  host.queue.paused = true;
  host.queue.reason = "stopped";
  host.queue.resumeAt = null;
  host.queueDirty = true;
  return [
    ...Object.keys(host.state.indexes.pendingInteractions).map((interaction): Fact => ({
      type: "interaction.closed",
      interaction,
      state: "cancelled",
    })),
    { type: "process.exited", deliberate: true },
    { type: "queue.changed", source: "provider", count: 0 },
    { type: "queue.changed", source: "engine", count: 0 },
  ];
}

function fakeThreadTree(
  host: ThreadHost,
  lookup: (id: string) => ThreadHost | undefined,
): ThreadHost[] {
  const hosts = new Set([host]);
  for (const current of hosts) {
    for (const record of Object.values(current.state.agents)) {
      const child = record.agent.childThreadId && lookup(record.agent.childThreadId);
      if (child) hosts.add(child);
    }
    if (hosts.size > 64) throw new Error("thread_tree_limit");
  }
  return [...hosts];
}
