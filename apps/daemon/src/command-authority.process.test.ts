import { Command } from "@ace/protocol";
import { expect, test } from "vitest";
import { setup } from "./remote-test-support.ts";

test("revocation during notification admission prevents a queued command from changing the thread", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let hold = false;
  const f = await setup({
    notifications: {
      async connectDevice() {
        if (hold) {
          entered.resolve();
          await release.promise;
        }
      },
      async disconnect() {},
      async updatePresence() {},
      async register() {},
      async preferences() {},
      async snooze() {},
    },
  });
  try {
    const paired = await f.pair();
    const client = await f.connectTicket(paired.device.id, (await f.ticket(paired.token)).ticket);
    expect(await client.next()).toMatchObject({ type: "welcome" });
    const before = f.store.headSeq();
    hold = true;
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
    await entered.promise;
    f.store.devices.revoke(paired.device.id, 1000);
    release.resolve();
    expect(await client.next()).toMatchObject({ type: "error", code: "forbidden" });
    expect(f.store.headSeq()).toBe(before);
  } finally {
    release.resolve();
  }
});
