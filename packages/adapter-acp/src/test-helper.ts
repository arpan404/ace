import { apply, createThreadState, nextDeadline } from "@ace/core";
import { ThreadId, Item, Agent, Interaction, BackgroundTask, Run } from "@ace/protocol";
import type { Frame } from "@ace/engine-api";
import { createAcpTranslator } from "./index.ts";
import { cursorQuirks } from "./quirks/cursor.ts";
import type { AcpQuirks } from "./quirks/types.ts";
export function harness(quirks: AcpQuirks = cursorQuirks) {
  const threadId = ThreadId.parse("fixture-thread");
  const translator = createAcpTranslator(
    { threadId, rootKey: "root", identity: { generation: "test", cursor: 0 } },
    quirks,
  );
  const state = createThreadState({
    threadId,
    config: { provider: quirks.provider, silenceMs: 90_000 },
  });
  let seq = 0;
  let ids = 0;
  const context = { now: 0, ids: { next: () => `id-${++ids}` } };
  function check() {
    Object.values(state.items).forEach((i) => Item.parse(i));
    Object.values(state.agents).forEach((a) => Agent.parse(a.agent));
    Object.values(state.interactions).forEach((i) => Interaction.parse(i));
    Object.values(state.tasks).forEach((t) => BackgroundTask.parse(t));
    Object.values(state.runs).forEach((r) => Run.parse(r));
    const warnings = Object.values(state.items).filter(
      (i) => i.type === "notice" && i.level === "warning",
    );
    if (warnings.length) throw new Error(JSON.stringify(warnings));
  }
  function replay(nativeFrame: Frame) {
    context.now = nativeFrame.t;
    const facts = translator.translate(nativeFrame, nativeFrame.t);
    const events = facts.flatMap((f) => apply(state, f, context));
    check();
    return events;
  }
  function frame(dir: Frame["dir"], data: unknown, t = ++seq) {
    return replay({ seq: seq++, dir, data, t, channel: dir === "note" ? "recorder" : "stdio" });
  }
  function tick(t: number) {
    context.now = t;
    for (const f of [...translator.tick(t), { type: "tick" as const }]) apply(state, f, context);
    check();
  }
  function ready() {
    frame("send", { id: 1, method: "session/new", params: { cwd: "/workspace" } });
    frame("recv", { id: 1, result: { sessionId: "root-session" } });
    frame("send", {
      id: 2,
      method: "session/prompt",
      params: { sessionId: "root-session", prompt: [{ type: "text", text: "Synthetic input" }] },
    });
  }
  function update(payload: unknown, sessionId = "root-session", t?: number) {
    return frame("recv", { method: "session/update", params: { sessionId, update: payload } }, t);
  }
  const tools = () => Object.values(state.items).filter((i) => i.type === "tool_call");
  return { state, frame, replay, tick, ready, update, tools, deadline: () => nextDeadline(state) };
}

export function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a published entity");
  return value;
}

export function spawn(
  h: ReturnType<typeof harness>,
  id = "child",
  parent = "root-session",
  tool = "spawn",
) {
  h.update(
    {
      sessionUpdate: "subagent_spawned",
      subagentSessionId: id,
      name: "research",
      _meta: { cursor: { toolCallId: tool } },
    },
    parent,
  );
}
export function chunk(
  h: ReturnType<typeof harness>,
  text: string,
  session = "root-session",
  thought = false,
) {
  h.update(
    {
      sessionUpdate: thought ? "agent_thought_chunk" : "agent_message_chunk",
      content: { type: "text", text },
    },
    session,
  );
}
export function end(h: ReturnType<typeof harness>, stopReason = "end_turn") {
  h.frame("recv", { id: 2, result: { stopReason } });
}
