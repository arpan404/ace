import { apply, createThreadState, nextDeadline, type Fact } from "@ace/core";
import { ThreadId, AgentItem, type EventPayload } from "@ace/protocol";
import type { Frame } from "@ace/engine-api";
import { createTranslator } from "./index.ts";
export function harness() {
  const state = createThreadState({
    threadId: ThreadId.parse("test"),
    config: { provider: "claude", silenceMs: 60_000 },
  });
  const events: EventPayload[] = [];
  const diagnostics: import("@ace/protocol").RawPayload[] = [];
  const translator = createTranslator({ rootKey: "root" });
  let sequence = 0;
  let time = 0;
  let nextId = 0;
  const ids = { next: (kind: string) => `${kind}_${++nextId}` };
  function fold(facts: Fact[], now: number) {
    for (const fact of facts) events.push(...apply(state, fact, { now, ids }));
  }
  function send(data: unknown, channel = "sdk", dir: Frame["dir"] = "recv", now = ++time) {
    time = now;
    fold(translator.translate({ seq: sequence++, t: now, dir, channel, data }, now), now);
    diagnostics.push(...(translator.takeDiagnostics?.() ?? []));
  }
  function tick(now: number) {
    time = now;
    fold(translator.tick(now), now);
  }
  const items = (): AgentItem[] => Object.values(state.items).map((item) => AgentItem.parse(item));
  return {
    state,
    events,
    diagnostics,
    deadline: () => nextDeadline(state, translator.nextDeadline?.()),
    send,
    tick,
    items,
    init: () => send({ type: "system", subtype: "init", session_id: "s", cwd: "/repo" }),
    result: (extra = {}) =>
      send({ type: "result", is_error: false, terminal_reason: "completed", ...extra }),
    tool: (id: string, name = "Bash", input: unknown = {}) =>
      send({
        type: "assistant",
        message: { id: `m:${id}`, content: [{ type: "tool_use", id, name, input }] },
        parent_tool_use_id: null,
      }),
    system: (subtype: string, extra = {}) => send({ type: "system", subtype, ...extra }),
  };
}
