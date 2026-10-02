/** Non-gating benchmark: real adapter callbacks -> translation -> core -> SQLite -> WS client. */
import { applyDelivery, trackItem } from "@ace/projection";
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
    const oldest = h.store
      .readEvents({ afterSeq: 0, threadId: id, limit: 1000 })
      .find((event) => event.payload.type === "item.created");
    if (
      oldest?.payload.type === "item.created" &&
      !Object.hasOwn(projected.items, oldest.payload.item.id)
    ) {
      client.send({
        type: "items.page",
        requestId: "tracked",
        threadId: id,
        before: oldest.seq + 1,
        limit: 1,
      });
      const page = await until(client, (message) => message.type === "items.page");
      if (page.type !== "items.page" || !page.items[0]) throw new Error("Missing tracked history");
      trackItem(projected, page.items[0]);
    }
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

// A single active message must not revisit its accumulated text on every frame.
for (const streamBytes of [1024, 1024 * 1024 + 1, 4 * 1024 * 1024]) {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start)] }], frames);
  try {
    const id = await h.create();
    const ctx = h.contexts[0];
    if (!ctx) throw new Error("Missing session");
    for (let remaining = streamBytes; remaining > 0;) {
      const count = Math.min(remaining, 512 * 1024);
      ctx.onFrame(
        frames.frame({
          type: "item.delta",
          agent: "root",
          item: "stream",
          field: "text",
          append: "a".repeat(count),
        }),
      );
      await h.engine.flush();
      remaining -= count;
    }
    const client = await h.connect("stream-benchmark");
    client.send({
      type: "subscribe",
      subscriptionId: "bench",
      scope: { kind: "thread", threadId: id },
    });
    const snapshot = await until(client, (message) => message.type === "snapshot");
    if (snapshot.type !== "snapshot" || snapshot.view.kind !== "thread")
      throw new Error("Missing snapshot");
    client.send({
      type: "items.page",
      requestId: "detail",
      threadId: id,
      before: h.store.headSeq() + 1,
      limit: 1,
    });
    const page = await until(client, (message) => message.type === "items.page");
    if (page.type !== "items.page" || !page.items[0]) throw new Error("Missing stream detail");
    trackItem(snapshot.view, page.items[0]);
    const iterations = 30;
    const began = performance.now();
    for (let i = 0; i < iterations; i++) {
      ctx.onFrame(
        frames.frame({
          type: "item.delta",
          agent: "root",
          item: "stream",
          field: "text",
          append: "x",
        }),
      );
      await h.engine.flush();
      for (;;) {
        const message = await client.next();
        if (message.type === "events" || message.type === "progress") {
          if (applyDelivery(snapshot.view, message).kind === "gap")
            throw new Error("Client delivery gap");
        }
        if (
          message.type === "events" &&
          message.events.some((event) => event.payload.type === "item.delta")
        )
          break;
      }
    }
    process.stdout.write(
      JSON.stringify({
        streamBytes,
        iterations,
        meanFrameMs: (performance.now() - began) / iterations,
      }) + "\n",
    );
    if (h.errors.length) throw new Error("Benchmark frame processing failed");
  } finally {
    await h.close();
  }
}
