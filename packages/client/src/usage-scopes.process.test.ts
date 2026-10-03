import { expect, test } from "vitest";
import { EventPayload } from "@ace/protocol";
import { usageSnapshotKey } from "@ace/projection";
import { setup, ready, when, barrier } from "./test-support.ts";

test("agent activity and multiple model snapshots survive live delivery and snapshot reconnect separately", async () => {
  const h = await setup();
  try {
    const root = EventPayload.parse({
      type: "usage.updated",
      agentId: "root",
      inputTokens: 10,
      outputTokens: 2,
    });
    const models = ["sonnet", "opus"].map((model) =>
      EventPayload.parse({
        type: "usage.updated",
        agentId: "root",
        inputTokens: 100,
        outputTokens: 20,
        usageScope: "model_session",
        model,
        counterKey: "session:initial",
        costUsd: 3,
      }),
    );
    const total = EventPayload.parse({
      type: "usage.updated",
      agentId: "root",
      inputTokens: 200,
      outputTokens: 40,
      usageScope: "provider_session",
      counterKey: "session:initial",
      costUsd: 6,
    });
    if (total.type !== "usage.updated") throw new Error("Expected usage");
    const key = usageSnapshotKey(total);
    const { client, faults, scheduler } = h.make();
    await ready(client);
    const { store } = client.thread(h.thread.id);
    await when(
      store.select(["thread"], (view) => view.thread),
      Boolean,
    );
    h.daemon.store.appendEvents(h.thread.id, [root, ...models, total]);
    await when(
      store.select([`usageSnapshot:${key}`], (view) => view.usageSnapshot(key)),
      Boolean,
    );
    expect(store.usage("root")).toMatchObject({ inputTokens: 10, outputTokens: 2 });
    for (const model of models) {
      if (model.type !== "usage.updated") throw new Error("Expected usage");
      expect(store.usageSnapshot(usageSnapshotKey(model))).toMatchObject({
        model: model.model,
        inputTokens: 100,
        costUsd: 3,
      });
    }
    faults.disconnect();
    // Force snapshot recovery rather than allowing the live replay to hide materialization bugs.
    let replaced = false;
    faults.incoming = (message, frame, deliver) => {
      if (message.type === "events" && !replaced) {
        replaced = true;
        deliver(JSON.stringify({ ...message, afterSeq: message.afterSeq + 1 }));
      } else deliver(frame);
    };
    h.daemon.store.appendEvents(h.thread.id, [EventPayload.parse({ ...total, inputTokens: 210 })]);
    scheduler.advance(125);
    await when(
      store.select([`usageSnapshot:${key}`], (view) => view.usageSnapshot(key)?.inputTokens),
      (value) => value === 210,
    );
    await barrier(client, h.thread.id);
    expect(store.usage("root")).toMatchObject({ inputTokens: 10, outputTokens: 2 });
    expect(h.daemon.store.snapshotThread(h.thread.id).usageSnapshots[key]?.inputTokens).toBe(210);
    for (const model of models) {
      if (model.type !== "usage.updated") throw new Error("Expected usage");
      expect(store.usageSnapshot(usageSnapshotKey(model))?.inputTokens).toBe(100);
    }
  } finally {
    await h.cleanup();
  }
});
