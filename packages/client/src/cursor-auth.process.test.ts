import { expect, test } from "vitest";
import { ready, setup } from "./test-support.ts";

test("typed auth errors stay outside the durable intent outbox", async () => {
  const h = await setup();
  const { client, faults } = h.make();
  try {
    await ready(client);

    const status = client.cursorAuth({ type: "cursor.auth.status", instanceId: "missing" });
    await expect(status).resolves.toMatchObject({ type: "cursor.auth.error", code: "unavailable" });
    expect(
      faults.sent.map((text) => JSON.parse(text)).some((message) => message.type === "command"),
    ).toBe(false);
  } finally {
    await h.cleanup();
  }
});
