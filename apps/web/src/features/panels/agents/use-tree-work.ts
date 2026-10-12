import { agentTreeWork } from "@ace/ui-core";
import type { ThreadKey, ThreadReader } from "@ace/client";
import { arrayEqual, useInteractions, useThread, useTaskIds } from "@ace/client-react";
import type { Agent, BackgroundTask, Interaction } from "@ace/protocol";
import { useMemo } from "react";

const agentIds = (reader: ThreadReader) => reader.agentIds();
const agents = (reader: ThreadReader) =>
  reader.agentIds().flatMap((id) => {
    const agent = reader.agent(id);
    return agent ? [agent] : [];
  });
const tasks = (reader: ThreadReader) =>
  reader.taskIds().flatMap((id) => {
    const task = reader.task(id);
    return task ? [task] : [];
  });
const interactions = (reader: ThreadReader) =>
  reader.interactionIds().flatMap((id) => {
    const interaction = reader.interaction(id);
    return interaction?.state === "pending" ? [interaction] : [];
  });
const noAgents: readonly Agent[] = [];
const noTasks: readonly BackgroundTask[] = [];
const noInteractions: readonly Interaction[] = [];

/** Subscribe to each entity's updates as well as additions to the projection. */
export function useTreeWork(threadId: string) {
  const ids = useThread(threadId, ["agents"], agentIds, arrayEqual);
  const keys = useMemo<ThreadKey[]>(
    () => ["agents", ...(ids ?? []).map((id): ThreadKey => `agent:${id}`)],
    [ids],
  );
  const allAgents = useThread(threadId, keys, agents, arrayEqual) ?? noAgents;
  const taskIds = useTaskIds(threadId);
  const taskKeys = useMemo<ThreadKey[]>(
    () => ["tasks", ...(taskIds ?? []).map((id): ThreadKey => `task:${id}`)],
    [taskIds],
  );
  const allTasks = useThread(threadId, taskKeys, tasks, arrayEqual) ?? noTasks;
  const pendingIds = useInteractions(threadId);
  const interactionKeys = useMemo<ThreadKey[]>(
    () => ["interactions", ...(pendingIds ?? []).map((id): ThreadKey => `interaction:${id}`)],
    [pendingIds],
  );
  const pending = useThread(threadId, interactionKeys, interactions, arrayEqual) ?? noInteractions;
  return useMemo(
    () => ({
      agents: allAgents,
      tasks: allTasks,
      interactions: pending,
      work: agentTreeWork(allAgents, allTasks, pending),
    }),
    [allAgents, allTasks, pending],
  );
}
