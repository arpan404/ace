import { EventPayload, ThreadId, type ProviderKind } from "@ace/protocol";
import { expect } from "vitest";
import { apply, createThreadState, type CoreConfig, type Fact, type ThreadState } from "./index.ts";

/** Also catches fields stripped by the protocol schemas, such as unrepresentable links. */
export function assertPayloads(events: EventPayload[]): void {
  for (const event of events) expect(EventPayload.parse(event)).toEqual(event);
}

export function harness(
  provider: ProviderKind = "codex",
  config: CoreConfig = { silenceMs: 90_000 },
) {
  let sequence = 0;
  let time = 100;
  const ids = { next: (kind: string) => `${kind}_${++sequence}` };
  const state = createThreadState({
    threadId: ThreadId.parse("thread_1"),
    config,
  });
  const history: EventPayload[] = [];
  function send(fact: Fact, now = ++time, target: ThreadState = state) {
    time = now;
    const events = apply(target, fact, { now, ids });
    assertPayloads(events);
    history.push(...events);
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
  return { state, send, see, start, end, shell, background, question, history, ids };
}
