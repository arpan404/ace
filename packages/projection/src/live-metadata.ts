import {
  ThreadRunMetadata,
  type Thread,
  type ThreadStatus,
  type EventPayload,
  type Agent,
  type BackgroundTask,
} from "@ace/protocol";
import { isTestCommand } from "./step-purpose.ts";
import { listedBackgroundWork, shellCommandOf, standsForSubagent } from "./task-presentation.ts";
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

type TaskFacts = Pick<BackgroundTask, "status" | "kind" | "internal" | "childAgentId">;
/** A running task shown as background work of its own. */
function listedRunning(task: TaskFacts | undefined): number {
  return Number(task?.status === "running" && listedBackgroundWork(task));
}
/**
 * A running background shell `live.watching` names and `live.watchingCount` counts: not ambient,
 * and its command known. The daemon's one-time seed counts stored tasks with this too, so a
 * task it counts is one whose end the live count takes back off.
 */
export function namedRunningShell(task: BackgroundTask): boolean {
  return (
    task.status === "running" && !task.ambient && shellCommandOf(task, undefined) !== undefined
  );
}

function namedRunning(task: BackgroundTask | undefined): number {
  return Number(task !== undefined && namedRunningShell(task));
}
/** A running task that stands for a subagent with no agent of its own yet. */
function subagentRunning(task: TaskFacts | undefined): number {
  return Number(task?.status === "running" && standsForSubagent(task));
}

/**
 * A delegated child thread this agent summarises, while its tree waits on the person. A child on
 * another machine isn't a thread here to open; its parent shows what it asks.
 */
function askingChild(
  agent: Agent | undefined,
): { id: Agent["threadId"]; name?: string } | undefined {
  if (
    !agent?.childThreadId ||
    agent.machine ||
    agent.status.state !== "blocked" ||
    agent.status.on !== "human"
  )
    return undefined;
  const name = (agent.name ?? agent.role)?.slice(0, titleLength);
  return { id: agent.childThreadId, ...(name ? { name } : {}) };
}

/** `live.askingThreads` after `next` replaced `previous`; the same list when it says nothing new. */
function askingThreads(
  live: Live,
  previous: Agent | undefined,
  next: Agent,
): Live["askingThreads"] {
  const child = next.childThreadId ?? previous?.childThreadId;
  if (!child) return live.askingThreads;
  const entry = askingChild({ ...next, childThreadId: child });
  if (entry) {
    const current = live.askingThreads?.find((each) => each.id === entry.id);
    return current && current.name === entry.name
      ? live.askingThreads
      : withEntry(live.askingThreads, entry);
  }
  return withoutEntry(live.askingThreads, child);
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
  const live: Live = { provider: thread.provider, ...thread.live };
  const changed = applyChange(live, thread, payload, previousAgent, previousTask, command, at);
  // A continuing request may have been settled by hand. Only a new request reopens it.
  const resumes =
    payload.type === "thread.updated" &&
    payload.status &&
    (payload.status.state === "working" ||
      (payload.status.state === "needs_you" && thread.status.state !== "needs_you"));
  const childStarts = (live.runningSubagentCount ?? 0) > (thread.live?.runningSubagentCount ?? 0);
  const newRequest =
    payload.type === "interaction.opened" &&
    payload.interaction.state === "pending" &&
    !thread.live?.asking?.some((previous) => previous.id === payload.interaction.id);
  const unsettled =
    (resumes || childStarts || newRequest) &&
    (thread.settledAt !== undefined || thread.autoSettleAt !== undefined);
  const status =
    payload.type === "thread.updated" && payload.status ? payload.status : thread.status;
  const stamped = at !== undefined && stampTreeWait(live, status, at);
  if (!changed && !stamped && !unsettled) return undefined;
  return {
    type: "thread.client.updated",
    changes: {
      live,
      ...(unsettled ? { settledAt: null, settledReason: null, autoSettleAt: null } : {}),
    },
  };
}

