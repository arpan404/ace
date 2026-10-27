import { randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { createPushGatewayTransport } from "@ace/notify";
import { Notification, NotificationDevice, PushAlertPayload } from "@ace/protocol";
import { GatewayConfig } from "./config.ts";
import { startGateway, type Gateway } from "./server.ts";
import { apnsKeyPair, phoneKeys, signingKeyPem, startFakeApns } from "./testing/fake-apns.ts";

const day = 24 * 60 * 60_000;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).toReversed()) await stop();
});

async function setup(options: { sealKeys?: Buffer[]; perIp?: number } = {}) {
  const apns = await startFakeApns();
  let time = Date.parse("2026-10-27T12:00:00Z");
  const clock = { now: () => time, advance: (ms: number) => (time += ms) };
  const sealKeys = options.sealKeys ?? [randomBytes(32)];
  const start = (keys: Buffer[]) =>
    startGateway(
      GatewayConfig.parse({
        port: 0,
        bind: "127.0.0.1",
        publicOrigin: "http://127.0.0.1:1",
        apns: {
          teamId: "TEAM123456",
          keyId: "KEY1234567",
          privateKey: apnsKeyPair().pem,
          topic: "app.ace.ios",
          origins: { production: apns.origin, sandbox: apns.origin },
        },
        sealKeys: keys,
        limits: { perIp: options.perIp ?? 600 },
      }),
      { now: clock.now, random: randomBytes, log: () => {} },
    );
  let gateway: Gateway = await start(sealKeys);
  cleanup.push(() => apns.close());
  cleanup.push(() => gateway.close());
  // The gateway listens on a random port but daemons sign for its public origin.
  const forward: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    url.port = String(gateway.port);
    return fetch(url, init);
  };
  const phone = phoneKeys();
  const device = NotificationDevice.parse({
    id: "phone",
    preferences: {},
    address: {
      channel: "push",
      platform: "phone",
      token: "ab".repeat(32),
      environment: "sandbox",
      p256dh: phone.p256dh,
      auth: phone.auth,
    },
  });
  const state = { enabled: true };
  const transport = createPushGatewayTransport(
    {
      privateKey: signingKeyPem(),
      hostId: "HOST",
      target: () => ({ enabled: state.enabled, origin: "http://127.0.0.1:1" }),
    },
    clock.now,
    forward,
  );
  const restart = async (keys: Buffer[]) => {
    await gateway.close();
    gateway = await start(keys);
  };
  return { apns, clock, phone, device, transport, state, restart };
}
const alert = Notification.parse({
  id: "n:1",
  threadId: "thread-1",
  title: "Fix the login bug",
  status: "needs_you",
  interactionId: "approval-1",
  backgroundCount: 0,
  actions: [
    { action: "approve", optionId: "yes" },
    { action: "deny", optionId: "no" },
  ],
});
const signal = () => new AbortController().signal;
const registrations = (apns: Awaited<ReturnType<typeof startFakeApns>>) => apns.calls.length;

it("delivers an alert only the phone can read, with the machine it came from", async () => {
  const { apns, phone, device, transport } = await setup();
  expect(await transport.send(device, alert, signal())).toBe("accepted");
  const call = apns.calls[0];
  if (!call) throw new Error("APNs got nothing");
  const payload = JSON.parse(call.body.toString());
  expect(call.body.toString()).not.toContain("Fix the login bug");
  const sealed = Buffer.from(payload.ace.c, "base64url");
  const opened = PushAlertPayload.parse(JSON.parse(phone.decrypt(sealed).toString()));
  expect(opened).toEqual({ v: 1, hostId: "HOST", notification: alert });
  expect(call.headers["apns-priority"]).toBe("10");
});

it("never sends while push is off on this machine, and retries instead", async () => {
  const { apns, device, transport, state } = await setup();
  state.enabled = false;
  expect(await transport.send(device, alert, signal())).toBe("retry");
  expect(registrations(apns)).toBe(0);
});

it("re-registers when a handle expires or the gateway rotates its sealing key", async () => {
  const first = randomBytes(32);
  const { apns, clock, device, transport, restart } = await setup({ sealKeys: [first] });
  expect(await transport.send(device, alert, signal())).toBe("accepted");
  // Past the handle's 30 days the transport registers again before pushing.
  clock.advance(31 * day);
  expect(await transport.send(device, alert, signal())).toBe("accepted");
  // A new sealing key alone makes cached handles unreadable (404): register once more.
  await restart([randomBytes(32)]);
  expect(await transport.send(device, alert, signal())).toBe("accepted");
  // With the old key kept as previous, handles sealed under it still open.
  await restart([randomBytes(32), first]);
  expect(await transport.send(device, alert, signal())).toBe("accepted");
  expect(apns.calls).toHaveLength(4);
});

it("marks the address gone when APNs no longer knows the phone", async () => {
  const { apns, device, transport } = await setup();
  apns.answer("ab".repeat(32), 410, "Unregistered");
  expect(await transport.send(device, alert, signal())).toBe("gone");
});

it("retries when the gateway limits the client", async () => {
  const { device, transport } = await setup({ perIp: 2 });
  expect(await transport.send(device, alert, signal())).toBe("accepted");
  expect(await transport.send(device, alert, signal())).toBe("retry");
});

it("fits an oversized alert by dropping its preview and message", async () => {
  const { apns, phone, device, transport } = await setup();
  const long = Notification.parse({
    ...alert,
    status: "agent_says",
    title: "t".repeat(200),
    preview: "p".repeat(300),
    message: "m".repeat(300),
    threadIds: Array.from({ length: 100 }, (_, i) => `thread-${i}-${"x".repeat(180)}`),
  });
  expect(await transport.send(device, long, signal())).toBe("accepted");
  const payload = JSON.parse(String(apns.calls[0]?.body));
  const opened = PushAlertPayload.parse(
    JSON.parse(phone.decrypt(Buffer.from(payload.ace.c, "base64url")).toString()),
  );
  expect(opened.notification.title).toBe(long.title);
  expect(opened.notification.threadIds).toBeUndefined();
});
