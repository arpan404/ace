import { expect, test } from "vitest";
import { Client } from "@ace/client";
import { DeviceId, type ProviderLoginProgress } from "@ace/protocol";
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
  const events: ProviderLoginProgress[] = [];
  const waiting = new Map<
    ProviderLoginProgress["state"],
    ((progress: ProviderLoginProgress) => void)[]
  >();
  client.onMessage((message) => {
    if (message.type !== "provider.login.progress") return;
    events.push(message.progress);
    for (const resolve of waiting.get(message.progress.state) ?? []) resolve(message.progress);
    waiting.delete(message.progress.state);
  });
  await client.start();
  await ready.promise;
  stop();
  const wait = (state: ProviderLoginProgress["state"]) => {
    const event = events.findLast((entry) => entry.state === state);
    return event
      ? Promise.resolve(event)
      : new Promise<ProviderLoginProgress>((resolve) =>
          waiting.set(state, [...(waiting.get(state) ?? []), resolve]),
        );
  };
  return { client, events, wait };
}

test.each(["codex", "claude", "opencode", "pi", "cursor"] as const)(
  "fake %s sign-in carries the native challenge contract through Client.request",
  async (provider) => {
    const daemon = new FakeDaemon({ clock: () => 1000 });
    const f = await connect(daemon);
    try {
      const started = await f.client.request({ type: "provider.login.start", provider });
      if (!started.result.ok) throw new Error("Fixture login failed");
      const session = started.result.progress.session;
      if (provider === "opencode" || provider === "pi") {
        expect(await f.wait("awaiting_input")).toMatchObject({
          choices: expect.arrayContaining([expect.objectContaining({ id: "github-copilot" })]),
        });
        await f.client.request({
          type: "provider.login.input",
          session,
          input: { choice: "github-copilot" },
        });
        await f.client.request({ type: "provider.login.input", session, input: { confirm: true } });
      }
      const challenge = await f.wait(
        provider === "codex" || provider === "opencode" || provider === "pi"
          ? "awaiting_code_entry"
          : "awaiting_browser",
      );
      expect(challenge.url).toMatch(/^https:/);
      expect(await f.client.request({ type: "provider.login.start", provider })).toMatchObject({
        result: { ok: false, error: "busy" },
      });
      daemon.services.providerLogin.complete(session);
      expect(await f.wait("succeeded")).not.toHaveProperty("url");
      expect(
        await f.client.request({ type: "providers.request", operation: "list" }),
      ).toMatchObject({
        result: {
          providers: expect.arrayContaining([
            expect.objectContaining({ provider, readiness: "signed_in" }),
          ]),
        },
      });
      expect(await f.client.request({ type: "onboarding.query" })).toMatchObject({
        result: { ready: expect.arrayContaining([provider]), next: { action: "start_thread" } },
      });
      expect(await f.client.request({ type: "provider.logout", provider })).toMatchObject({
        result: { ok: true },
      });
      const poll = await f.client.request({ type: "providers.request" });
      expect(poll).toMatchObject({
        result: {
          providers: expect.arrayContaining([
            expect.objectContaining({ provider, readiness: "installed_signed_out" }),
          ]),
        },
      });
    } finally {
      await f.client.close();
    }
  },
);

test("fake failure, cancellation and reconnect polling keep challenges scoped to their device", async () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  daemon.services.providerLogin.scenarios.claude = "failure";
  const f = await connect(daemon);
  const other = await connect(daemon, "other-phone");
  try {
    await f.client.request({ type: "provider.login.start", provider: "claude" });
    expect(await f.wait("failed")).toMatchObject({ message: expect.stringContaining("declined") });
    const started = await f.client.request({ type: "provider.login.start", provider: "codex" });
    if (!started.result.ok) throw new Error("Fixture login failed");
    const session = started.result.progress.session;
    await f.wait("awaiting_code_entry");
    expect(other.events).toEqual([]);
    expect(await other.client.request({ type: "provider.login.poll", session })).toMatchObject({
      result: { error: "forbidden" },
    });
    expect(await f.client.request({ type: "provider.login.cancel", session })).toMatchObject({
      result: { progress: { state: "cancelled" } },
    });
    expect(await f.client.request({ type: "provider.login.poll", session })).not.toHaveProperty(
      "result.progress.url",
    );
    const active = await f.client.request({ type: "provider.login.start", provider: "codex" });
    if (!active.result.ok) throw new Error("Fixture login failed");
    const resumedSession = active.result.progress.session;
    await f.client.close();
    const resumed = await connect(daemon);
    try {
      expect(
        await resumed.client.request({ type: "provider.login.poll", session: resumedSession }),
      ).toMatchObject({
        result: { progress: { state: "awaiting_code_entry", userCode: "ACEF-2048" } },
      });
      daemon.services.providerLogin.complete(resumedSession);
      expect(await resumed.wait("succeeded")).toMatchObject({ session: resumedSession });
    } finally {
      await resumed.client.close();
    }
  } finally {
    await f.client.close();
    await other.client.close();
  }
});

test("fake onboarding dismissal belongs to the device and terminal fallback uses operate authority", async () => {
  const daemon = new FakeDaemon({
    clock: () => 1000,
    deviceScopes: { phone: ["read", "operate"], reader: ["read"] },
  });
  const f = await connect(daemon);
  const reader = await connect(daemon, "reader");
  try {
    expect(
      await reader.client.request({ type: "provider.login.start", provider: "codex" }),
    ).toMatchObject({ result: { error: "forbidden" } });
    await f.client.request({ type: "onboarding.dismiss", dismissed: true });
    expect(await f.client.request({ type: "onboarding.query" })).toMatchObject({
      result: { dismissed: true },
    });
    expect(await reader.client.request({ type: "onboarding.query" })).toMatchObject({
      result: { dismissed: false },
    });
    const readiness = await f.client.request({ type: "providers.request", operation: "readiness" });
    if (!readiness.result.ok) throw new Error("Readiness unavailable");
    const providers = readiness.result.providers;
    expect(new Set(providers.map((row) => row.provider)).size).toBe(providers.length);
    expect(providers.find((row) => row.provider === "cursor")).toHaveProperty("readiness");
    const started = await f.client.request({ type: "provider.login.start", provider: "opencode" });
    if (!started.result.ok) throw new Error("Fixture login failed");
    const session = started.result.progress.session;
    await f.client.request({
      type: "provider.login.input",
      session,
      input: { choice: "opencode-go" },
    });
    const opened = await f.client.request({ type: "provider.login.terminal", session });
    if (!opened.result.ok || !opened.result.progress.manual?.terminalId)
      throw new Error("Terminal fallback missing");
    expect(
      await f.client.request({
        type: "terminal.request",
        operation: {
          op: "subscribe",
          terminalId: opened.result.progress.manual.terminalId,
          subscriptionId: "fallback",
          fromOffset: 0,
        },
      }),
    ).toMatchObject({ ok: true });
  } finally {
    await f.client.close();
    await reader.client.close();
  }
});