/** `live` changed in place by one point change; false when it says nothing new. */
function applyChange(
  live: Live,
  thread: Thread,
  payload: EventPayload,
  previousAgent: Agent | undefined,
  previousTask: BackgroundTask | undefined,
  command: string | undefined,
  at: number | undefined,
): boolean {
  if (payload.type === "thread.updated") {
    let changed = false;
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
          live.workingSince = backToWorkSince(live, at);
          changed = true;
        }
      } else if (live.workingSince !== undefined) {
        delete live.workingSince;
        changed = true;
      }
    }
    return changed;
  } else if (payload.type === "run.started" && payload.run.agentId === thread.rootAgentId) {
    live.rootRunId = payload.run.id;
    // Working is timed from the turn's start: a run that carries the turn on (a background
    // completion, a subagent's result: ADR 0062) keeps it, and only a new turn restarts it.
    const turn = payload.run.turn ?? payload.run.ordinal;
    if (at !== undefined && (turn === undefined || live.turnStart?.turn !== turn)) {
      if (turn === undefined) delete live.turnStart;
      else live.turnStart = { turn, at };
      if (live.workingSince !== undefined) live.workingSince = at;
    }
  } else if (payload.type === "run.ended" && payload.runId === live.rootRunId) {
    live.rootRunId = null;
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
    put(live, "askingThreads", askingThreads(live, previousAgent, payload.agent));
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
    const next: TaskFacts =
      payload.type === "background_task.started"
        ? payload.task
        : { kind: "other", ...previousTask, status: payload.status };
    // Bookkeeping holds the thread without being counted; a stand-in subagent counts as one.
    live.backgroundTaskCount = Math.max(
      0,
      (live.backgroundTaskCount ?? 0) + listedRunning(next) - listedRunning(previousTask),
    );
    const subagents = subagentRunning(next) - subagentRunning(previousTask);
    if (subagents)
      live.runningSubagentCount = Math.max(0, (live.runningSubagentCount ?? 0) + subagents);
    const id = payload.type === "background_task.started" ? payload.task.id : payload.taskId;
    const task = payload.type === "background_task.started" ? payload.task : previousTask;
    // The exact count beside the shortened list, so nothing past the newest 8 goes uncounted.
    const named =
      (live.watchingCount ?? 0) +
      namedRunning(task && { ...task, status: next.status }) -
      namedRunning(previousTask);
    put(live, "watchingCount", named > 0 ? named : undefined);
    // Only a shell is named, by its command.
    put(
      live,
      "watching",
      next.status === "running" && task && !task.ambient && shellCommandOf(task, undefined)
        ? withEntry(live.watching, { id, title: task.title.slice(0, titleLength) })
        : withoutEntry(live.watching, id),
    );
  } else if (payload.type === "interaction.opened") {
    const { interaction } = payload;
    if (interaction.state !== "pending") return false;
    live.asking = withEntry(live.asking, {
      id: interaction.id,
      kind: interaction.request.kind,
    });
  } else if (payload.type === "interaction.closed") {
    const asking = withoutEntry(live.asking, payload.interactionId);
    if (asking === live.asking) return false;
    put(live, "asking", asking);
  } else if (payload.type === "agent.status") {
    if (payload.agentId === thread.rootAgentId) {
      const facts = rootFacts(live, payload.status, command);
      if (facts === live) return false;
      put(live, "waitingOn", facts.waitingOn);
      put(live, "step", facts.step);
    } else if (previousAgent) {
      const next = { ...previousAgent, status: payload.status };
      const change = runningAgent(next) - runningAgent(previousAgent);
      const asking = askingThreads(live, previousAgent, next);
      if (!change && asking === live.askingThreads) return false;
      live.runningSubagentCount = Math.max(0, (live.runningSubagentCount ?? 0) + change);
      put(live, "askingThreads", asking);
    } else return false;
  } else return false;
  return true;
}

/**
 * A working tree whose root does nothing but wait on its subagents: it waits on them, or its own
 * turn is over while they carry on. Clients read this as Waiting rather than Working.
 */
export function treeOnlyWaits(status: ThreadStatus, live: Live | undefined): boolean {
  if (status.state !== "working") return false;
  if (live?.waitingOn) return true;
  const running = live?.runningSubagentCount ?? 0;
  return running > 0 && status.agents <= running;
}

/**
 * When the thread, going back to work, started its Working stretch: during a root run, the start
 * of that run's turn, so a run that carries the turn on after a pause keeps the turn's time;
 * otherwise now.
 */
function backToWorkSince(live: Live, at: number): number {
  return live.rootRunId && live.turnStart ? live.turnStart.at : at;
}

/**
 * Time each shown status from its own start: the wait on subagents from when it began, and the
 * root's work again from when it went back to work. False when neither moved.
 */
function stampTreeWait(live: Live, status: ThreadStatus, at: number): boolean {
  const waits = treeOnlyWaits(status, live);
  if (waits === (live.waitingSince !== undefined)) return false;
  if (waits) live.waitingSince = at;
  else {
    delete live.waitingSince;
    if (status.state === "working") live.workingSince = at;
  }
  return true;
}
