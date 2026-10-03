import type { AgentStatus, EventPayload, Item, ThreadStatus } from "@ace/protocol";
import { externalAgentStatus } from "./external.ts";
import type { Key } from "./facts.ts";
import { lookup, type AgentRecord, type ThreadState } from "./state.ts";
import { emit } from "./emit.ts";
import { isActionableInteraction } from "./human.ts";
import { liveToolKeys, pendingInteractionKeys, runningTaskKeys } from "./indexes.ts";
import { statusInputs, suppressesActiveSilence } from "./status-inputs.ts";
export { isLiveTool } from "./status-inputs.ts";

export function isSettled(status: AgentStatus): boolean {
  return status.state === "idle" || status.state === "interrupted" || status.state === "failed";
}

/** JSON data equality, independent of object property order. */
function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => equal(value, right[index]))
    );
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a).filter((key) => a[key] !== undefined);
  return (
    keys.length === Object.keys(b).filter((key) => b[key] !== undefined).length &&
    keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]))
  );
}

type ToolItem = Extract<Item, { type: "tool_call" }>;

/** Unstarted silent children are visible diagnostics, not evidence of live work.
 * Explicit work or a live descendant keeps such an agent relevant to completion.
 */
function completionRelevance(
  state: ThreadState,
  statusOf: (key: Key) => AgentStatus,
  waitingOwners: Set<string> = new Set([
    ...liveToolKeys(state).flatMap((key) => {
      const item = lookup(state.items, key);
      return item?.type === "tool_call" ? [item.agentId] : [];
    }),
    ...pendingInteractionKeys(state).map((key) => lookup(state.interactions, key)!.agentId),
    ...runningTaskKeys(state)
      .map((key) => lookup(state.tasks, key)!)
      .filter((task) => !task.ambient)
      .map((task) => task.agentId),
  ]),
) {
  const cached = new Map<Key, boolean>();
  const visiting = new Set<Key>();
  function relevant(key: Key): boolean {
    const prior = cached.get(key);
    if (prior !== undefined) return prior;
    const record = lookup(state.agents, key);
    if (!record) return false;
    const status = statusOf(key);
    if (isSettled(status)) return false;
    if (record.externalStatus) return true;
    if (
      key === state.rootKey ||
      status.state !== "unresponsive" ||
      record.disconnectedAt !== undefined ||
      record.activeRun ||
      record.lastRun ||
      record.retry ||
      waitingOwners.has(record.agent.id)
    )
      return true;
    if (visiting.has(key)) return true;
    visiting.add(key);
    const liveDescendant = Object.keys(
      lookup(state.indexes.childrenByParent, record.agent.id) ?? {},
    ).some(relevant);
    visiting.delete(key);
    cached.set(key, liveDescendant);
    return liveDescendant;
  }
  return relevant;
}

/** Deadline eligibility uses current completion relevance, memoized bottom-up.
 * A descendant's wake/silence transition is scheduled before an ancestor can
 * become newly eligible. No future timestamp needs a second tree derivation.
 */
export function silenceDeadlineReader(state: ThreadState) {
  const { waitingOwners, children, lastSubtreeSignal } = statusInputs(state);
  const relevant = completionRelevance(
    state,
    (key) => {
      const record = lookup(state.agents, key);
      if (!record) throw new Error(`Unknown agent key: ${key}`);
      return record.agent.status;
    },
    waitingOwners,
  );
  return (key: Key, record: AgentRecord): number | undefined => {
    const phase = record.agent.status.state;
    if (phase !== "working" && phase !== "starting") return undefined;
    if (
      !record.activeRun &&
      (phase === "working" ||
        (key === state.rootKey && !state.hasRun && record.agent.fidelity !== "placeholder"))
    )
      return undefined;
    if (record.activeRun) {
      const liveChildren = Object.keys(lookup(children, record.agent.id) ?? {}).filter(relevant);
      if (suppressesActiveSilence(waitingOwners, record.agent.id, liveChildren.length))
        return undefined;
    }
    return Math.floor(lastSubtreeSignal(key) + state.config.silenceMs) + 1;
  };
}

