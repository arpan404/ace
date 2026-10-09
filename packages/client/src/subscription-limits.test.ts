import { DeviceId } from "@ace/protocol";
import { expect, test } from "vitest";
import { Client } from "./client.ts";
import type { ClientOptions } from "./types.ts";
const options: ClientOptions = {
  deviceId: DeviceId.parse("limit-test"),
  credential: async () => "test-token",
  storage: { load: async () => null, save: async () => {} },
  scheduler: { set: () => () => {} },
  random: () => 0.5,
  id: () => "test-id",
  transport: () => ({ open() {}, send() {}, close() {} }),
};
test("62 thread subscriptions leave capacity for Home and Archive", async () => {
  const client = new Client({ ...options, limits: { threads: 62 } });
  await client.close();
});
test.each([63, 64])(
  "thread limit %s is rejected before opening a socket with the reserved slots explained",
  (threads) => {
    expect(() => new Client({ ...options, limits: { threads } })).toThrow(
      "At most 62 thread subscriptions; reserve two of 64 slots for Home and Archive",
    );
  },
);
