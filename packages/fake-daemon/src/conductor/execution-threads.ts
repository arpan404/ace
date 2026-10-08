import { ThreadId, WorkspaceId, type ConductorRunView, type ThreadStatus } from "@ace/protocol";
import type { FakeServiceContext } from "../service-context.ts";
import type { FakeDeckRun, FakeDeckExecution } from "./types.ts";

/** Each simulated engine launch creates one owned thread, retaining settled bindings like native execution. */
export function executionDelegations(
  run: FakeDeckRun,
  execution: FakeDeckExecution,
  host?: FakeServiceContext,
): ConductorRunView["delegations"] {
  return execution.bindings.map((binding) => {
    const lane = execution.state.lanes[binding.id];
    const threadId = `${run.id}.${binding.id}.thread`;
    const rootId = `${run.id}.root`;
    const stopped = !lane?.live;
    const status: ThreadStatus = stopped
      ? { state: "done" }
      : execution.state.phase === "paused" || lane.status === "waiting"
        ? { state: "waiting", on: "queue" }
        : lane.status === "done"
          ? { state: "done" }
          : lane.status === "unresponsive"
            ? { state: "unresponsive" }
            : { state: "working", agents: 1 };
    if (host && !host.thread(threadId)) {
      host.createThread?.({
        id: threadId,
        workspaceId: run.workspaceId,
        title: `Deck ${binding.role}: ${binding.workstream ?? "plan"}`,
        provider: binding.model.provider,
      });
      host.apply?.(threadId, [
        {
          type: "agent.seen",
          agent: "root",
          origin: "ace",
          fidelity: "full",
          cwd: "/fake/deck",
          native: { provider: binding.model.provider, nativeId: threadId },
        },
      ]);
    }
    const deck = {
      deckId: run.id,
      runId: run.id,
      workspaceId: WorkspaceId.parse(run.workspaceId),
      laneId: binding.id,
      role: binding.role,
    };
    if (host && JSON.stringify(host.thread(threadId)?.thread.deck) !== JSON.stringify(deck))
      host.update(threadId, { type: "thread.client.updated", changes: { deck } });
    if (host && JSON.stringify(host.thread(threadId)?.thread.status) !== JSON.stringify(status))
      host.update(threadId, { type: "thread.updated", status });
    const child = host?.thread(threadId)?.thread;
    if (host && child)
      host.apply?.(rootId, [
        {
          type: "agent.seen",
          agent: threadId,
          parent: "root",
          origin: "ace",
          fidelity: "full",
          cwd: "/fake/deck",
          native: { provider: binding.model.provider, nativeId: threadId },
        },
        { type: "agent.external", agent: threadId, threadId: ThreadId.parse(threadId), status },
      ]);
    return {
      laneId: binding.id,
      workstream: binding.workstream,
      threadId,
      agentId: child?.rootAgentId ?? binding.agentId,
      parentThreadId: rootId,
      parentAgentId: host?.thread(rootId)?.thread.rootAgentId ?? `${rootId}.agent`,
      provider: binding.model.provider,
      account: binding.account,
      generation: lane?.generation ?? binding.generation,
      phase: stopped ? "settled" : lane.retiring ? "cancelling" : "running",
    };
  });
}
