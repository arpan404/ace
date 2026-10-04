import { expect, test } from "vitest";
import type { Fact } from "@ace/core";
import { harness, scriptFrames, start, question } from "./test-support.ts";

function approval(interaction: string): Fact {
  if (question.type !== "interaction.opened") throw new Error("Expected approval fixture");
  return { ...question, interaction };
}

test("a lone transport heartbeat revives a silent working thread before acknowledgement", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start)] }], frames);
  try {
    const id = await h.create();
    h.clock.advance(1200);
    await h.engine.flush();
    expect(h.store.getThread(id)?.status.state).toBe("unresponsive");
    const context = h.contexts[0];
    if (!context) throw new Error("Missing provider context");
    const acknowledgement = context.onFrame(frames.frame({ type: "signal", agent: "root" }));
    await h.engine.flush();
    await acknowledgement;
    expect(h.store.getThread(id)?.status.state).toBe("working");
    expect(h.errors).toEqual([]);
  } finally {
    await h.close();
  }
});

test("transcript writes stay bounded while hundreds of approvals remain actionable", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start)] }], frames);
  try {
    const id = await h.create();
    const context = h.contexts[0];
    if (!context) throw new Error("Missing provider context");
    for (let first = 0; first < 400; first += 100) {
      const facts = Array.from({ length: 100 }, (_, i): Fact[] => [
        { type: "signal", agent: "root" },
        approval(`approval:${first + i}`),
      ]).flat();
      context.onFrame(frames.frame(...facts));
      await h.engine.flush();
    }
    const statusBytes = Number(
      h.store
        .statement(
          "SELECT SUM(length(CAST(payload AS BLOB))) AS n FROM events WHERE thread_id=? AND type='agent.status'",
        )
        .get(id)?.n,
    );
    expect(statusBytes).toBeLessThan(64 * 1024);
    const before = Number(h.store.statement("SELECT total_changes() AS n").get()?.n);
    context.onFrame(
      frames.frame({
        type: "item.upsert",
        agent: "root",
        item: "message",
        draft: {
          type: "message",
          role: "assistant",
          parts: [{ type: "text", text: "still waiting" }],
          complete: true,
        },
      }),
    );
    await h.engine.flush();
    const writes = Number(h.store.statement("SELECT total_changes() AS n").get()?.n) - before;
    expect(h.errors).toEqual([]);
    expect(h.store.getThread(id)?.status).toEqual({ state: "needs_you", interactions: 400 });
    expect(writes).toBeLessThan(100);
    context.onFrame(
      frames.frame({ type: "interaction.closed", interaction: "approval:0", state: "resolved" }),
    );
    await h.engine.flush();
    expect(h.store.getThread(id)?.status).toEqual({ state: "needs_you", interactions: 399 });
    const persisted = h.store
      .statement(
        "SELECT value FROM engine_state_records WHERE thread_id=? AND section='interactions' AND key=?",
      )
      .get(id, "approval:0");
    expect(JSON.parse(String(persisted?.value))).toMatchObject({
      state: "resolved",
      closedAt: h.clock.now(),
    });
  } finally {
    await h.close();
  }
});

test("transcript batching publishes completion at every turn boundary in one provider frame", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start)] }], frames);
  try {
    const id = await h.create();
    const context = h.contexts[0];
    if (!context) throw new Error("Missing provider context");
    context.onFrame(
      frames.frame(
        {
          type: "item.upsert",
          agent: "root",
          item: "first",
          draft: {
            type: "message",
            role: "assistant",
            parts: [{ type: "text", text: "first result" }],
            complete: true,
          },
        },
        { type: "turn.ended", agent: "root", outcome: "completed" },
        { type: "turn.started", agent: "root", trigger: "schedule" },
        approval("last approval"),
        { type: "interaction.closed", interaction: "last approval", state: "resolved" },
        {
          type: "item.upsert",
          agent: "root",
          item: "second",
          draft: {
            type: "message",
            role: "assistant",
            parts: [{ type: "text", text: "second result" }],
            complete: true,
          },
        },
        { type: "turn.ended", agent: "root", outcome: "completed" },
      ),
    );
    await h.engine.flush();
    expect(h.errors).toEqual([]);
    expect(h.store.getThread(id)?.status).toEqual({ state: "done" });
    const turns = h.store
      .statement(
        "SELECT root_outcome,settled_seq,latest FROM long_turns WHERE thread_id=? ORDER BY ordinal",
      )
      .all(id);
    expect(turns).toHaveLength(2);
    expect(turns.map((turn) => turn.root_outcome)).toEqual(["completed", "completed"]);
    expect(turns.every((turn) => turn.settled_seq != null)).toBe(true);
    expect(turns.map((turn) => turn.latest)).toEqual(["first result", "second result"]);
  } finally {
    await h.close();
  }
});
