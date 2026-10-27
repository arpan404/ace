import { until } from "./test-host.ts";
import { afterEach, expect, test } from "vitest";
import { ClientCore } from "@ace/client";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, HostId } from "@ace/protocol";
import { NativeServices } from "./native-services.ts";
import { readUsageLimits, useBankedReset } from "./usage-limits.ts";
import { RecordingSink } from "./sheet-fixture.ts";

/*
 * The Usage screen's Limits view over the real SDK and an in-process fake daemon: the
 * shared `usageLimits` words reach the phone shaped for Swift, and a machine that refuses
 * its accounts reads as a failed service call.
 */

let client: ClientCore | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

async function connect(daemon: FakeDaemon): Promise<ClientCore> {
  const owner = new ClientCore({
    deviceId: DeviceId.parse("ios-usage-test"),
    expectedHostId: HostId.parse("ios-test-host"),
    transport: () => fakeTransport(daemon),
    credential: async () => ({ token: "ios-test-token" }),
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set: (delay, callback) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    },
    id: () => crypto.randomUUID(),
    random: () => 0.5,
    now: () => Date.now(),
  });
  client = owner;
  await owner.start();
  await until(() => (owner.state === "ready" ? owner : undefined));
  return owner;
}

function fixture(): FakeDaemon {
  return new FakeDaemon({ clock: Date.now, hostId: "ios-test-host", token: "ios-test-token" });
}

test("limits shape each provider's accounts with what is left of every window", async () => {
  const owner = await connect(fixture());
  const reply = await readUsageLimits(owner, new AbortController().signal);
  expect(reply.type).toBe("usage.limits");
  const codex = reply.providers.find((group) => group.provider === "codex");
  expect(codex?.providerLabel).toBe("Codex");
  const personal = codex?.accounts.find((account) => account.label === "Personal");
  expect(personal).toMatchObject({ plan: "pro", bankedResets: 3, signIn: null });
  const session = personal?.windows.find((window) => window.label === "Session (5h)");
  expect(session).toMatchObject({ leftPercent: 62, stale: false });
  expect(session?.resets).toMatch(/^Resets in /);
  expect(session?.pace).toBeNull();
  const claude = reply.providers.find((group) => group.provider === "claude");
  const claudeSession = claude?.accounts[0]?.windows.find(
    (window) => window.label === "Session (5h)",
  );
  expect(claudeSession?.leftPercent).toBe(38);
  // Providers whose accounts report no window join the quiet line instead of guessing.
  expect(reply.quiet.length).toBeGreaterThan(0);
});

test("limits arrive through the native service bridge for the phone to draw", async () => {
  const owner = await connect(fixture());
  const sink = new RecordingSink();
  new NativeServices(owner, sink).handle({
    type: "service",
    id: "limits",
    request: { type: "usage.limits" },
  });
  await until(() => sink.read("service:limits"));
  expect(sink.read("service:limits")).toMatchObject({
    ok: true,
    value: { type: "usage.limits", providers: expect.any(Array) },
  });
});

test("a machine that refuses its accounts fails the limits call like other service reads", async () => {
  const daemon = fixture();
  daemon.failRequests("accounts.list");
  const owner = await connect(daemon);
  const sink = new RecordingSink();
  new NativeServices(owner, sink).handle({
    type: "service",
    id: "limits",
    request: { type: "usage.limits" },
  });
  await until(() => sink.read("service:limits"));
  expect(sink.read("service:limits")).toMatchObject({ ok: false, value: null });
});

test("a banked Codex reset spends one credit, and the same attempt never spends a second", async () => {
  const owner = await connect(fixture());
  const signal = new AbortController().signal;
  const before = await readUsageLimits(owner, signal);
  const personal = before.providers
    .find((group) => group.provider === "codex")
    ?.accounts.find((account) => account.label === "Personal");
  if (!personal) throw new Error("expected the Personal Codex account");
  const attempt = {
    type: "usage.useReset" as const,
    instanceId: personal.instanceId,
    idempotencyKey: crypto.randomUUID(),
  };
  expect(await useBankedReset(owner, attempt, signal)).toMatchObject({
    outcome: "reset",
    words: "Limits reset.",
  });
  expect(await useBankedReset(owner, attempt, signal)).toMatchObject({
    outcome: "alreadyRedeemed",
    words: "This reset was already applied.",
  });
  const after = await readUsageLimits(owner, signal);
  const reset = after.providers
    .find((group) => group.provider === "codex")
    ?.accounts.find((account) => account.key === personal.key);
  expect(reset?.bankedResets).toBe(2);
  expect(reset?.windows.every((window) => window.leftPercent === 100)).toBe(true);
});
