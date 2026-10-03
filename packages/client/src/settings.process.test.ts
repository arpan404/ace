import { expect, test } from "vitest";
import { setup, ready } from "./test-support.ts";

test("recovery settings reads and writes round-trip through the daemon with layered provenance", async () => {
  const h = await setup();
  try {
    const { client } = h.make();
    await ready(client);
    expect(await client.settingsGet("threads.followUpBehavior")).toMatchObject({
      ok: true,
      entries: [{ key: "threads.followUpBehavior", value: "queue", provenance: "defaults" }],
    });
    expect(
      await client.settingsSet("threads.followUpBehavior", "steer", { kind: "global" }),
    ).toMatchObject({ ok: true });
    expect(
      await client.settingsGet("threads.followUpBehavior", { threadId: h.thread.id }),
    ).toMatchObject({
      ok: true,
      entries: [{ key: "threads.followUpBehavior", value: "steer", provenance: "global" }],
    });
    const rejected = await client.settingsSet("threads.followUpBehavior", "invalid", {
      kind: "global",
    });
    expect(rejected.ok).toBe(false);
    expect((await client.settingsGet("threads.followUpBehavior")).entries[0]?.value).toBe("steer");
  } finally {
    await h.cleanup();
  }
});