function statusResolver(state: ThreadState, now: number) {
  const {
    lastTransportSignalAt,
    byId,
    interactionsByAgent,
    tasksByAgent,
    toolsByAgent,
    children,
    lastSubtreeSignal,
    waitingOwners,
    waitsByAgent,
  } = statusInputs(state);
  const resolved = new Map<Key, AgentStatus>();
  const visiting = new Set<Key>();
  const holdsCompletion = completionRelevance(state, resolve, waitingOwners);

  function resolve(key: Key): AgentStatus {
    const cached = resolved.get(key);
    if (cached) return cached;
    const record = lookup(state.agents, key);
    if (!record) throw new Error(`Unknown agent key: ${key}`);
    // A malformed restored tree must not recurse forever or look settled.
    if (visiting.has(key)) return { state: "starting" };
    visiting.add(key);
    let status = derive(record, key);
    if (
      !record.externalStatus &&
      state.config.liveness === "transport" &&
      !state.processExit &&
      !record.limited &&
      !isSettled(status) &&
      now - lastTransportSignalAt > state.config.silenceMs
    ) {
      status = { state: "unresponsive", lastSignalAt: lastTransportSignalAt };
    }
    visiting.delete(key);
    resolved.set(key, status);
    return status;
  }

  function derive(record: AgentRecord, key: Key): AgentStatus {
    const { agent } = record;
    if (record.externalStatus && agent.childThreadId)
      return externalAgentStatus(record.externalStatus, agent.childThreadId);
    const exit = state.processExit;
    if (record.limited) return { state: "blocked", on: "rate_limit", refs: [], ...record.limited };
    if (exit?.unsettled?.includes(key)) {
      return exit.deliberate
        ? { state: "interrupted" }
        : {
            state: "failed",
            error: { kind: "process_exit", message: exit.message ?? "Provider process exited" },
          };
    }
    if (exit && isSettled(agent.status)) return agent.status;
    if (exit) {
      return exit.deliberate
        ? { state: "interrupted" }
        : {
            state: "failed",
            error: { kind: "process_exit", message: exit.message ?? "Provider process exited" },
          };
    }

    const interactions = interactionsByAgent.get(agent.id) ?? [];
    const blocking = interactions.filter((interaction) => interaction.blocking);
    if (blocking.length > 0) {
      return { state: "blocked", on: "human", refs: blocking.map((interaction) => interaction.id) };
    }
    if (record.disconnectedAt !== undefined)
      return { state: "unresponsive", lastSignalAt: record.disconnectedAt };
    if (record.retry) return { state: "blocked", refs: [], ...record.retry };

    const liveChildren = Object.keys(lookup(children, agent.id) ?? {}).filter(holdsCompletion);
    const tasks = tasksByAgent.get(agent.id) ?? [];
    const backgroundRefs = [
      ...tasks.map((task) => task.id),
      ...liveChildren
        .filter(
          (child) =>
            !tasks.some((task) => task.childAgentId === lookup(state.agents, child)?.agent.id),
        )
        .map((child) => lookup(state.agents, child)!.agent.id),
    ];

    if (record.activeRun) {
      const waits = waitsByAgent.get(agent.id) ?? [];
      if (waits.length > 0)
        return {
          state: "blocked",
          on: "subagents",
          refs: liveChildren
            .filter((child) =>
              waits.some((wait) => wait.targets.length === 0 || wait.targets.includes(child)),
            )
            .flatMap((child) => {
              const childAgent = lookup(state.agents, child)?.agent;
              return childAgent ? [childAgent.id] : [];
            }),
        };
      const tools = toolsByAgent.get(agent.id) ?? [];
      const foreground = tools.flatMap((item) => {
        if (item.call.detail.kind !== "agent.spawn" || !item.call.detail.childAgentId) return [];
        const child = lookup(byId, item.call.detail.childAgentId);
        if (!child || lookup(state.agents, child)?.agent.background || !holdsCompletion(child))
          return [];
        return [lookup(state.agents, child)!.agent.id];
      });
      // An agent's own tool work can continue while a foreground child runs.
      const ownTools = tools.filter((item) => {
        return (
          item.call.detail.kind !== "agent.spawn" ||
          !item.call.detail.childAgentId ||
          !foreground.includes(item.call.detail.childAgentId)
        );
      });
      let newest: ToolItem | undefined;
      for (const item of ownTools) {
        if (
          !newest ||
          item.call.startedAt > newest.call.startedAt ||
          (item.call.startedAt === newest.call.startedAt && item.createdAt >= newest.createdAt)
        ) {
          newest = item;
        }
      }
      if (newest) return { state: "working", activity: "tool", itemId: newest.id };
      if (foreground.length > 0)
        return { state: "blocked", on: "subagents", refs: [...new Set(foreground)] };
      if (
        state.config.liveness !== "transport" &&
        !suppressesActiveSilence(waitingOwners, agent.id, liveChildren.length) &&
        now - lastSubtreeSignal(key) > state.config.silenceMs
      ) {
        return { state: "unresponsive", lastSignalAt: lastSubtreeSignal(key) };
      }
      return {
        state: "working",
        activity: record.activity,
        ...(record.detail === undefined ? {} : { detail: record.detail }),
      };
    }

    if (record.wakeUntil !== undefined && now < record.wakeUntil) {
      return { state: "working", activity: "starting_turn" };
    }
    if (record.processSettledStatus) return record.processSettledStatus;
    if (!record.lastRun) {
      if (key === state.rootKey && !state.hasRun && agent.fidelity !== "placeholder")
        return { state: "starting" };
      if (now - lastSubtreeSignal(key) > state.config.silenceMs)
        return { state: "unresponsive", lastSignalAt: lastSubtreeSignal(key) };
      return { state: "starting" };
    }
    if (backgroundRefs.length > 0) {
      return { state: "blocked", on: "background_task", refs: backgroundRefs };
    }
    const run = lookup(state.runs, record.lastRun);
    if (run?.state === "interrupted") return { state: "interrupted" };
    if (run?.state === "failed") {
      return {
        state: "failed",
        error: record.lastError ?? { kind: "unknown", message: "Agent turn failed" },
      };
    }
    return { state: "idle" };
  }

  return resolve;
}

