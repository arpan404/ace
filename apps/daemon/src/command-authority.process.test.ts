import { Command } from "@ace/protocol";
import { expect, test } from "vitest";
import { setup } from "./remote-test-support.ts";

test("a command after device revocation cannot change the thread", async () => {
  const f = await setup();
  try {
    const paired = await f.pair();
    const client = await f.connectTicket(paired.device.id, (await f.ticket(paired.token)).ticket);
    expect(await client.next()).toMatchObject({ type: "welcome" });
    const before = f.store.headSeq();
    f.store.devices.revoke(paired.device.id, 1000);
    client.send({
      type: "command",
      command: Command.parse({
        id: "revoked-during-admission",
        deviceId: paired.device.id,
        payload: {
          type: "thread.send",
          threadId: f.thread.id,
          input: [{ type: "text", text: "must not execute" }],
          delivery: "queue",
        },
      }),
    });

    expect(await client.next()).toMatchObject({ type: "error", code: "forbidden" });
    expect(f.store.headSeq()).toBe(before);
  } finally {
    await f.close();
  }
});

test("a connected device recovers notification enrollment without reconnecting", async () => {
  const scheduled: (() => void)[] = [];
  let available = false;
  const enrolled = new Set<string>();
  const f = await setup({
    runtime: {
      delay(run) {
        scheduled.push(run);
        return () => {};
      },
    },
    notifications: {
      async connectDevice(id) {
        if (!available) throw new Error("Worker recovering");
        enrolled.add(id);
      },
      async disconnect() {},
      async updatePresence() {},
      async register(id) {
        if (!enrolled.has(id)) throw new Error("Not enrolled");
      },
      async preferences() {},
      async snooze() {},
    },
  });
  try {
    const client = await f.connect();
    expect(await client.next()).toMatchObject({ type: "welcome" });
    client.send({
      type: "notification.register",
      requestId: "before",
      device: { channel: "websocket", platform: "desktop" },
    });
    expect(await client.next()).toMatchObject({ type: "error", code: "notification_rejected" });
    // Outages can outlast the first few worker restart attempts.
    for (let index = 0; index < 7; index++) {
      const retry = scheduled.pop();
      if (!retry) throw new Error("Connected enrollment stopped retrying");
      retry();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    available = true;
    for (const retry of scheduled.splice(0)) retry();
    client.send({
      type: "notification.register",
      requestId: "after",
      device: { channel: "websocket", platform: "desktop" },
    });
    expect(await client.next()).toMatchObject({
      type: "notification.register.result",
      requestId: "after",
    });
  } finally {
    await f.close();
  }
});
