import { agentTreeWork, glyphOf } from "@ace/ui-core";
export { isRunning as agentRunning } from "@ace/ui-core";
import type { ThreadKey, ThreadReader } from "@ace/client";
import { arrayEqual, useInteractions, useThread } from "@ace/client-react";
import type { Agent, BackgroundTask, Interaction } from "@ace/protocol";
import { useMemo } from "react";
import { useTaskKeys } from "../lib/use-task-keys.ts";

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
export function useWorkCardLive(threadId: string) {
  const ids = useThread(threadId, ["agents"], agentIds, arrayEqual);
  const keys = useMemo<ThreadKey[]>(
    () => ["agents", ...(ids ?? []).map((id): ThreadKey => `agent:${id}`)],
    [ids],
  );
  const allAgents = useThread(threadId, keys, agents, arrayEqual) ?? noAgents;
  const allTasks = useThread(threadId, useTaskKeys(threadId), tasks, arrayEqual) ?? noTasks;
  const pendingIds = useInteractions(threadId);
  const interactionKeys = useMemo<ThreadKey[]>(
    () => ["interactions", ...(pendingIds ?? []).map((id): ThreadKey => `interaction:${id}`)],
    [pendingIds],
  );
  const pending = useThread(threadId, interactionKeys, interactions, arrayEqual) ?? noInteractions;
  return useMemo(
    () => ({
      agents: allAgents.filter((agent) => agent.origin !== "root" || agent.parentId !== null),
      tasks: allTasks.filter(
        (task) =>
          (task.status === "running" || task.status === "unknown") &&
          (task.kind === "shell" || task.kind === "monitor"),
      ),
      work: agentTreeWork(allAgents, allTasks, pending),
    }),
    [allAgents, allTasks, pending],
  );
}

export function agentNeedsYou(agent: Agent): boolean {
  const glyph = glyphOf(agent.status);
  return glyph === "failed" || glyph === "needs-you";
}
