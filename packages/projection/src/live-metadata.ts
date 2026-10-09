import {
  ThreadRunMetadata,
  type Thread,
  type EventPayload,
  type Agent,
  type BackgroundTask,
} from "@ace/protocol";
import { isTestCommand } from "./step-purpose.ts";
/** Retained provider identifiers stay on agents; sidebar hints must fit the wire budget. */
export function boundedLiveModel(model: string | undefined): string | undefined {
  const parsed = ThreadRunMetadata.shape.model.safeParse(model);
  return parsed.success ? parsed.data : undefined;
}

type Live = ThreadRunMetadata;
/** How many running tasks and open requests the sidebar hints keep, newest last. */
const kept = 8;
const titleLength = 256;
function runningAgent(agent: Agent | undefined): number {
  if (!agent || agent.origin === "root") return 0;
  return Number(
    agent.status.state === "starting" ||
      agent.status.state === "working" ||
      (agent.status.state === "blocked" && agent.status.on === "subagents"),
  );
}

/** `list` with `entry` appended (replacing one with its id), keeping the newest `kept`. */
function withEntry<T extends { id: string }>(list: readonly T[] | undefined, entry: T): T[] {
  return [...(list ?? []).filter((each) => each.id !== entry.id), entry].slice(-kept);
}

/** `list` without `id`, or the same list when it never held it. */
function withoutEntry<T extends { id: string }>(
  list: T[] | undefined,
  id: string,
): T[] | undefined {
  return list?.some((each) => each.id === id) ? list.filter((each) => each.id !== id) : list;
}

/** `live` with `key` set, or removed when `value` is undefined or empty. */
function put<K extends keyof Live>(live: Live, key: K, value: Live[K] | undefined): void {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) delete live[key];
  else live[key] = value;
}

/**
 * The root agent's live facts from its status: how many subagents it waits on, and whether its
 * step in flight runs tests (`command` is that step's shell command, when it has one).
 */
function rootFacts(
  live: Live,
  status: Agent["status"],
  command: string | undefined,
): Pick<Live, "waitingOn" | "step"> {
  const waitingOn =
    status.state === "blocked" && status.on === "subagents" && status.refs.length > 0
      ? status.refs.length
      : undefined;
  const step =
    status.state === "working" && status.itemId !== undefined && command && isTestCommand(command)
      ? "tests"
      : undefined;
  return live.waitingOn === waitingOn && live.step === step
    ? live
    : { ...(waitingOn ? { waitingOn } : {}), ...(step ? { step } : {}) };
}

/**
 * Point changes only; callers supply the replaced entity, never retained history. For the root
 * agent's status, `command` is the shell command of the step it names, when it names one.
 */
export function liveMetadata(
  thread: Thread,
  payload: EventPayload,
  previousAgent?: Agent,
  previousTask?: BackgroundTask,
  command?: string,
  at?: number,
): EventPayload | undefined {
  if (
    payload.type === "item.created" &&
    payload.item.type === "message" &&
    payload.item.role === "user" &&
    !payload.item.synthetic &&
    !thread.hasSentMessage
  )
    return { type: "thread.client.updated", changes: { hasSentMessage: true } };
  const unsettled =
    payload.type === "thread.updated" &&
    payload.status &&
    payload.status.state !== "done" &&
    (thread.settledAt !== undefined || thread.autoSettleAt !== undefined);
  const live: Live = { provider: thread.provider, ...thread.live };
  if (payload.type === "thread.updated") {
    let changed = Boolean(unsettled);
    if (payload.execution) {
      live.provider = payload.execution.provider;
      live.model = boundedLiveModel(payload.execution.model);
      live.account = payload.execution.instanceId;
      live.options = payload.execution.options;
      changed = true;
    }
    if (payload.status && at !== undefined) {
      if (payload.status.state === "working") {
        if (thread.status.state !== "working" || live.workingSince === undefined) {
          live.workingSince = at;
          changed = true;
        }
      } else if (live.workingSince !== undefined) {
        delete live.workingSince;
        changed = true;
      }
    }
    if (!changed) return undefined;
  } else if (payload.type === "agent.created") {
    const count =
      Number(payload.agent.origin !== "root") -
      Number(previousAgent !== undefined && previousAgent.origin !== "root");
    live.subagentCount = Math.max(0, (live.subagentCount ?? 0) + count);
    live.runningSubagentCount = Math.max(
      0,
      (live.runningSubagentCount ?? 0) + runningAgent(payload.agent) - runningAgent(previousAgent),
    );
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
    const id = payload.type === "background_task.started" ? payload.task.id : payload.taskId;
    const task = payload.type === "background_task.started" ? payload.task : previousTask;
    put(
      live,
      "watching",
      running && task && !task.ambient
        ? withEntry(live.watching, { id, title: task.title.slice(0, titleLength) })
        : withoutEntry(live.watching, id),
    );
  } else if (payload.type === "interaction.opened") {
    const { interaction } = payload;
    if (interaction.state !== "pending") return undefined;
    live.asking = withEntry(live.asking, {
      id: interaction.id,
      kind: interaction.request.kind,
    });
  } else if (payload.type === "interaction.closed") {
    const asking = withoutEntry(live.asking, payload.interactionId);
    if (asking === live.asking) return undefined;
    put(live, "asking", asking);
  } else if (payload.type === "agent.status") {
    if (payload.agentId === thread.rootAgentId) {
      const facts = rootFacts(live, payload.status, command);
      if (facts === live) return undefined;
      put(live, "waitingOn", facts.waitingOn);
      put(live, "step", facts.step);
    } else if (previousAgent) {
      const change =
        runningAgent({ ...previousAgent, status: payload.status }) - runningAgent(previousAgent);
      if (!change) return undefined;
      live.runningSubagentCount = Math.max(0, (live.runningSubagentCount ?? 0) + change);
    } else return undefined;
  } else return undefined;
  return {
    type: "thread.client.updated",
    changes: {
      live,
      ...(unsettled ? { settledAt: null, settledReason: null, autoSettleAt: null } : {}),
    },
  };
}
