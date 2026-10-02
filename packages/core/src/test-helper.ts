import {
  EventPayload,
  ThreadId,
  type ProviderKind,
  type EventPayload as Payload,
} from "@ace/protocol";
import { expect } from "vitest";
import {
  createClientView,
  foldPayload,
  assertClientMatchesState,
  type ClientView,
} from "./client-view.ts";
import {
  apply,
  createThreadState,
  type CoreConfig,
  type Fact,
  type ThreadState,
  type ApplyContext,
} from "./index.ts";

/** Also catches fields stripped by the protocol schemas, such as unrepresentable links. */
export function assertPayloads(events: EventPayload[]): void {
  for (const event of events) expect(EventPayload.parse(event)).toEqual(event);
}

/** Every test application parses payloads and checks the client's replayed rows. */
export function applyToClient(
  state: ThreadState,
  fact: unknown,
  ctx: ApplyContext,
  view: ClientView,
): EventPayload[] {
  const events = apply(state, fact, ctx);
  assertPayloads(events);
  for (const event of events) foldPayload(view, event);
  assertClientMatchesState(view, state);
  return events;
}

export function harness(
  provider: ProviderKind = "codex",
  config: Omit<CoreConfig, "provider"> & { provider?: ProviderKind } = { silenceMs: 90_000 },
  rootAgent?: Parameters<typeof createThreadState>[0]["rootAgent"],
) {
  let sequence = 0;
  let time = 100;
  const ids = { next: (kind: string) => `${kind}_${++sequence}` };
  const state = createThreadState({
    threadId: ThreadId.parse("thread_1"),
    config: { ...config, provider: config.provider ?? provider },
    ...(rootAgent ? { rootAgent } : {}),
  });
  const history: EventPayload[] = [];
  const view = createClientView();
  const keys = {
    agents: new Map<string, string>(),
    items: new Map<string, string>(),
    interactions: new Map<string, string>(),
    tasks: new Map<string, string>(),
  };
  function recordKeys(input: unknown, events: Payload[]) {
    for (const event of events) {
      if (event.type === "agent.created" && event.agent.native.nativeId !== undefined)
        keys.agents.set(event.agent.native.nativeId, event.agent.id);
    }
    // Diagnostics have their own identities and must never replace the adapter's item.
    if (
      events.some(
        (event) =>
          event.type === "item.created" &&
          event.item.type === "notice" &&
          event.item.raw?.some((raw) => raw.type === "core.rejected_fact"),
      )
    )
      return;
    if (typeof input !== "object" || input === null || !("type" in input)) return;
    const fact = input as Fact;
    for (const event of events) {
      if (event.type === "item.created" && "item" in fact && typeof fact.item === "string")
        keys.items.set(fact.item, event.item.id);
      if (event.type === "interaction.opened" && fact.type === "interaction.opened")
        keys.interactions.set(fact.interaction, event.interaction.id);
      if (event.type === "background_task.started" && fact.type === "background.started")
        keys.tasks.set(fact.task, event.task.id);
    }
  }

  function send(fact: unknown, now = ++time, target: ThreadState = state) {
    time = now;
    const events = applyToClient(target, fact, { now, ids }, view);
    history.push(...structuredClone(events));
    recordKeys(fact, events);

    return events;
  }
  function see(agent = "root", parent?: string, isBackground = false) {
    return send({
      type: "agent.seen",
      agent,
      ...(parent === undefined ? {} : { parent }),
      origin: parent === undefined ? "root" : "provider_subagent",
      fidelity: "full",
      native: { provider, nativeId: agent },
      cwd: "/repo",
      background: isBackground,
    });
  }
  function start(agent = "root", nativeTurnId = `${agent}-turn`) {
    return send({ type: "turn.started", agent, nativeTurnId, trigger: "user" });
  }
  function end(agent = "root", outcome: "completed" | "interrupted" | "failed" = "completed") {
    return send({ type: "turn.ended", agent, outcome });
  }
  function shell(item = "shell", agent = "root") {
    return send({
      type: "item.upsert",
      agent,
      item,
      draft: {
        type: "tool_call",
        complete: false,
        call: {
          kind: "shell",
          title: "Long command",
          status: "running",
          detail: { kind: "shell", command: "loop" },
          raw: [],
        },
      },
    });
  }
  function background(task = "task", item = "shell", agent = "root") {
    return send({
      type: "background.started",
      agent,
      task,
      kind: "shell",
      title: "Long command",
      item,
      stoppable: true,
    });
  }
  function question(interaction = "question", agent = "root", blocking = true) {
    return send({
      type: "interaction.opened",
      agent,
      interaction,
      blocking,
      request: {
        kind: "question",
        questions: [
          { id: "q", text: "Continue?", options: [], multiSelect: false, allowOther: true },
        ],
      },
    });
  }
  const agent = (key: string) => view.agents[keys.agents.get(key) ?? ""];
  const item = (key: string) => view.items[keys.items.get(key) ?? ""];
  const interaction = (key: string) => view.interactions[keys.interactions.get(key) ?? ""];
  const task = (key: string) => view.tasks[keys.tasks.get(key) ?? ""];
  return {
    state,
    view,
    send,
    see,
    start,
    end,
    shell,
    background,
    question,
    history,
    ids,
    agent,
    item,
    interaction,
    task,
  };
}
