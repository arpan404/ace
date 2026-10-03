import { deriveThreadStatus, type Fact } from "@ace/core";
import type { ContentPart, MessageContext } from "@ace/protocol";
import type { ThreadHost } from "./thread-host.ts";

/**
 * How the fake daemon acts on a person's thread commands. There is no model behind it: a sent
 * message starts a turn that stays open until a script ends it or the person interrupts it, a
 * queued message waits until the root agent's turn ends. Pure: returns the facts to apply.
 */
export type ThreadCommandOutcome = { ok: true; facts: Fact[] } | { ok: false; error: string };

/** Text sent to the agent, with file mentions written the way a provider would see them. */
export function inputText(
  input: readonly ContentPart[],
  context: MessageContext | undefined,
): string {
  const text = input
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
    .trim();
  const files = (context?.mentions ?? []).map((mention) => mention.path);
  return files.length && !files.every((path) => text.includes(`@${path}`))
    ? `${text}\n\n${files.map((path) => `@${path}`).join(" ")}`
    : text;
}

export function busy(host: ThreadHost): boolean {
  return !["new", "done", "failed"].includes(
    deriveThreadStatus({ ...host.state, queueCount: host.state.queueSources.provider }).state,
  );
}

/** A user message that starts a fresh root turn. */
export function startTurn(host: ThreadHost, key: string, text: string): Fact[] {
  const root = host.state.rootKey;
  if (root === undefined) return [];
  return [
    { type: "turn.started", agent: root, nativeTurnId: `turn-${key}`, trigger: "user" },
    {
      type: "item.upsert",
      agent: root,
      item: `input-${key}`,
      draft: { type: "message", role: "user", complete: true, parts: [{ type: "text", text }] },
    },
  ];
}

/** A user message delivered into the running turn without ending it. */
export function steerFacts(host: ThreadHost, key: string, text: string): Fact[] {
  const root = host.state.rootKey;
  if (root === undefined) return [];
  return [
    {
      type: "item.upsert",
      agent: root,
      item: `input-${key}`,
      draft: { type: "message", role: "user", complete: true, parts: [{ type: "text", text }] },
    },
  ];
}

export function sendFacts(
  host: ThreadHost,
  commandId: string,
  payload: {
    model?: string | undefined;
    options?: import("@ace/protocol").TurnOptions | undefined;
    input: readonly ContentPart[];
    context?: MessageContext | undefined;
    delivery: "steer" | "queue";
  },
): ThreadCommandOutcome {
  const root = host.state.rootKey;
  if (root === undefined) return { ok: false, error: "no_agent" };
  const text = inputText(payload.input, payload.context);
  // A held queue (paused, limited, after a restart) keeps every send in order.
  if (!busy(host) && !host.queue.paused) {
    host.nextSelection = {
      ...(payload.model ? { model: payload.model } : {}),
      ...(payload.options ? { options: payload.options } : {}),
    };
    return { ok: true, facts: startTurn(host, commandId, text) };
  }
  if (
    payload.delivery === "steer" &&
    !host.queue.paused &&
    payload.model === undefined &&
    payload.options === undefined
  )
    return { ok: true, facts: steerFacts(host, commandId, text) };
  if (host.queued.length >= 256) return { ok: false, error: "queue_limit" };
  host.queued.push({
    key: commandId,
    text,
    input: [...payload.input],
    ...(payload.context ? { context: payload.context } : {}),
    delivery: payload.delivery,
    state: "queued",
    ...(payload.model ? { model: payload.model } : {}),
    ...(payload.options ? { options: payload.options } : {}),
  });
  host.queueDirty = true;
  return { ok: true, facts: [{ type: "queue.changed", count: host.queued.length }] };
}

/** Once the root agent is free, the oldest queued message starts the next turn. */
export function drainQueue(host: ThreadHost): Fact[] {
  const root = host.state.rootKey;
  if (root === undefined || busy(host) || host.queue.paused) return [];
  const next = host.queued.shift();
  if (!next) return [];
  host.queueDirty = true;
  host.nextSelection = {
    ...(next.model ? { model: next.model } : {}),
    ...(next.options ? { options: next.options } : {}),
  };
  return [
    { type: "queue.changed", count: host.queued.length },
    ...startTurn(host, next.key, next.text),
  ];
}

/** Stop the target agent's turn (root by default) and, with `cascade`, its running descendants. */
export function interruptFacts(
  host: ThreadHost,
  agentId: string | undefined,
  cascade: boolean,
): ThreadCommandOutcome {
  const target = agentId ?? host.view.thread.rootAgentId;
  if (!Object.values(host.state.agents).some((record) => record.agent.id === target))
    return { ok: false, error: "agent_not_found" };
  const keys = host.interruptKeys(target, cascade);
  return {
    ok: true,
    facts: keys.map((agent) => ({ type: "turn.ended", agent, outcome: "interrupted" })),
  };
}

export function stopTaskFacts(host: ThreadHost, taskId: string): ThreadCommandOutcome | undefined {
  const key = host.taskKey(taskId);
  const task = key === undefined ? undefined : host.state.tasks[key];
  if (key === undefined || !task) return undefined;
  // The daemon's answer for both: nothing left to stop.
  if (!task.stoppable || task.status !== "running")
    return { ok: false, error: "task_not_stoppable" };
  return { ok: true, facts: [{ type: "background.ended", task: key, status: "stopped" }] };
}
