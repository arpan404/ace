import { ClientCore, defaultLimits, type TransportEvents } from "./index.ts";
import { ClientMessage, DeviceId, ThreadView } from "@ace/protocol";
import { expect, test } from "vitest";

for (const replay of ["empty", "progress", "snapshot"] as const) {
  test(`a current scoped ${replay} retry clears its refusal while stale success cannot`, async () => {
    let socket: TransportEvents | undefined;
    const sent: unknown[] = [];
    let id = 0;
    const client = new ClientCore({
      deviceId: DeviceId.parse("device"),
      transport: () => ({
        open(events) {
          socket = events;
        },
        send(text) {
          sent.push(JSON.parse(text));
        },
        close() {},
      }),
      credential: async () => "a".repeat(64),
      storage: { load: async () => null, save: async () => {} },
      scheduler: { set: () => () => {} },
      random: () => 0.5,
      id: () => `id-${++id}`,
      limits: defaultLimits,
    });
    await client.start();
    const deliver = (message: unknown) => socket?.message(JSON.stringify(message));
    deliver({ type: "welcome", hostId: "host", protocolVersion: 1, headSeq: 1 });
    const first = client.thread("thread");
    const subscription = () => {
      const request = ClientMessage.parse(sent.at(-1));
      if (request.type !== "subscribe") throw new Error("Missing subscribe");
      return request.subscriptionId;
    };
    const old = subscription();
    const view = ThreadView.parse({
      kind: "thread",
      seq: 1,
      thread: {
        id: "thread",
        workspaceId: "workspace",
        provider: "codex",
        title: "Thread",
        status: { state: "done" },
        createdAt: 0,
        updatedAt: 0,
      },
      agents: {},
      runs: {},
      items: {},
      itemOrder: [],
      interactions: {},
      backgroundTasks: {},
      usage: {},
      usageSnapshots: {},
      agentChildren: {},
    });
    deliver({ type: "snapshot", subscriptionId: old, seq: 1, view });
    deliver({ type: "error", subscriptionId: old, code: "read_denied", message: "read_denied" });
    expect(first.store.error?.message).toBe("read_denied");
    first.release();
    const retry = client.thread("thread");
    const current = subscription();
    const heard: unknown[] = [];
    const errors = retry.store.select(["error"], (reader) => reader.error?.message);
    const stop = errors.subscribe(() => heard.push(errors.getSnapshot()));
    deliver({ type: "subscription.ready", subscriptionId: old, seq: 1 });
    expect(retry.store.error?.message).toBe("read_denied");
    if (replay === "progress")
      deliver({ type: "progress", subscriptionId: current, afterSeq: 1, throughSeq: 2 });
    if (replay === "snapshot") deliver({ type: "snapshot", subscriptionId: current, seq: 1, view });
    deliver({
      type: "subscription.ready",
      subscriptionId: current,
      seq: replay === "progress" ? 2 : 1,
    });
    expect(retry.store.error).toBeUndefined();
    expect(heard).toEqual([undefined]);
    deliver({
      type: "error",
      subscriptionId: current,
      code: "read_denied",
      message: "read_denied",
    });
    deliver({ type: "subscription.ready", subscriptionId: old, seq: 2 });
    expect(retry.store.error?.message).toBe("read_denied");
    stop();
    retry.release();
    await client.close();
  });
}
