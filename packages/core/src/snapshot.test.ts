import type { EventPayload } from "@ace/protocol";
import { describe, expect, it } from "vitest";
import { type Fact, type ThreadState } from "./index.ts";
import { applyToClient, harness } from "./test-helper.ts";
import { createClientView, foldPayload } from "./client-view.test-helper.ts";

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
    expect(h.item("message")).toMatchObject({
      parts: [{ text: "original" }],
      raw: [{ data: { nested: "original" } }],
    });
    const error = { kind: "provider" as const, message: "original failure" };
    h.send({ type: "turn.ended", agent: "root", outcome: "failed", error });
    error.message = "changed failure";
    h.send({ type: "tick" });
    expect(h.agent("root")?.status).toMatchObject({
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
    expect(configured.view.status.state).toBe("working");
    configured.send({ type: "tick" }, 108);
    expect(configured.view.status).toEqual({ state: "unresponsive" });
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
      const view = createClientView();
      for (const payload of h.history) foldPayload(view, payload);
      for (const [index, fact] of facts.entries()) {
        const emitted = applyToClient(
          state,
          fact,
          {
            now: 5_000 + index,
            ids: { next: (kind) => `${kind}_${++sequence}` },
          },
          view,
        );
        events.push(...emitted);
      }
      return { events, view };
    }
    const beforeRestore = replay(original);
    const afterRestore = replay(snapshot);
    expect(afterRestore.events).toEqual(beforeRestore.events);
    expect(afterRestore.view).toEqual(beforeRestore.view);
    expect(afterRestore.view.status).toEqual({ state: "done" });
  });

  it("opaque ace ids resembling prototype names preserve every entity through client replay", () => {
    const h = harness();
    const names: Record<string, string> = {
      agent: "__proto__",
      run: "constructor",
      item: "toString",
      interaction: "__defineGetter__",
      task: "valueOf",
    };
    h.ids.next = (kind) => names[kind]!;
    h.see();
    const started = h.start().find((event) => event.type === "run.started");
    h.shell();
    h.background();
    h.question();
    h.send({ type: "item.delta", agent: "root", item: "shell", field: "output", append: "Output" });
    expect(h.item("shell")).toMatchObject({
      call: { detail: { output: { bytes: 6, tail: "Output", truncated: false } } },
    });
    h.end();
    expect(h.interaction("question")?.state).toBe("cancelled");
    expect(h.agent("root")?.status).toMatchObject({ state: "blocked", on: "background_task" });
    expect(started && h.view.runs[started.run.id]).toMatchObject({ state: "completed" });
    h.send({ type: "background.ended", task: "task", status: "completed" });
    expect(h.task("task")?.status).toBe("completed");
    expect(h.agent("root")?.status).toEqual({ state: "idle" });
    expect(h.view.status).toEqual({ state: "done" });
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
      expect(h.item(key)).toMatchObject({ type: "reasoning", text: "safe" });
      const again = restored(state);
      h.send({ type: "turn.ended", agent: key, outcome: "completed" }, 203, again);
      expect(h.agent(key)?.status).toEqual({ state: "idle" });
    },
  );
});
