import { expect, test } from "vitest";
import { ready, setup } from "./test-support.ts";

test.each(["cursor.auth.status", "cursor.auth.select", "cursor.auth.logout"] as const)(
  "%s reports an unavailable auth service outside the durable intent outbox",
  async (type) => {
    const h = await setup();
    const { client, faults } = h.make();
    try {
      await ready(client);

      const status = client.cursorAuth({ type, instanceId: "missing" });
      await expect(status).resolves.toMatchObject({
        type: "cursor.auth.error",
        code: "unavailable",
        reason: "service_unavailable",
      });
      expect(
        faults.sent.map((text) => JSON.parse(text)).some((message) => message.type === "command"),
      ).toBe(false);
    } finally {
      await h.cleanup();
    }
  },
);
