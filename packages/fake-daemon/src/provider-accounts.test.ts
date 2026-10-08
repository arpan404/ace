import { expect, test } from "vitest";
import { Client } from "@ace/client";
import { DeviceId } from "@ace/protocol";
import { FakeDaemon, fakeTransport } from "./index.ts";
async function connected(daemon: FakeDaemon, device = "owner") {
  let sequence = 0;
  const client = new Client({
    deviceId: DeviceId.parse(device),
    transport: () => fakeTransport(daemon),
    storage: { load: async () => null, save: async () => {} },
    credential: async () => daemon.token,
    scheduler: { set: () => () => {} },
    random: () => 0,
    id: () => `request-${++sequence}`,
  });
  const ready = Promise.withResolvers<void>();
  const stop = client.connectionState().subscribe(() => {
    if (client.state === "ready") ready.resolve();
  });
  await client.start();
  await ready.promise;
  stop();
  return client;
}

test("a provider page lists accounts, adds with immediate sign-in, labels, selects defaults and removes inline", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  const client = await connected(daemon);
  try {
    for (const provider of ["codex", "claude", "opencode", "cursor", "pi"] as const) {
      const listed = await client.request({ type: "provider.accounts.list", provider });
      if (!listed.result.ok) throw new Error("Missing list");
      expect(listed.result.accounts.length).toBeGreaterThanOrEqual(2);
    }
    const added = await client.request({
      type: "provider.accounts.add",
      provider: "codex",
      label: "Work",
      method: "login",
    });
    if (!added.result.ok || !added.result.progress?.instance)
      throw new Error("Missing inline login");
    const instanceId = added.result.progress.instance;
    daemon.services.providerLogin.complete(added.result.progress.session);
    expect(
      (
        await client.request({
          type: "provider.accounts.rename",
          provider: "codex",
          instanceId,
          label: "Team",
        })
      ).result,
    ).toMatchObject({
      accounts: expect.arrayContaining([
        expect.objectContaining({ id: instanceId, label: "Team", authMethod: "browser" }),
      ]),
    });
    expect(
      (
        await client.request({
          type: "provider.accounts.setDefault",
          provider: "codex",
          instanceId,
        })
      ).result,
    ).toMatchObject({
      accounts: expect.arrayContaining([
        expect.objectContaining({ id: instanceId, isDefault: true }),
      ]),
    });
    const removed = await client.request({
      type: "provider.accounts.remove",
      provider: "codex",
      instanceId,
      confirm: true,
    });
    if (!removed.result.ok) throw new Error("Removal failed");
    expect(removed.result.accounts.some((row) => row.id === instanceId)).toBe(false);
  } finally {
    await client.close();
  }
});

test("API-key success and rejection never echo a key and unsupported providers do not create accounts", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  const client = await connected(daemon);
  const captured: unknown[] = [];
  const stop = client.onMessage((message) => captured.push(message));
  try {
    for (const provider of ["codex", "opencode", "cursor"] as const) {
      const added = await client.request({
        type: "provider.accounts.add",
        provider,
        method: "api_key",
        ...(provider === "opencode" ? { upstream: "openai" as const } : {}),
      });
      if (!added.result.ok || !added.result.progress?.instance)
        throw new Error("Missing API-key session");
      const { session, instance } = added.result.progress;
      const result = await client.request({
        type: "provider.login.apiKey",
        session,
        apiKey: "opaque-sentinel-do-not-retain",
      });
      expect(result.result).toMatchObject({ progress: { state: "succeeded" } });
      const list = await client.request({ type: "provider.accounts.list", provider });
      expect(list.result).toMatchObject({
        accounts: expect.arrayContaining([
          expect.objectContaining({ id: instance, authMethod: "api_key", status: "available" }),
        ]),
      });
      captured.push(list);
    }
    daemon.services.providerLogin.scenarios.codex = "failure";
    const failure = await client.request({
      type: "provider.accounts.add",
      provider: "codex",
      method: "api_key",
    });
    if (!failure.result.ok || !failure.result.progress) throw new Error("Missing failure scenario");
    expect(
      (
        await client.request({
          type: "provider.login.apiKey",
          session: failure.result.progress.session,
          apiKey: "opaque-sentinel-do-not-retain",
        })
      ).result,
    ).toMatchObject({ progress: { state: "failed" } });
    for (const provider of ["claude", "pi"] as const)
      expect(
        (await client.request({ type: "provider.accounts.add", provider, method: "api_key" }))
          .result,
      ).toMatchObject({ ok: false, error: "unsupported" });
    expect(JSON.stringify(captured)).not.toContain("opaque-sentinel-do-not-retain");
  } finally {
    stop();
    await client.close();
  }
});

test("read-only fake clients can list accounts but cannot add or submit credentials", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000, deviceScopes: { reader: ["read"] } });
  const client = await connected(daemon, "reader");
  try {
    expect(
      (await client.request({ type: "provider.accounts.list", provider: "codex" })).result.ok,
    ).toBe(true);
    expect(
      (await client.request({ type: "provider.accounts.add", provider: "codex", method: "login" }))
        .result,
    ).toMatchObject({ error: "forbidden" });
    expect(
      (
        await client.request({
          type: "provider.login.apiKey",
          session: "absent",
          apiKey: "opaque-sentinel-do-not-retain",
        })
      ).result,
    ).toMatchObject({ error: "forbidden" });
  } finally {
    await client.close();
  }
});

for (const method of ["login", "api_key"] as const) {
  test(`a cancelled new ${method} account is absent from every list and leaves the CLI's own login intact`, async () => {
    const daemon = new FakeDaemon({ clock: () => 1000 });
    const client = await connected(daemon);
    try {
      const before = await client.request({ type: "accounts.list" });
      const added = await client.request({
        type: "provider.accounts.add",
        provider: "codex",
        label: "Unfinished",
        method,
      });
      if (!added.result.ok || !added.result.progress) throw new Error("Missing login");
      expect((await client.request({ type: "accounts.list" })).accounts).toEqual(before.accounts);
      await client.request({
        type: "provider.login.cancel",
        session: added.result.progress.session,
      });
      expect((await client.request({ type: "accounts.list" })).accounts).toEqual(before.accounts);
      expect(
        (await client.request({ type: "provider.accounts.list", provider: "codex" })).result,
      ).toMatchObject({
        accounts: before.accounts.filter((account) => account.provider === "codex"),
      });
    } finally {
      await client.close();
    }
  });
}

test("a successful isolated Codex login gets models without inventing usage windows or changing the CLI's own email", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  const client = await connected(daemon);
  try {
    const before = await client.request({ type: "providers.request", operation: "readiness" });
    const added = await client.request({
      type: "provider.accounts.add",
      provider: "codex",
      label: "Client work",
      method: "login",
    });
    if (!added.result.ok || !added.result.progress?.instance) throw new Error("Missing login");
    const { session, instance } = added.result.progress;
    daemon.services.providerLogin.complete(session);
    const list = await client.request({ type: "accounts.list" });
    expect(list.accounts.find((account) => account.id === instance)).toMatchObject({
      label: "Client work",
      authMethod: "browser",
      quota: { auth: "logged_in", windows: {} },
    });
    const models = await client.request({ type: "models.list" });
    expect(
      "models" in models.result &&
        models.result.models.some((model) => model.instance === instance),
    ).toBe(true);
    expect(
      (await client.request({ type: "providers.request", operation: "readiness" })).result,
    ).toEqual(before.result);
  } finally {
    await client.close();
  }
});
