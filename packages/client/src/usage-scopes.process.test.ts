import { expect, test } from "vitest";
import { Agent, EventPayload, type ThreadId } from "@ace/protocol";
import { usageSnapshotKey } from "@ace/projection";
import { setup, ready, when, barrier } from "./test-support.ts";

function rootAgent(threadId: ThreadId, cwd: string) {
  return Agent.parse({
    id: "root",
    threadId,
    parentId: null,
    origin: "root",
    native: { provider: "codex" },
    fidelity: "full",
    cwd,
    status: { state: "working", activity: "thinking" },
    createdAt: 1,
  });
}

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
    await when(client.connectionState(), (state) => state === "reconnecting");
    // Force snapshot recovery rather than allowing the live replay to hide materialization bugs.
    let replaced = false;
    faults.incoming = (message, frame, deliver) => {
      if (message.type === "events" && !replaced) {
        replaced = true;
        // Keep a valid envelope with stale coverage so delivery detects a
        // recoverable gap instead of rejecting an invalid event range.
        deliver(JSON.stringify({ ...message, afterSeq: message.afterSeq - 1 }));
      } else deliver(frame);
    };
    h.daemon.store.appendEvents(h.thread.id, [EventPayload.parse({ ...total, inputTokens: 210 })]);
    const recoverySeq = h.daemon.store.headSeq();
    scheduler.advance(125);
    await when(
      store.select([`usageSnapshot:${key}`], (view) => view.usageSnapshot(key)?.inputTokens),
      (value) => value === 210,
    );
    // A recovered value alone could come from replay. Require the authoritative
    // snapshot response too, so this exercises snapshot materialization.
    await faults.wait(
      (message) =>
        message.type === "snapshot" &&
        message.view.kind === "thread" &&
        message.view.thread.id === h.thread.id &&
        message.seq >= recoverySeq,
    );
    await barrier(client, h.thread.id);
    expect(replaced).toBe(true);
    expect(client.state).toBe("ready");
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

test("usage before agent metadata survives snapshots while a daemon cache is live", async () => {
  const h = await setup();
  h.daemon.store.acquireThread(h.thread.id);
  try {
    h.daemon.store.appendEvents(h.thread.id, [
      EventPayload.parse({
        type: "usage.updated",
        agentId: "root",
        inputTokens: 10,
        outputTokens: 2,
      }),
    ]);
    const { client } = h.make();
    await ready(client);
    const { store } = client.thread(h.thread.id);
    await when(
      store.select(["thread"], (view) => view.thread),
      Boolean,
    );
    expect(store.usage("root")).toMatchObject({ inputTokens: 10, outputTokens: 2 });
    h.daemon.store.appendEvents(h.thread.id, [
      {
        type: "agent.created",
        agent: rootAgent(h.thread.id, h.directory),
      },
    ]);
    await when(
      store.select(["agent:root"], (view) => view.agent("root")),
      Boolean,
    );
    expect(h.daemon.store.snapshotThread(h.thread.id).usage.root).toMatchObject({
      inputTokens: 10,
      outputTokens: 2,
    });
  } finally {
    h.daemon.store.releaseThread(h.thread.id);
    await h.cleanup();
  }
});

test.each([false, true])(
  "unlinked activity snapshots stay bounded and keep retained agent usage with a live cache %s",
  async (cached) => {
    const h = await setup();
    if (cached) h.daemon.store.acquireThread(h.thread.id);
    try {
      h.daemon.store.appendEvents(h.thread.id, [
        { type: "agent.created", agent: rootAgent(h.thread.id, h.directory) },
        EventPayload.parse({
          type: "usage.updated",
          agentId: "root",
          inputTokens: 7,
          outputTokens: 1,
        }),
      ]);
      h.daemon.store.appendEvents(
        h.thread.id,
        Array.from({ length: 250 }, (_, i) =>
          EventPayload.parse({
            type: "usage.updated",
            agentId: `unlinked-${i}`,
            inputTokens: i,
            outputTokens: 2,
          }),
        ),
      );
      const { client } = h.make();
      await ready(client);
      const { store } = client.thread(h.thread.id);
      await when(
        store.select(["thread"], (view) => view.thread),
        Boolean,
      );
      expect(Object.keys(store.export().view?.usage ?? {})).toHaveLength(201);
      expect(store.usage("root")).toMatchObject({ inputTokens: 7, outputTokens: 1 });
      expect(store.usage("unlinked-0")).toBeUndefined();
      expect(store.usage("unlinked-49")).toBeUndefined();
      expect(store.usage("unlinked-50")?.inputTokens).toBe(50);
      expect(store.usage("unlinked-249")?.inputTokens).toBe(249);
    } finally {
      if (cached) h.daemon.store.releaseThread(h.thread.id);
      await h.cleanup();
    }
  },
);

test.each([false, true])(
  "pre-linkage usage and context snapshots obey their byte budgets with a live cache %s",
  async (cached) => {
    const h = await setup();
    if (cached) h.daemon.store.acquireThread(h.thread.id);
    try {
      h.daemon.store.appendEvents(
        h.thread.id,
        Array.from({ length: 4 }, (_, i) => [
          EventPayload.parse({
            type: "usage.updated",
            agentId: `large-${i}`,
            inputTokens: i,
            outputTokens: 2,
            model: "m".repeat(50 * 1024),
          }),
          EventPayload.parse({
            type: "context_meter.updated",
            meter: {
              agentId: `large-${i}`,
              epoch: 0,
              usedTokens: i,
              windowTokens: 100,
              model: "m".repeat(50 * 1024),
              source: "provider",
            },
          }),
        ]).flat(),
      );
      const { client } = h.make();
      await ready(client);
      const { store } = client.thread(h.thread.id);
      await when(
        store.select(["thread"], (view) => view.thread),
        Boolean,
      );
      expect(store.usage("large-0")).toBeUndefined();
      expect(store.contextMeter("large-0")).toBeUndefined();
      expect(store.usage("large-2")?.inputTokens).toBe(2);
      expect(store.contextMeter("large-2")?.usedTokens).toBe(2);
      expect(store.usage("large-3")?.inputTokens).toBe(3);
      expect(store.contextMeter("large-3")?.usedTokens).toBe(3);
      const snapshot = store.export().view;
      for (const values of [snapshot?.usage, snapshot?.contextMeters]) {
        expect(Object.keys(values ?? {})).toHaveLength(2);
        expect(Buffer.byteLength(JSON.stringify(values))).toBeLessThan(128 * 1024);
      }
    } finally {
      if (cached) h.daemon.store.releaseThread(h.thread.id);
      await h.cleanup();
    }
  },
);
