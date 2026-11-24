import { createPrivateKey, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { createPushGatewayTransport, vapidAuthorization } from "@ace/notify";
import {
  Notification,
  NotificationDevice,
  PushAccessPayload,
  PushAlertPayload,
} from "@ace/protocol";
import { GatewayConfig } from "./config.ts";
import { startGateway, type Gateway } from "./server.ts";
import { apnsKeyPair, phoneKeys, signingKeyPem, startFakeApns } from "./testing/fake-apns.ts";

const day = 24 * 60 * 60_000;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).toReversed()) await stop();
});

async function setup(
  options: {
    sealKeys?: Buffer[];
    perIp?: number;
    registrationsPerDaemon?: number;
    /** Answer a request locally instead of reaching the gateway; called for every request. */
    intercept?: (
      url: URL,
      init: RequestInit | undefined,
    ) => Response | undefined | Promise<Response | undefined>;
  } = {},
) {
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
        limits: {
          perIp: options.perIp ?? 600,
          ...(options.registrationsPerDaemon === undefined
            ? {}
            : { registrationsPerDaemon: options.registrationsPerDaemon }),
        },
      }),
      { now: clock.now, random: randomBytes, log: () => {} },
    );
  let gateway: Gateway = await start(sealKeys);
  cleanup.push(() => apns.close());
  cleanup.push(() => gateway.close());
  // The gateway listens on a random port but daemons sign for its public origin.
  const forward: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const answer = await options.intercept?.(url, init);
    if (answer) return answer;
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
  const privateKey = signingKeyPem();
  const transport = createPushGatewayTransport(
    {
      privateKey,
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
  return {
    apns,
    clock,
    phone,
    device,
    transport,
    state,
    restart,
    privateKey,
    origin: () => `http://127.0.0.1:${gateway.port}`,
  };
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
const activityAddress = {
  token: "ab".repeat(32),
  environment: "sandbox",
  kind: "liveactivity",
} as const;
const startAddress = { ...activityAddress, kind: "start" } as const;
const registrationAddress = (token: string) =>
  ({ token, environment: "sandbox", kind: "liveactivity" }) as const;
const activityStates = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/live-activity-content-state.json", import.meta.url),
    "utf8",
  ),
);
const activityUpdate = {
  v: 1,
  event: "update",
  timestamp: 1795500002,
  priority: 5,
  staleAfter: 900,
  state: activityStates.update,
};

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

it("pushes a sign-in request the phone reads as one, held no longer than the request lives", async () => {
  const { apns, clock, phone, device, transport } = await setup();
  const access = {
    requestId: "request-1",
    clientName: "Claude",
    domain: "claude.ai",
    matchCode: "7KQ2XM",
    expiresAt: clock.now() + 9 * 60_000,
  };
  expect(await transport.sendAccess(device, access, signal())).toBe("accepted");
  const call = apns.calls[0];
  if (!call) throw new Error("APNs got nothing");
  expect(call.body.toString()).not.toContain("7KQ2XM");
  const sealed = Buffer.from(JSON.parse(call.body.toString()).ace.c, "base64url");
  const opened: unknown = JSON.parse(phone.decrypt(sealed).toString());
  // Exactly who asks and the code to compare: no scopes, grant, token or redirect.
  expect(PushAccessPayload.strict().parse(opened)).toEqual({ v: 1, hostId: "HOST", access });
  // A phone that only knows thread alerts can't mistake it for one; it keeps the generic text.
  expect(PushAlertPayload.safeParse(opened).success).toBe(false);
  expect(Number(call.headers["apns-expiration"])).toBe(Math.floor(access.expiresAt / 1000));
  expect(call.headers["apns-priority"]).toBe("10");
});

it("never pushes a sign-in request that already ran out", async () => {
  const { apns, clock, device, transport } = await setup();
  const access = {
    requestId: "request-1",
    clientName: "Claude",
    domain: null,
    matchCode: "7KQ2XM",
    expiresAt: clock.now(),
  };
  expect(await transport.sendAccess(device, access, signal())).toBe("failed");
  expect(apns.calls).toHaveLength(0);
});

