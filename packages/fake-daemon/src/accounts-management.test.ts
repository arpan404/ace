import { expect, test } from "vitest";
import { Client } from "@ace/client";
import { DeviceId } from "@ace/protocol";
import { FakeDaemon, fakeTransport } from "./index.ts";

test("the fake catalog completes account login in a live terminal and updates account models", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  let sequence = 0;
  const client = new Client({
    deviceId: DeviceId.parse("owner"),
    transport: () => fakeTransport(daemon),
    storage: { load: async () => null, save: async () => {} },
    credential: async () => daemon.token,
    scheduler: { set: () => () => {} },
    random: () => 0,
    id: () => `request-${++sequence}`,
  });
  const ready = new Promise<void>((resolve) => {
    const stop = client.connectionState().subscribe(() => {
      if (client.state === "ready") {
        stop();
        resolve();
      }
    });
  });
  await client.start();
  await ready;
  try {
    const added = await client.request({ type: "accounts.add", provider: "codex", label: "Work" });
    if (!added.account) throw new Error("Account missing");
    const instanceId = added.account.id;
    expect(added.account.quota.auth).toBe("unknown");
    const flow = await client.request({ type: "accounts.login", instanceId });
    expect(
      (
        await client.request({
          type: "terminal.request",
          operation: { op: "subscribe", terminalId: flow.terminalId, subscriptionId: "login" },
        })
      ).ok,
    ).toBe(true);
    expect((await client.request({ type: "accounts.status", instanceId })).account).toMatchObject({
      availability: "available",
      quota: { auth: "logged_in" },
    });
    const listed = await client.request({ type: "models.list", options: { instance: instanceId } });
    expect("models" in listed.result && listed.result.models.length).toBeGreaterThan(0);
    expect(
      (await client.request({ type: "accounts.rename", instanceId, label: "Team" })).account,
    ).toMatchObject({ label: "Team" });
    expect(
      (await client.request({ type: "accounts.setDefault", instanceId, provider: "codex" }))
        .account,
    ).toMatchObject({ isDefault: true });
    expect((await client.request({ type: "accounts.remove", instanceId })).account).toBeNull();
    expect((await client.request({ type: "accounts.status", instanceId })).account).toBeNull();
    await expect(
      client.request({
        type: "accounts.remove",
        instanceId: "codex-cli-default",
        deleteHome: true,
      }),
    ).rejects.toThrow("accounts_failed");
  } finally {
    await client.close();
  }
});
