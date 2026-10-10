import { glyphOf } from "@ace/ui-core";
export { isRunning as agentRunning } from "@ace/ui-core";
import type { ThreadKey, ThreadReader } from "@ace/client";
import { arrayEqual, useThread } from "@ace/client-react";
import type { Agent, BackgroundTask } from "@ace/protocol";
import { useMemo } from "react";
import { useTaskKeys } from "../lib/use-task-keys.ts";

const agentIds = (reader: ThreadReader) => reader.agentIds();
const agents = (reader: ThreadReader) =>
  reader.agentIds().flatMap((id) => {
    const agent = reader.agent(id);
    return agent?.parentId ? [agent] : [];
  });
const tasks = (reader: ThreadReader) =>
  reader.taskIds().flatMap((id) => {
    const task = reader.task(id);
    return task?.status === "running" && (task.kind === "shell" || task.kind === "monitor")
      ? [task]
      : [];
  });
const noAgents: readonly Agent[] = [];
const noTasks: readonly BackgroundTask[] = [];

/** Subscribe to each entity's updates as well as additions to the projection. */
export function useWorkCardLive(threadId: string) {
  const ids = useThread(threadId, ["agents"], agentIds, arrayEqual);
  const keys = useMemo<ThreadKey[]>(
    () => ["agents", ...(ids ?? []).map((id): ThreadKey => `agent:${id}`)],
    [ids],
  );
  return {
    agents: useThread(threadId, keys, agents, arrayEqual) ?? noAgents,
    tasks: useThread(threadId, useTaskKeys(threadId), tasks, arrayEqual) ?? noTasks,
  };
}

export function agentNeedsYou(agent: Agent): boolean {
  const glyph = glyphOf(agent.status);
  return glyph === "failed" || glyph === "needs-you";
}