it("registers one phone token separately for each activity kind, apart from its alert handle", async () => {
  const bodies: unknown[] = [];
  const { apns, clock, device, privateKey, origin, transport } = await setup({
    intercept(url, init) {
      if (url.pathname === "/v1/registrations" && typeof init?.body === "string")
        bodies.push(JSON.parse(init.body));
      return undefined;
    },
  });
  const live = await transport.registerActivity(activityAddress, signal());
  const start = await transport.registerActivity(startAddress, signal());
  if (live.status !== "registered" || start.status !== "registered")
    throw new Error(`registration failed: ${live.status}, ${start.status}`);
  expect(live.handle).not.toBe(start.handle);
  // The kind is part of what is registered, and the cache keeps each kind apart.
  expect(await transport.registerActivity(activityAddress, signal())).toEqual(live);
  expect(bodies).toEqual([
    { token: activityAddress.token, environment: "sandbox", kind: "liveactivity" },
    { token: activityAddress.token, environment: "sandbox", kind: "start" },
  ]);
  // A Live Activity handle can't send an alert through the gateway.
  const authorization = vapidAuthorization(
    createPrivateKey(privateKey),
    "http://127.0.0.1:1",
    undefined,
    clock.now(),
  );
  const refused = await fetch(`${origin()}/v1/push/${live.handle}`, {
    method: "POST",
    headers: {
      "content-encoding": "aes128gcm",
      ttl: "60",
      urgency: "high",
      authorization,
    },
    body: new Uint8Array(randomBytes(32)),
  });
  expect(refused.status).toBe(403);
  // A start handle can't carry an update, even when the body is otherwise valid.
  const wrongEvent = await fetch(`${origin()}/v1/activity/${start.handle}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization },
    body: JSON.stringify(activityUpdate),
  });
  expect(wrongEvent.status).toBe(403);
  // The alert path keeps its own handle and body, unchanged by activity kinds.
  expect(await transport.send(device, alert, signal())).toBe("accepted");
  expect(bodies.at(-1)).toEqual({ token: activityAddress.token, environment: "sandbox" });
  expect(apns.calls.at(-1)?.headers[":path"]).toBe(`/3/device/${activityAddress.token}`);
});

it("asks a gateway what it supports and remembers an older one for an hour", async () => {
  let legacy = true;
  let probes = 0;
  const { clock, device, transport } = await setup({
    intercept(url) {
      if (url.pathname !== "/v1/capabilities") return undefined;
      probes++;
      return legacy ? new Response("", { status: 404 }) : undefined;
    },
  });
  expect(await transport.registerActivity(activityAddress, signal())).toEqual({
    status: "unsupported",
  });
  expect(await transport.registerActivity(activityAddress, signal())).toEqual({
    status: "unsupported",
  });
  expect(probes).toBe(1);
  // Alerts never depend on the capabilities route.
  expect(await transport.send(device, alert, signal())).toBe("accepted");
  legacy = false;
  clock.advance(60 * 60_000 - 1);
  expect(await transport.registerActivity(activityAddress, signal())).toEqual({
    status: "unsupported",
  });
  expect(probes).toBe(1);
  clock.advance(2);
  expect(await transport.registerActivity(activityAddress, signal())).toMatchObject({
    status: "registered",
  });
  expect(probes).toBe(2);
});

it("does not remember a capability probe that failed", async () => {
  let probes = 0;
  const { transport } = await setup({
    intercept(url) {
      if (url.pathname !== "/v1/capabilities") return undefined;
      probes++;
      if (probes === 1) return new Response("", { status: 503 });
      if (probes === 2)
        return new Response(JSON.stringify({ kinds: "alert" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      return undefined;
    },
  });
  expect(await transport.registerActivity(activityAddress, signal())).toEqual({ status: "retry" });
  expect(await transport.registerActivity(activityAddress, signal())).toEqual({ status: "retry" });
  expect(await transport.registerActivity(activityAddress, signal())).toMatchObject({
    status: "registered",
  });
  expect(probes).toBe(3);
});

it("registers nothing while push is off on this machine", async () => {
  let requests = 0;
  const { state, transport } = await setup({
    intercept() {
      requests++;
      return undefined;
    },
  });
  state.enabled = false;
  expect(await transport.registerActivity(activityAddress, signal())).toEqual({
    status: "disabled",
  });
  expect(requests).toBe(0);
});

it("renews an activity handle a day before expiry and forgets one on removal", async () => {
  let registrationCount = 0;
  const { clock, transport } = await setup({
    intercept(url) {
      if (url.pathname === "/v1/registrations") registrationCount++;
      return undefined;
    },
  });
  const first = await transport.registerActivity(activityAddress, signal());
  if (first.status !== "registered") throw new Error(`registration failed: ${first.status}`);
  expect(await transport.registerActivity(activityAddress, signal())).toEqual(first);
  expect(registrationCount).toBe(1);
  clock.advance(29 * day);
  const renewed = await transport.registerActivity(activityAddress, signal());
  if (renewed.status !== "registered") throw new Error(`registration failed: ${renewed.status}`);
  expect(renewed.handle).not.toBe(first.handle);
  expect(registrationCount).toBe(2);
  // Removing the token at once makes the next request register it again.
  transport.forgetActivity(activityAddress);
  expect(await transport.registerActivity(activityAddress, signal())).toMatchObject({
    status: "registered",
  });
  expect(registrationCount).toBe(3);
});

it("does not cache a handle whose token was forgotten while it registered", async () => {
  const deferred: { release?: () => void } = {};
  const gate = new Promise<void>((resolve) => {
    deferred.release = resolve;
  });
  let registrationCount = 0;
  const { transport } = await setup({
    async intercept(url) {
      if (url.pathname !== "/v1/registrations") return undefined;
      registrationCount++;
      if (registrationCount === 1) await gate;
      return undefined;
    },
  });
  const pending = transport.registerActivity(activityAddress, signal());
  await vi.waitFor(() => expect(registrationCount).toBe(1));
  transport.forgetActivity(activityAddress);
  deferred.release?.();
  // The token was removed while its handle was being registered: don't hand back that handle.
  expect(await pending).toEqual({ status: "retry" });
  expect(await transport.registerActivity(activityAddress, signal())).toMatchObject({
    status: "registered",
  });
  expect(registrationCount).toBe(2);
});

it("shares one capability probe and registration between concurrent requests", async () => {
  let probes = 0;
  let registrationCount = 0;
  const { transport } = await setup({
    intercept(url) {
      if (url.pathname === "/v1/capabilities") probes++;
      if (url.pathname === "/v1/registrations") registrationCount++;
      return undefined;
    },
  });
  const results = await Promise.all([
    transport.registerActivity(activityAddress, signal()),
    transport.registerActivity(activityAddress, signal()),
    transport.registerActivity(activityAddress, signal()),
  ]);
  expect(probes).toBe(1);
  expect(registrationCount).toBe(1);
  const handles = results.map((result) => (result.status === "registered" ? result.handle : ""));
  expect(new Set(handles).size).toBe(1);
  expect(handles[0]).not.toBe("");
});

it("maps registration refusals without keeping or echoing the token", async () => {
  let reply: Response | undefined;
  const { transport } = await setup({
    intercept(url) {
      return url.pathname === "/v1/registrations" ? reply : undefined;
    },
  });
  const answer = async (token: string, response: Response) => {
    reply = response;
    return transport.registerActivity(registrationAddress(token), signal());
  };
  expect(await answer("aa".repeat(32), new Response("", { status: 410 }))).toEqual({
    status: "gone",
  });
  const limited = await answer(
    "bb".repeat(32),
    new Response("", { status: 429, headers: { "retry-after": "7" } }),
  );
  expect(limited).toEqual({ status: "retry", retryAfterMs: 7000 });
  expect(JSON.stringify(limited)).not.toContain("bb".repeat(32));
  expect(await answer("cc".repeat(32), new Response("", { status: 503 }))).toEqual({
    status: "retry",
  });
  expect(await answer("dd".repeat(32), new Response("", { status: 404 }))).toEqual({
    status: "retry",
  });
  expect(await answer("ee".repeat(32), new Response("", { status: 400 }))).toEqual({
    status: "failed",
  });
  expect(
    await answer(
      "ff".repeat(32),
      new Response("", { status: 429, headers: { "retry-after": "999999999999999999" } }),
    ),
  ).toEqual({ status: "retry", retryAfterMs: 2 ** 31 - 1 });
});
