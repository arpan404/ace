import type { EventPayload } from "@ace/protocol";
import { describe, expect, it } from "vitest";
import { apply, type Fact, type ThreadState } from "./index.ts";
import { assertPayloads, harness } from "./test-helper.ts";

function restored(state: ThreadState): ThreadState {
  return JSON.parse(JSON.stringify(state)) as ThreadState;
}

describe("snapshot and payload integrity", () => {
  it("keeps state independent when the adapter later mutates its draft and failure facts", () => {
    const h = harness();
    h.see();
    h.start();
    const parts = [{ type: "text" as const, text: "original" }];
    const raw = [{ type: "native", data: { nested: "original" } }];
    h.send({
      type: "item.upsert",
      agent: "root",
      item: "message",
      draft: { type: "message", role: "assistant", parts, raw, complete: false },
    });
    parts[0]!.text = "changed";
    raw[0]!.data.nested = "changed";
    expect(h.state.items.message).toMatchObject({
      parts: [{ text: "original" }],
      raw: [{ data: { nested: "original" } }],
    });
    const error = { kind: "provider" as const, message: "original failure" };
    h.send({ type: "turn.ended", agent: "root", outcome: "failed", error });
    error.message = "changed failure";
    h.send({ type: "tick" });
    expect(h.state.agents.root?.agent.status).toMatchObject({
      state: "failed",
      error: { message: "original failure" },
    });
  });

  it("does not mutate prior payloads, incoming facts, or initial config", () => {
    const h = harness();
    h.see();
    const fact: Fact = {
      type: "item.upsert",
      agent: "root",
      item: "message",
      draft: {
        type: "message",
        role: "assistant",
        parts: [{ type: "text", text: "first" }],
        complete: false,
        raw: [{ type: "native", data: { text: "first" } }],
      },
    };
    const initialFact = structuredClone(fact);
    h.start();
    h.send(fact);
    const history = structuredClone(h.history);
    h.send({
      type: "item.delta",
      agent: "root",
      item: "message",
      field: "text",
      append: " second",
    });
    h.end();
    expect(h.history.slice(0, history.length)).toEqual(history);
    expect(fact).toEqual(initialFact);
    const config = { silenceMs: 5 };
    const configured = harness("codex", config);
    config.silenceMs = 1;
    configured.see();
    configured.start();
    configured.send({ type: "tick" }, 105);
    expect(configured.state.status.state).toBe("working");
    configured.send({ type: "tick" }, 108);
    expect(configured.state.status).toEqual({ state: "unresponsive" });
  });

  it("produces identical payloads and state before and after a JSON snapshot", () => {
    const h = harness();
    h.see();
    h.start();
    h.shell();
    h.background();
    h.question();
    const original = structuredClone(h.state);
    const snapshot = restored(h.state);
    const facts: Fact[] = [
      { type: "interaction.closed", interaction: "question", state: "resolved" },
      { type: "turn.ended", agent: "root", outcome: "completed" },
      { type: "background.ended", task: "task", status: "completed" },
      { type: "turn.started", agent: "root", trigger: "background_completion" },
      { type: "turn.ended", agent: "root", outcome: "completed" },
    ];
    function replay(state: ThreadState) {
      let sequence = 1_000;
      const events: EventPayload[] = [];
      for (const [index, fact] of facts.entries())
        events.push(
          ...apply(state, fact, {
            now: 5_000 + index,
            ids: { next: (kind) => `${kind}_${++sequence}` },
          }),
        );
      assertPayloads(events);
      return events;
    }
    expect(replay(original)).toEqual(replay(snapshot));
    expect(snapshot).toEqual(original);
    expect(snapshot.status).toEqual({ state: "done" });
  });

  it.each(["__proto__", "constructor", "toString"])(
    "supports native key %s before and after snapshot restore",
    (key) => {
      const h = harness();
      h.see();
      const state = restored(h.state);
      h.send({ type: "turn.started", agent: key, trigger: "spawn" }, 200, state);
      h.send(
        {
          type: "item.upsert",
          agent: key,
          item: key,
          draft: { type: "reasoning", text: "", complete: false },
        },
        201,
        state,
      );
      h.send(
        { type: "item.delta", agent: key, item: key, field: "reasoning", append: "safe" },
        202,
        state,
      );
      expect(state.items[key]).toMatchObject({ type: "reasoning", text: "safe" });
      const again = restored(state);
      h.send({ type: "turn.ended", agent: key, outcome: "completed" }, 203, again);
      expect(again.agents[key]?.agent.status).toEqual({ state: "idle" });
    },
  );
});
