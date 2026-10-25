import { expect, test } from "vitest";
import { CursorTranslator, cursorCapabilities } from "@ace/adapter-cursor";
import { AdapterRegistry } from "@ace/daemon";
import { ready, setup } from "./test-support.ts";

/** A daemon whose Cursor runs on the SDK, so its Cursor sign-in service is up; never opened. */
function cursorEngine() {
  const registry = new AdapterRegistry();
  registry.register(
    {
      provider: "cursor",
      backend: "cursor-sdk",
      capabilities: () => cursorCapabilities,
      createTranslator: (init) => new CursorTranslator(init),
      async openSession() {
        throw new Error("No Cursor session opens in this test");
      },
    },
    { installed: true, auth: "unknown", loginHint: "offline" },
  );
  return { registry };
}

test.each(["cursor.auth.status", "cursor.auth.select", "cursor.auth.logout"] as const)(
  "%s reports an unavailable instance outside the durable intent outbox",
  async (type) => {
    const h = await setup(undefined, undefined, cursorEngine());
    const { client, faults } = h.make();
    try {
      await ready(client);

      const status = client.cursorAuth({ type, instanceId: "missing" });
      await expect(status).resolves.toMatchObject({
        type: "cursor.auth.error",
        code: "unavailable",
        reason: "instance_unavailable",
      });
      expect(
        faults.sent.map((text) => JSON.parse(text)).some((message) => message.type === "command"),
      ).toBe(false);
    } finally {
      await h.cleanup();
    }
  },
);
