import { acceptsPersonInput, deriveThreadStatus, type Fact } from "@ace/core";
import { CommandId, type ContentPart, type MessageContext } from "@ace/protocol";
import type { ThreadHost } from "./thread-host.ts";

/**
 * How the fake daemon acts on a person's thread commands. There is no model behind it: a sent
 * message starts a turn that stays open until a script ends it or the person interrupts it, a
 * queued message waits until the root agent's turn ends (background work and subagents keep
 * running past it). Pure: returns the facts to apply.
 */
export type ThreadCommandOutcome = { ok: true; facts: Fact[] } | { ok: false; error: string };

/** Text sent to the agent, with file mentions written the way a provider would see them. */
export function inputText(
  input: readonly ContentPart[],
  context: MessageContext | undefined,
): string {
  const text = input
    .flatMap((part) =>
      part.type === "text" ? [part.text] : part.type === "mention" ? [part.name] : [],
    )
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

/**
 * Like the daemon: a person's plain message starts the next turn once the root agent is between
 * turns, even while background commands and subagents run. One that changes the model or
 * options waits for the whole tree, since switching may reopen the session.
 */
function takesMessage(host: ThreadHost, plain: boolean): boolean {
  return !busy(host) || (plain && acceptsPersonInput(host.state, host.foldedAt));
}

/** A steer joins the root's running turn; with none running it starts the next one. */
export function steerOrStart(host: ThreadHost, key: string, text: string): Fact[] {
  const root = host.state.rootKey;
  return root !== undefined && host.state.agents[root]?.activeRun
    ? steerFacts(host, key, text)
    : startTurn(host, key, text);
}

/** Admission owns the user bubble. Provider delivery reuses this exact item key. */
export function admissionFacts(
  host: ThreadHost,
  key: string,
  input: readonly ContentPart[],
  attachments: readonly import("@ace/protocol").Attachment[] = [],
): Fact[] {
  const root = host.state.rootKey;
  if (root === undefined) return [];
  return [
    {
      type: "item.upsert",
      agent: root,
      item: `input:${key}`,
      draft: {
        type: "message",
        role: "user",
        complete: true,
        synthetic: false,
        parts: [...input],
        origin: { kind: "person", commandId: CommandId.parse(key) },
        // The admitted bubble owns attachment metadata, as in the daemon (ADR 0065).
        ...(attachments.length ? { attachments: [...attachments] } : {}),
      },
    },
  ];
}
/** A provider turn starts after input admission, without creating another bubble. */
export function startTurn(host: ThreadHost, key: string, _text: string): Fact[] {
  const root = host.state.rootKey;
  if (root === undefined) return [];
  return [
    ...(host.state.processExit ? [{ type: "process.started" } as const] : []),
    { type: "turn.started", agent: root, nativeTurnId: `turn-${key}`, trigger: "user" },
  ];
}
/** Steering acknowledges an admitted input without fabricating an echo item. */
function steerFacts(host: ThreadHost, key: string, _text: string): Fact[] {
  const root = host.state.rootKey;
  if (root === undefined) return [];
  return [{ type: "input.admitted", agent: root, nativeInputId: key, commandId: key }];
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
    attachments?: import("@ace/protocol").Attachment[];
  },
): ThreadCommandOutcome {
  const root = host.state.rootKey;
  if (root === undefined) return { ok: false, error: "no_agent" };
  const text = inputText(payload.input, payload.context);
  // Like the daemon: any new message, the person's or a parent agent's, is the go-ahead after a
  // Stop or a restart, so it never waits behind that hold.
  if (
    host.queue.paused &&
    (host.queue.reason === "stopped" || host.queue.reason === "restart") &&
    !host.queued.some((message) => message.state === "uncertain")
  ) {
    host.queue.paused = false;
    host.queue.reason = null;
    host.queueDirty = true;
  }
  // A held queue (paused, limited, uncertain) keeps every send in order.
  const plain = payload.model === undefined && payload.options === undefined;
  if (takesMessage(host, plain) && !host.queue.paused && !host.queued.length) {
    host.nextSelection = {
      ...(payload.model ? { model: payload.model } : {}),
      ...(payload.options ? { options: payload.options } : {}),
    };
    return {
      ok: true,
      facts: [
        ...admissionFacts(host, commandId, payload.input, payload.attachments),
        ...startTurn(host, commandId, text),
      ],
    };
  }
  if (payload.delivery === "steer" && !host.queue.paused && plain)
    return {
      ok: true,
      facts: [
        ...admissionFacts(host, commandId, payload.input, payload.attachments),
        ...steerOrStart(host, commandId, text),
      ],
    };
  if (host.queued.length >= 256) return { ok: false, error: "queue_limit" };
  host.queued.push({
    key: commandId,
    text,
    input: [...payload.input],
    ...(payload.attachments ? { attachments: payload.attachments } : {}),
    ...(payload.context ? { context: payload.context } : {}),
    delivery: payload.delivery,
    state: "queued",
    ...(payload.model ? { model: payload.model } : {}),
    ...(payload.options ? { options: payload.options } : {}),
  });
  host.queueDirty = true;
  return {
    ok: true,
    // Like the daemon, a queued message joins the transcript when it is delivered.
    facts: [{ type: "queue.changed", count: host.queued.length }],
  };
}

/** A free root agent takes the oldest queued message: it joins the transcript and starts a turn. */
export function drainQueue(host: ThreadHost): Fact[] {
  const root = host.state.rootKey;
  const next = host.queued[0];
  if (root === undefined || !next || host.queue.paused) return [];
  if (!takesMessage(host, next.model === undefined && next.options === undefined)) return [];
  host.queued.shift();
  host.queueDirty = true;
  host.nextSelection = {
    ...(next.model ? { model: next.model } : {}),
    ...(next.options ? { options: next.options } : {}),
  };
  return [
    { type: "queue.changed", count: host.queued.length },
    ...admissionFacts(host, next.key, next.input, next.attachments),
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
  // Like the daemon, Stop holds what was queued behind the stopped work: it sends on the
  // person's Resume or next message, never by itself once the turn ends.
  if (host.queued.length && !host.queue.paused) {
    host.queue.paused = true;
    host.queue.reason = "stopped";
    host.queue.resumeAt = null;
    host.queueDirty = true;
  }
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
