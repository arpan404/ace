import { expect, test } from "vitest";
import { Client } from "@ace/client";
import { DeviceId, type ProviderInstallProgress } from "@ace/protocol";
import { FakeDaemon, fakeTransport } from "./index.ts";

async function connect(daemon: FakeDaemon, device = "phone") {
  let sequence = 0;
  const client = new Client({
    deviceId: DeviceId.parse(device),
    transport: () => fakeTransport(daemon),
    credential: async () => daemon.token,
    storage: { load: async () => null, save: async () => {} },
    scheduler: { set: () => () => {} },
    random: () => 0,
    id: () => `${device}-${++sequence}`,
  });
  const ready = Promise.withResolvers<void>();
  const stop = client.connectionState().subscribe(() => {
    if (client.state === "ready") ready.resolve();
  });
  const events: ProviderInstallProgress[] = [];
  const waiters = new Set<{
    state: ProviderInstallProgress["state"];
    resolve: (event: ProviderInstallProgress) => void;
  }>();
  client.onMessage((message) => {
    if (message.type !== "provider.install.progress") return;
    events.push(message.progress);
    for (const waiter of waiters)
      if (waiter.state === message.progress.state) {
        waiters.delete(waiter);
        waiter.resolve(message.progress);
      }
  });
  await client.start();
  await ready.promise;
  stop();
  return {
    client,
    events,
    wait(state: ProviderInstallProgress["state"]): Promise<ProviderInstallProgress> {
      const event = events.findLast((entry) => entry.state === state);
      return event
        ? Promise.resolve(event)
        : new Promise((resolve) => waiters.add({ state, resolve }));
    },
  };
}

test("fake installs, updates and removes through Client.request with progress and readiness pushes", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  const f = await connect(daemon);
  try {
    expect(
      await f.client.request({
        type: "provider.install.plan",
        provider: "codex",
        action: "update",
      }),
    ).toMatchObject({
      result: { ok: true, plan: { installedVersion: "0.48.0", updateAvailable: true } },
    });
    for (const action of ["update", "uninstall", "install"] as const) {
      const result = await f.client.request({
        type: "provider.install.run",
        provider: "codex",
        action,
        method: "npm",
      });
      if (!result.result.ok || !("progress" in result.result)) throw new Error("Expected session");
      const session = result.result.progress.session;
      const poll = await f.client.request({ type: "provider.install.poll", session });
      expect(poll).toMatchObject({
        result: { ok: true, progress: { state: "succeeded", exit: 0 } },
      });
      const rows = await f.client.request({ type: "providers.request", operation: "readiness" });
      expect(rows).toMatchObject({
        result: {
          ok: true,
          providers: expect.arrayContaining([
            expect.objectContaining({
              provider: "codex",
              installed: action !== "uninstall",
              updateAvailable: false,
            }),
          ]),
        },
      });
    }
    expect(f.events.some((event) => event.state === "verifying")).toBe(true);
    expect(
      await f.client.request({
        type: "provider.install.plan",
        provider: "codex",
        action: "update",
      }),
    ).toMatchObject({
      result: { ok: true, plan: { installedVersion: "9.0.0", updateAvailable: false } },
    });
  } finally {
    await f.client.close();
  }
});

test("fake plans display the official script and package-manager commands", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  daemon.services.providerInstalls.autoComplete = false;
  const f = await connect(daemon);
  try {
    expect(
      await f.client.request({
        type: "provider.install.run",
        provider: "claude",
        action: "install",
        method: "script",
      }),
    ).toMatchObject({
      result: {
        ok: true,
        progress: {
          plan: {
            status: "ready",
            sourceUrl: "https://code.claude.com/docs/en/setup",
            commands: [
              {
                command: "bash",
                args: ["-o", "pipefail", "-c", "curl -fsSL https://claude.ai/install.sh | bash"],
              },
            ],
          },
        },
      },
    });
    expect(
      await f.client.request({
        type: "provider.install.run",
        provider: "opencode",
        action: "install",
        method: "bun",
      }),
    ).toMatchObject({
      result: {
        ok: true,
        progress: {
          plan: {
            commands: [{ command: "bun", args: ["install", "-g", "--trust", "@opencode/cli"] }],
          },
        },
      },
    });
  } finally {
    await f.client.close();
  }
});

test("fake failure, admin, busy and cancellation states can be staged without timers", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  daemon.services.providerInstalls.autoComplete = false;
  const f = await connect(daemon);
  try {
    daemon.services.providerInstalls.scenarios.codex = "needs_admin";
    expect(
      await f.client.request({
        type: "provider.install.run",
        provider: "codex",
        action: "update",
        method: "npm",
      }),
    ).toMatchObject({
      result: { ok: true, progress: { state: "needs_admin", plan: { needsAdmin: true } } },
    });
    daemon.services.providerInstalls.scenarios.codex = "failure";
    const failed = await f.client.request({
      type: "provider.install.run",
      provider: "codex",
      action: "update",
      method: "npm",
    });
    if (!failed.result.ok || !("progress" in failed.result)) throw new Error("Expected session");
    daemon.services.providerInstalls.complete(failed.result.progress.session);
    expect(await f.wait("failed")).toMatchObject({ exit: 1 });
    daemon.services.providerInstalls.scenarios.codex = "success";
    const started = await f.client.request({
      type: "provider.install.run",
      provider: "codex",
      action: "update",
      method: "npm",
    });
    if (!started.result.ok || !("progress" in started.result)) throw new Error("Expected session");
    expect(
      await f.client.request({
        type: "provider.install.run",
        provider: "codex",
        action: "uninstall",
        method: "npm",
      }),
    ).toMatchObject({ result: { ok: false, error: "busy" } });
    expect(
      await f.client.request({
        type: "provider.install.cancel",
        session: started.result.progress.session,
      }),
    ).toMatchObject({ result: { ok: true, progress: { state: "cancelled" } } });
    expect(
      await f.client.request({ type: "provider.install.plan", provider: "cursor" }),
    ).toMatchObject({ result: { ok: true, plan: { status: "sign_in", commands: [] } } });
  } finally {
    await f.client.close();
  }
});

test("fake read-only devices receive forbidden for every installer operation", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000, deviceScopes: { reader: ["read"] } });
  const f = await connect(daemon, "reader");
  try {
    for (const request of [
      { type: "provider.install.plan", provider: "codex" },
      { type: "provider.install.run", provider: "codex", action: "install", method: "npm" },
      { type: "provider.install.poll", session: "private" },
      { type: "provider.install.cancel", session: "private" },
    ] as const)
      expect(await f.client.request(request)).toMatchObject({
        result: { ok: false, error: "forbidden" },
      });
  } finally {
    await f.client.close();
  }
});
