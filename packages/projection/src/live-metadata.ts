import {
  ThreadRunMetadata,
  type Thread,
  type EventPayload,
  type Agent,
  type BackgroundTask,
} from "@ace/protocol";
/** Retained provider identifiers stay on agents; sidebar hints must fit the wire budget. */
export function boundedLiveModel(model: string | undefined): string | undefined {
  const parsed = ThreadRunMetadata.shape.model.safeParse(model);
  return parsed.success ? parsed.data : undefined;
}
/** Point changes only; callers supply the replaced entity, never retained history. */
export function liveMetadata(
  thread: Thread,
  payload: EventPayload,
  previousAgent?: Agent,
  previousTask?: BackgroundTask,
): EventPayload | undefined {
  if (
    payload.type === "thread.updated" &&
    payload.status &&
    payload.status.state !== "done" &&
    (thread.settledAt !== undefined || thread.autoSettleAt !== undefined)
  )
    return {
      type: "thread.client.updated",
      changes: { settledAt: null, settledReason: null, autoSettleAt: null },
    };
  const live = { provider: thread.provider, ...thread.live };
  if (payload.type === "thread.updated" && payload.execution) {
    live.provider = payload.execution.provider;
    live.model = boundedLiveModel(payload.execution.model);
    live.account = payload.execution.instanceId;
    live.options = payload.execution.options;
  } else if (payload.type === "agent.created") {
    const count =
      Number(payload.agent.origin !== "root") -
      Number(previousAgent !== undefined && previousAgent.origin !== "root");
    live.subagentCount = Math.max(0, (live.subagentCount ?? 0) + count);
    if (payload.agent.origin === "root" && payload.agent.model)
      live.model = boundedLiveModel(payload.agent.model);
  } else if (
    payload.type === "agent.updated" &&
    payload.agentId === thread.rootAgentId &&
    payload.model
  )
    live.model = boundedLiveModel(payload.model);
  else if (
    payload.type === "background_task.started" ||
    payload.type === "background_task.updated"
  ) {
    const running =
      payload.type === "background_task.started"
        ? payload.task.status === "running"
        : payload.status === "running";
    live.backgroundTaskCount = Math.max(
      0,
      (live.backgroundTaskCount ?? 0) +
        Number(running) -
        Number(previousTask?.status === "running"),
    );
  } else return undefined;
  return { type: "thread.client.updated", changes: { live } };
}