/** Derives descendants first, without depending on their cached statuses. */
export function deriveAgentStatus(state: ThreadState, key: Key, now: number): AgentStatus {
  return statusResolver(state, now)(key);
}

/** Agent statuses must have been derived for the current fact before calling this. */
export function deriveThreadStatus(state: ThreadState): ThreadStatus {
  const records = Object.values(state.agents);
  const statuses = records.map((record) => record.agent.status);
  const byId = new Map(records.map((record) => [record.agent.id, record.agent.status]));
  const pending = pendingInteractionKeys(state)
    .map((key) => lookup(state.interactions, key)!)
    .filter((interaction) => isActionableInteraction(interaction, byId.get(interaction.agentId)));
  const externalHuman = records.reduce(
    (count, record) =>
      count +
      (record.externalStatus?.state === "needs_you" ? record.externalStatus.interactions : 0),
    0,
  );
  if (pending.length + externalHuman > 0)
    return { state: "needs_you", interactions: pending.length + externalHuman };
  const working = records.filter((record) => {
    const status = record.agent.status;
    return (
      (status.state === "starting" &&
        (state.hasRun ||
          record.agent.id !== lookup(state.agents, state.rootKey ?? "")?.agent.id)) ||
      status.state === "working" ||
      (status.state === "blocked" && status.on === "subagents")
    );
  });
  if (working.length > 0) return { state: "working", agents: working.length };
  for (const reason of ["rate_limit", "network", "upstream"] as const) {
    if (statuses.some((status) => status.state === "blocked" && status.on === reason)) {
      if (reason === "rate_limit") {
        const limits = statuses.flatMap((status) =>
          status.state === "blocked" && status.on === "rate_limit" ? [status.until] : [],
        );
        const until = limits.every((value) => value !== undefined)
          ? Math.max(...limits.filter((value): value is number => value !== undefined))
          : undefined;
        return { state: "limited", ...(until === undefined ? {} : { until }) };
      }
      return { state: "waiting", on: reason };
    }
  }
  if (runningTaskKeys(state).some((key) => lookup(state.tasks, key)?.ambient === false))
    return { state: "waiting", on: "background_task" };
  if (
    records.some(
      (record) =>
        (record.disconnectedAt !== undefined || record.externalStatus?.state === "unresponsive") &&
        record.agent.status.state === "unresponsive",
    )
  )
    return { state: "unresponsive" };
  if (statuses.some((status) => status.state === "blocked" && status.on === "background_task")) {
    return { state: "waiting", on: "background_task" };
  }
  if (
    state.queueCount > 0 ||
    records.some(
      (record) =>
        record.externalStatus?.state === "waiting" && record.externalStatus.on === "queue",
    )
  )
    return { state: "waiting", on: "queue" };
  const holdsCompletion = completionRelevance(
    state,
    (key) => lookup(state.agents, key)!.agent.status,
  );
  if (
    Object.keys(state.agents).some(
      (key) =>
        lookup(state.agents, key)!.agent.status.state === "unresponsive" && holdsCompletion(key),
    )
  )
    return { state: "unresponsive" };
  const root = state.rootKey === undefined ? undefined : lookup(state.agents, state.rootKey);
  const successOrder = root?.lastSuccessfulOutcomeOrder ?? 0;
  if (
    root?.agent.status.state === "failed" ||
    records.some(
      (record) =>
        record.agent.status.state === "failed" && (record.lastOutcomeOrder ?? 0) > successOrder,
    )
  )
    return { state: "failed" };
  if (!state.hasRun)
    return {
      state: state.processExit ? (state.processExit.deliberate ? "done" : "failed") : "new",
    };
  return { state: "done" };
}

export function recomputeStatuses(state: ThreadState, now: number, events: EventPayload[]): void {
  const resolve = statusResolver(state, now);
  for (const [key, record] of Object.entries(state.agents)) {
    const status = resolve(key);
    if (equal(record.agent.status, status)) continue;
    record.agent.status = status;
    emit(events, { type: "agent.status", agentId: record.agent.id, status });
  }
  const status = deriveThreadStatus(state);
  if (equal(state.status, status)) return;
  state.status = status;
  emit(events, { type: "thread.updated", status });
}
