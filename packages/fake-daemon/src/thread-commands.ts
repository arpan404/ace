import type { Fact, Key } from "@ace/core";
import type { ContentPart, MessageContext } from "@ace/protocol";
import type { ThreadHost } from "./thread-host.ts";

/**
 * How the fake daemon acts on a person's thread commands. There is no model behind it: a sent
 * message starts a turn that stays open until a script ends it or the person interrupts it, a
 * queued message waits until the root agent's turn ends. Pure: returns the facts to apply.
 */
export type ThreadCommandOutcome = { ok: true; facts: Fact[] } | { ok: false; error: string };

/** Text sent to the agent, with file mentions written the way a provider would see them. */
function inputText(input: readonly ContentPart[], context: MessageContext | undefined): string {
  const text = input
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
    .trim();
  const files = (context?.mentions ?? []).map((mention) => mention.path);
  return files.length && !files.every((path) => text.includes(`@${path}`))
    ? `${text}\n\n${files.map((path) => `@${path}`).join(" ")}`
    : text;
}

function busy(host: ThreadHost, key: Key): boolean {
  return host.state.agents[key]?.activeRun !== undefined;
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

export function sendFacts(
  host: ThreadHost,
  commandId: string,
  payload: {
    input: readonly ContentPart[];
    context?: MessageContext | undefined;
    delivery: "steer" | "queue";
  },
): ThreadCommandOutcome {
  const root = host.state.rootKey;
  if (root === undefined) return { ok: false, error: "no_agent" };
  const text = inputText(payload.input, payload.context);
  if (!busy(host, root)) return { ok: true, facts: startTurn(host, commandId, text) };
  if (payload.delivery === "steer")
    return {
      ok: true,
      facts: [
        {
          type: "item.upsert",
          agent: root,
          item: `input-${commandId}`,
          draft: {
            type: "message",
            role: "user",
            complete: true,
            parts: [{ type: "text", text }],
          },
        },
      ],
    };
  host.queued.push({ key: commandId, text });
  return { ok: true, facts: [{ type: "queue.changed", count: host.queued.length }] };
}

/** Once the root agent is free, the oldest queued message starts the next turn. */
export function drainQueue(host: ThreadHost): Fact[] {
  const root = host.state.rootKey;
  if (root === undefined || busy(host, root)) return [];
  const next = host.queued.shift();
  if (!next) return [];
  return [
    { type: "queue.changed", count: host.queued.length },
    ...startTurn(host, next.key, next.text),
  ];
}

/** Stop the root agent's turn and, with `cascade`, every other agent mid-turn. */
export function interruptFacts(
  host: ThreadHost,
  agentId: string | undefined,
  cascade: boolean,
): ThreadCommandOutcome {
  const target =
    agentId === undefined ? host.state.rootKey : host.state.indexes.agentKeysById[agentId];
  if (target === undefined) return { ok: false, error: "agent_not_found" };
  const keys = cascade
    ? Object.keys(host.state.agents).filter((key) => busy(host, key))
    : busy(host, target)
      ? [target]
      : [];
  // Children first, so no parent ends while a child it waits on still runs.
  const ordered = keys.toSorted((a, b) => Number(a === target) - Number(b === target));
  return {
    ok: true,
    facts: ordered.map((agent) => ({ type: "turn.ended", agent, outcome: "interrupted" })),
  };
}

export function stopTaskFacts(host: ThreadHost, taskId: string): ThreadCommandOutcome | undefined {
  for (const [key, task] of Object.entries(host.state.tasks)) {
    if (task.id !== taskId) continue;
    if (!task.stoppable) return { ok: false, error: "not_stoppable" };
    if (task.status !== "running") return { ok: false, error: "not_running" };
    return { ok: true, facts: [{ type: "background.ended", task: key, status: "stopped" }] };
  }
  return undefined;
}
