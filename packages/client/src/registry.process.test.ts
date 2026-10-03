import { ClientMessage } from "@ace/protocol";
import { expect, test } from "vitest";
import { setup, ready } from "./test-support.ts";
test("registry metadata replies resolve a correlated read without durable command intents", async () => {
  const h = await setup();
  try {
    const { client, faults } = h.make();
    await ready(client);
    const reply = await client.registry({ type: "registry.list", offset: 0, limit: 1 });
    expect(reply).toMatchObject({
      type: "registry.result",
      result: { ok: true, agents: [], installations: [] },
    });
    expect(
      faults.sent
        .map((text) => ClientMessage.parse(JSON.parse(text)))
        .filter((value) => value.type === "command"),
    ).toEqual([]);
    const error = await client.registry({
      type: "registry.install-plan",
      acpAgentId: "local:missing",
      runtime: "binary",
    });
    expect(error.result.ok).toBe(false);
  } finally {
    await h.cleanup();
  }
});
