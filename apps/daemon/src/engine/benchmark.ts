/** Non-gating benchmark: real adapter callbacks -> translation -> core -> SQLite -> WS client. */
import { applyDelivery } from "@ace/projection";
import { performance } from "node:perf_hooks";
import type { Fact } from "@ace/core";
import { harness, scriptFrames, start, until } from "./test-support.ts";

for (const history of [10, 100, 1000, 10000]) {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start)] }], frames);
  try {
    const id = await h.create();
    const ctx = h.contexts[0];
    if (!ctx) throw new Error("Missing session");
    // Seed in batches, so preparation obeys the same mailbox bounds as real providers.
    for (let offset = 0; offset < history; offset += 100) {
      const facts: Fact[] = [];
      for (let i = offset; i < Math.min(history, offset + 100); i++)
        facts.push({
          type: "item.upsert",
          agent: "root",
          item: `item:${i}`,
          draft: {
            type: "message",
            role: "assistant",
            parts: [{ type: "text", text: "a".repeat(100) }],
            complete: false,
          },
        });
      ctx.onFrame(frames.frame(...facts));
      await h.engine.flush();
    }
    const client = await h.connect("benchmark");
    client.send({
      type: "subscribe",
      subscriptionId: "bench",
      scope: { kind: "thread", threadId: id },
    });
    const snapshot = await until(client, (message) => message.type === "snapshot");
    if (snapshot.type !== "snapshot" || snapshot.view.kind !== "thread")
      throw new Error("Missing thread snapshot");
    const projected = snapshot.view;
    const iterations = 30;
    const began = performance.now();
    for (let i = 0; i < iterations; i++) {
      ctx.onFrame(
        frames.frame({
          type: "item.delta",
          agent: "root",
          item: "item:0",
          field: "text",
          append: "x",
        }),
      );
      await h.engine.flush();
      for (;;) {
        const message = await client.next();
        if (message.type === "events" || message.type === "progress") {
          const result = applyDelivery(projected, message);
          if (result.kind === "gap") throw new Error("Client delivery gap");
        }
        if (
          message.type === "events" &&
          message.events.some((event) => event.payload.type === "item.delta")
        )
          break;
      }
    }
    const meanFrameMs = (performance.now() - began) / iterations;
    const snapshotBytes = h.store.atomic((db) =>
      Number(
        db.prepare("SELECT length(CAST(state AS BLOB)) AS bytes FROM thread_state").get()?.bytes,
      ),
    );
    process.stdout.write(
      JSON.stringify({ history, iterations, snapshotBytes, meanFrameMs }) + "\n",
    );
  } finally {
    await h.close();
  }
}
