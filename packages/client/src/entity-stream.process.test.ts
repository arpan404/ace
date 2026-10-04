import { expect, test } from "vitest";
import { Interaction } from "@ace/protocol";
import { setup, ready, when } from "./test-support.ts";
// Mutation cases: drop oversized first entries; send an oversized generic reply; omit
// fragment reassembly or break request correlation on reconnect. Not executed (tests run at merge).
test("a settled megabyte plan remains readable through paging before and after reconnect", async () => {
  const h = await setup();
  try {
    const markdown = "# Settled plan\n" + "x".repeat(1_100_000);
    const interaction = Interaction.parse({
      id: "large-plan",
      threadId: h.thread.id,
      agentId: "root",
      blocking: true,
      state: "resolved",
      createdAt: 1,
      closedAt: 2,
      request: { kind: "plan_review", markdown },
    });
    h.daemon.store.appendEvents(h.thread.id, [{ type: "interaction.opened", interaction }]);
    const { client, faults } = h.make();
    let largest = 0;
    faults.incoming = (_message, text, deliver) => {
      largest = Math.max(largest, Buffer.byteLength(text));
      deliver(text);
    };
    await ready(client);
    const lease = client.thread(h.thread.id);
    await when(
      lease.store.select(["thread"], (reader) => reader.thread?.id),
      (id) => id === h.thread.id,
    );
    expect(lease.store.interaction(interaction.id)).toBeUndefined();
    const read = async () => {
      const response = await client.request({
        type: "entities.page",
        threadId: h.thread.id,
        collection: "interactions",
        before: Number.MAX_SAFE_INTEGER,
        limit: 1,
      });
      if (response.page.collection !== "interactions") throw new Error("Wrong collection");
      expect(response.page.entries).toHaveLength(1);
      expect(response.page.entries[0]?.request).toEqual({ kind: "plan_review", markdown });
      expect(response.page.entitiesBefore).toBeNull();
    };
    await read();
    client.networkOnline(false);
    client.networkOnline(true);
    await when(client.connectionState(), (state) => state === "ready");
    await read();
    expect(client.state).toBe("ready");
    expect(largest).toBeLessThan(1024 * 1024);
    lease.release();
  } finally {
    await h.cleanup();
  }
});

// Mutation cases: omit the aggregate-byte cap, account sources separately, omit absolute
// completion expiry. Not executed (tests run at merge).
test.each(["bytes", "aggregate", "timeout"])(
  "an incomplete snapshot hitting its %s budget reconnects safely",
  async (budget) => {
    const h = await setup();
    try {
      const { client, faults, scheduler } = h.make({
        limits: { fragmentBytes: 3000, fragmentMs: 1000 },
      });
      let partial = true;
      let late: (() => void) | undefined;
      faults.incoming = (message, text, deliver) => {
        if (partial && message.type === "snapshot") {
          partial = false;
          late = () =>
            deliver(
              JSON.stringify({
                type: "snapshot.part",
                subscriptionId: message.subscriptionId,
                seq: message.seq,
                index: 1,
                done: false,
                data: "x",
              }),
            );
          deliver(
            JSON.stringify({
              type: "snapshot.part",
              subscriptionId: message.subscriptionId,
              seq: message.seq,
              index: 0,
              done: false,
              data: "x".repeat(1024),
            }),
          );
          if (budget === "bytes")
            deliver(
              JSON.stringify({
                type: "snapshot.part",
                subscriptionId: message.subscriptionId,
                seq: message.seq,
                index: 1,
                done: false,
                data: "x".repeat(1024),
              }),
            );
          if (budget === "aggregate")
            deliver(
              JSON.stringify({
                type: "entities.page.part",
                requestId: "parallel-page",
                threadId: h.thread.id,
                seq: message.seq,
                index: 0,
                done: false,
                data: "x".repeat(1024),
              }),
            );
        } else deliver(text);
      };
      await ready(client);
      const lease = client.thread(h.thread.id);
      await faults.wait((message) => message.type === "snapshot");
      if (budget === "timeout") {
        scheduler.advance(900);
        late?.();
        scheduler.advance(100);
      }
      await when(client.connectionState(), (state) => state === "reconnecting");
      scheduler.advance(250);
      await when(client.connectionState(), (state) => state === "ready");
      await when(
        lease.store.select(["thread"], (reader) => reader.thread?.id),
        (id) => id === h.thread.id,
      );
      expect(lease.store.error).toBeUndefined();
      lease.release();
    } finally {
      await h.cleanup();
    }
  },
);
