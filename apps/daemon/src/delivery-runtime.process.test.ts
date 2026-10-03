import { once } from "node:events";
import { expect, it } from "vitest";
import { createDevThread } from "./commands.ts";
import { fixture } from "./socket-test-support.ts";
import { subscribe } from "./subscription.ts";
import type { ServerMessage } from "@ace/protocol";

const noop = () => {};

it("uses injected session identities and time for presence and persistent transport pressure", async () => {
  let now = 0;
  let tick = noop;
  const active = new Set<string>();
  const f = await fixture({
    runtime: {
      now: () => now,
      id: () => "controlled-session",
      every(callback) {
        tick = callback;
        return () => {
          tick = noop;
        };
      },
    },
    pressure: { hardLimit: -1, hardTimeoutMs: 1000 },
    notifications: {
      async connectDevice() {},
      async register() {},
      async preferences() {},
      async snooze() {},
      async updatePresence(session) {
        active.add(session);
      },
      async disconnect(session) {
        active.delete(session);
      },
    },
  });
  try {
    const client = await f.connect();
    expect(await client.next()).toMatchObject({ type: "welcome" });
    client.send({ type: "presence.update", threadId: f.thread.id, inputAgeMs: 0 });
    client.send({ type: "ping" });
    expect(await client.next()).toEqual({ type: "pong" });
    expect([...active]).toEqual(["controlled-session"]);
    now = 999;
    tick();
    client.send({ type: "ping" });
    expect(await client.next()).toEqual({ type: "pong" });
    const closed = once(client.socket, "close").then(([code]) => code);
    now = 1000;
    tick();
    client.send({ type: "ping" });
    expect(
      await Promise.race([
        closed,
        client.next().then(
          () => "delivered",
          () => closed,
        ),
      ]),
    ).toBe(4009);
    await f.server.close();
    expect([...active]).toEqual([]);
  } finally {
    await f.close();
  }
});

it("delivers filtered progress on the injected scheduler and stops delivery after unsubscribe", async () => {
  const f = await fixture();
  const messages: ServerMessage[] = [];
  let scheduled = noop;
  const stop = subscribe(
    f.store,
    "s",
    { kind: "thread", threadId: f.thread.id },
    f.store.headSeq(),
    5000,
    (message) => messages.push(message),
    250,
    (callback) => {
      scheduled = callback;
      return () => {};
    },
  );
  try {
    const before = f.store.headSeq();
    createDevThread(f.store, f.workspace);
    expect(messages).toEqual([]);
    scheduled();
    expect(messages).toEqual([
      { type: "progress", subscriptionId: "s", afterSeq: before, throughSeq: f.store.headSeq() },
    ]);
    createDevThread(f.store, f.workspace);
    stop();
    scheduled();
    expect(messages).toHaveLength(1);
  } finally {
    stop();
    await f.close();
  }
});
