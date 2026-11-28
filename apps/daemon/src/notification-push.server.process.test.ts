import { createServer, type Server } from "node:http";
import { createECDH, generateKeyPairSync, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { pairingLinkProof } from "@ace/client/link-proof";
import {
  AgentId,
  DeviceId,
  SocketTicket,
  ThreadId,
  type Notification,
  type ServerMessage,
} from "@ace/protocol";
import { connectClientViaRelay, startRelay, type ClientChannel } from "@ace/relay";
import { keyPair } from "@ace/secure-channel";
import { createPushGatewayTransport, NotificationWorker } from "@ace/notify";
import { SettingsService } from "@ace/settings";
import { GatewayConfig } from "../../push-gateway/src/config.ts";
import { startGateway } from "../../push-gateway/src/server.ts";
import { apnsKeyPair, startFakeApns } from "../../push-gateway/src/testing/fake-apns.ts";
import { pushTarget } from "./notification-config.ts";
import { followRemotePushSetting } from "./notification-live-activity.ts";
import { notificationFixture } from "./notification-test-support.ts";
import { accessRequest } from "./client-access.ts";
import { fixture } from "./socket-test-support.ts";
import { createDaemonNotifications, type DaemonNotifications } from "./notifications.ts";
import { ChildLedger } from "./machines/child-ledger.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

interface GatewayPost {
  path: string;
  encoding: string | string[] | undefined;
  body: Buffer;
}
/** A stand-in for the push gateway: registrations succeed and pushes are recorded. */
async function stubGateway() {
  const registrations: string[] = [];
  const posts: GatewayPost[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method === "POST" && request.url === "/v1/registrations") {
        registrations.push(Buffer.concat(chunks).toString());
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ handle: "a".repeat(32), expiresAt: Date.now() + 3600_000 }));
      } else if (request.method === "POST" && request.url?.startsWith("/v1/push/")) {
        posts.push({
          path: request.url,
          encoding: request.headers["content-encoding"],
          body: Buffer.concat(chunks),
        });
        response.writeHead(201);
        response.end();
      } else {
        response.writeHead(404);
        response.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Stub gateway has no port");
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { origin: `http://127.0.0.1:${address.port}`, registrations, posts };
}

const phoneKeys = () => {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
  };
};
const daemonKey = () =>
  generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  });

async function pushDaemon(
  relay?: { url: string; keys: ReturnType<typeof keyPair> },
  beforeFeedReply?: () => Promise<void>,
) {
  const gateway = await stubGateway();
  const errors: unknown[] = [];
  const state = { enabled: true };
  const push = createPushGatewayTransport(
    {
      privateKey: daemonKey(),
      hostId: "test-host",
      target: () => ({ enabled: state.enabled, origin: gateway.origin }),
    },
    Date.now,
  );
  let notifications!: DaemonNotifications;
  const f = await fixture(relay ? { relay } : {}, (store, home) => {
    notifications = createDaemonNotifications(
      home,
      store,
      (error) => errors.push(error),
      { push },
      0,
    );
    return {
      notifications: {
        ...notifications.service,
        async feed(...args) {
          const page = await notifications.service.feed(...args);
          await beforeFeedReply?.();
          return page;
        },
      },
    };
  });
  notifications.setSender((device, notification) => f.server.notify(device, notification));
  notifications.setConnected(() => f.server.notificationDevices());
  notifications.activate();
  cleanups.push(async () => {
    await notifications.close();
    await f.close();
  });
  // The thread genuinely needs the person: the worker raises a needs_you alert from this.
  const raise = async () => {
    f.store.appendEvents(f.thread.id, [
      { type: "thread.updated", status: { state: "working", agents: 1 } },
      { type: "thread.updated", status: { state: "needs_you", interactions: 1 } },
    ]);
    return notifications.tick();
  };
  return { f, gateway, state, errors, notifications, raise };
}

async function setup() {
  const daemon = await pushDaemon();
  const { f, notifications } = daemon;
  const client = await f.connect();
  expect(await client.next()).toMatchObject({ type: "welcome" });
  const phone = DeviceId.parse("device");
  client.send({
    type: "notification.register",
    requestId: "push",
    device: {
      channel: "push",
      platform: "phone",
      token: "ab".repeat(32),
      environment: "sandbox",
      ...phoneKeys(),
    },
  });
  expect(await client.next()).toEqual({
    type: "notification.register.result",
    requestId: "push",
  });
  const liveFrame = async (): Promise<Notification> => {
    const frame = await client.next();
    if (frame.type !== "notification") throw new Error(`Expected a live alert, got ${frame.type}`);
    return frame.notification;
  };
  const delivered = async (id: string) =>
    poll(async () => {
      const feed = await notifications.service.feed(phone, 0);
      return feed.entries.some((entry) => entry.notification.id === id) ? true : undefined;
    }, 15_000);
  return { ...daemon, client, phone, liveFrame, delivered };
}

async function poll<T>(read: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= until) throw new Error("Timed out waiting for the daemon");
    await sleep(50);
  }
}

it("a phone that acknowledges its live alert gets no push", async () => {
  const { gateway, errors, client, liveFrame, delivered, raise } = await setup();
  const draining = raise();
  const frame = await liveFrame();
  client.send({ type: "notification.ack", id: frame.id });
  await draining;
  // The delivery finished accepted, so no push can follow it.
  await delivered(frame.id);
  expect(gateway.posts).toEqual([]);
  expect(errors).toEqual([]);
});

it("a phone that stays silent falls through to an opaque push", async () => {
  const { gateway, errors, liveFrame, raise } = await setup();
  const draining = raise();
  // The live frame still goes out first; only the missing ack falls through to push.
  const frame = await liveFrame();
  const post = await poll(async () => gateway.posts.at(-1), 15_000);
  expect(post.encoding).toBe("aes128gcm");
  expect(post.body.length).toBeGreaterThan(100);
  expect(post.body.toString()).not.toContain(frame.title);
  // The daemon registered its own identity before pushing.
  expect(gateway.registrations).toHaveLength(1);
  await draining;
  expect(errors).toEqual([]);
});

it("the per-machine switch turns push off without unregistering the phone", async () => {
  const { gateway, errors, client, state, liveFrame, raise } = await setup();
  state.enabled = false;
  const draining = raise();
  // The live frame still goes out; the push transport then refuses without any network.
  const frame = await liveFrame();
  expect(frame.status).toBe("needs_you");
  await sleep(4500);
  expect(gateway.registrations).toEqual([]);
  expect(gateway.posts).toEqual([]);
  expect(errors).toEqual([]);
  await client.close();
  await draining;
});

async function nextOf<T extends ServerMessage["type"]>(channel: ClientChannel, type: T) {
  for await (const message of channel) {
    if (message.type === type) return message as Extract<ServerMessage, { type: T }>;
    if (message.type === "error") throw new Error(message.code);
  }
  throw new Error("Relay closed before " + type);
}

it("a push wakes a relay-only phone, which resumes an interrupted feed from its daemon checkpoint", async () => {
  const relay = await startRelay();
  cleanups.push(() => relay.close());
  const waiting = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { f, gateway, raise } = await pushDaemon({ url: relay.url, keys: keyPair() }, async () => {
    waiting.resolve();
    await release.promise;
  });
  cleanups.push(release.resolve);
  const hostId = f.server.relayHostId;
  if (!hostId) throw new Error("Relay host missing");
  const paired = f.store.devices.create("iPhone", ["read"], Date.now());
  const open = async (device = paired) => {
    const channel = await connectClientViaRelay({
      relayUrl: relay.url,
      hostId,
      pinnedFingerprint: hostId,
    });
    cleanups.push(() => channel.close());
    await channel.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: device.device.id,
      token: device.token,
    });
    await nextOf(channel, "welcome");
    return channel;
  };
  const first = await open();
  await first.send({
    type: "notification.register",
    requestId: "push",
    device: {
      channel: "push",
      platform: "phone",
      token: "ab".repeat(32),
      environment: "sandbox",
      ...phoneKeys(),
    },
  });
  await nextOf(first, "notification.register.result");
  first.close();

  const draining = raise();
  const push = await poll(async () => gateway.posts.at(-1), 15_000);
  expect(push.encoding).toBe("aes128gcm");
  await draining;

  const wake = await open();
  // Drop the stream after the feed starts, before the simulated app applies or acknowledges it.
  await wake.send({ type: "notification.feed", requestId: "interrupted", afterCursor: 0 });
  await waiting.promise;
  wake.close();
  await wake.closed;
  release.resolve();

  const resumed = await open();
  await resumed.send({ type: "notification.feed", requestId: "resume" });
  const feed = await nextOf(resumed, "notification.feed.result");
  expect(feed.entries.map(({ notification }) => notification.status)).toEqual(["needs_you"]);
  await resumed.send({
    type: "notification.feed",
    requestId: "commit",
    afterCursor: feed.cursor,
    checkpoint: true,
  });
  expect(await nextOf(resumed, "notification.feed.result")).toMatchObject({
    cursor: feed.cursor,
    entries: [],
    retracted: [],
  });
  resumed.close();

  const next = await open();
  await next.send({ type: "notification.feed", requestId: "next" });
  expect((await nextOf(next, "notification.feed.result")).entries).toEqual([]);

  // A client that lost local state may explicitly ask for the bounded history again.
  await next.send({ type: "notification.feed", requestId: "rebuild", afterCursor: 0 });
  expect((await nextOf(next, "notification.feed.result")).entries).toEqual(feed.entries);
});

/**
 * The daemon against a real local push gateway and a fake APNs (the gateway's own process-test
 * setup). The gateway is reached through `forward`, which also records every registration body
 * and can answer the capabilities route as an older gateway would.
 */
async function activityDaemon(options: { capabilities?: boolean; schedule?: boolean } = {}) {
  const apns = await startFakeApns();
  let time = Date.parse("2026-11-24T12:00:00Z");
  const now = () => time;
  const gateway = await startGateway(
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
      sealKeys: [randomBytes(32)],
      limits: { perIp: 600 },
    }),
    { now, random: randomBytes, log: () => {} },
  );
  const registrations: { token: string; environment: string; kind?: string }[] = [];
  const forward: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/v1/capabilities" && options.capabilities === false)
      return Promise.resolve(new Response("", { status: 404 }));
    if (url.pathname === "/v1/registrations" && typeof init?.body === "string")
      registrations.push(JSON.parse(init.body) as (typeof registrations)[number]);
    url.port = String(gateway.port);
    return fetch(url, init);
  };
  const errors: unknown[] = [];
  let settings!: SettingsService;
  let notifications!: DaemonNotifications;
  const f = await fixture({}, (store, home) => {
    settings = new SettingsService({ dataDir: home });
    // The switch follows the real setting; the origin points at this test's gateway.
    const target = async () => ({
      enabled: (await pushTarget(settings)).enabled,
      origin: "http://127.0.0.1:1",
    });
    const push = createPushGatewayTransport(
      { privateKey: daemonKey(), hostId: "test-host", target },
      now,
      forward,
    );
    notifications = createDaemonNotifications(
      home,
      store,
      (error) => errors.push(error),
      { push },
      0,
      {
        ...(options.schedule ? { now, monotonic: now } : {}),
        liveActivity: { gateway: push, target, allowed: () => true },
      },
    );
    return { notifications: { ...notifications.service } };
  });
  notifications.setSender((device, notification) => f.server.notify(device, notification));
  notifications.setConnected(() => f.server.notificationDevices());
  notifications.activate();
  cleanups.push(async () => {
    await notifications.close();
    await f.close();
    await settings.close();
    await gateway.close();
    await apns.close();
  });
  const raise = async () => {
    f.store.appendEvents(f.thread.id, [
      { type: "thread.updated", status: { state: "working", agents: 1 } },
      { type: "thread.updated", status: { state: "needs_you", interactions: 1 } },
    ]);
    return notifications.tick();
  };
  return {
    f,
    apns,
    gateway,
    settings,
    errors,
    notifications,
    registrations,
    raise,
    now,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

const liveActivityOf = (startToken?: string, activityToken?: string) => ({
  ...(startToken ? { startToken } : {}),
  ...(activityToken ? { activityToken } : {}),
  environment: "sandbox" as const,
  frequentUpdates: true,
  slot: 2,
});
const startOf = "a1".repeat(32);
const activityOf = "b2".repeat(32);
const kindRegistrations = (registrations: readonly { kind?: string }[]) =>
  registrations.filter((entry) => entry.kind !== undefined);

it("registers a phone's live activity tokens under their own kinds", async () => {
  const daemon = await activityDaemon();
  const client = await daemon.f.connect();
  expect(await client.next()).toMatchObject({ type: "welcome" });
  client.send({
    type: "notification.register",
    requestId: "register",
    device: { channel: "websocket", platform: "phone" },
    liveActivity: liveActivityOf(startOf, activityOf),
  });
  expect(await client.next()).toEqual({
    type: "notification.register.result",
    requestId: "register",
  });
  await poll(
    async () => (kindRegistrations(daemon.registrations).length === 2 ? true : undefined),
    15_000,
  );
  expect(kindRegistrations(daemon.registrations)).toEqual(
    expect.arrayContaining([
      { token: startOf, environment: "sandbox", kind: "start" },
      { token: activityOf, environment: "sandbox", kind: "liveactivity" },
    ]),
  );
  expect(await daemon.notifications.service.liveActivityTargets()).toEqual([
    {
      token: startOf,
      environment: "sandbox",
      kind: "start",
      frequentUpdates: true,
      slot: 2,
      devices: ["device"],
    },
    {
      token: activityOf,
      environment: "sandbox",
      kind: "liveactivity",
      frequentUpdates: true,
      slot: 2,
      devices: ["device"],
    },
  ]);
  expect(daemon.errors).toEqual([]);
});

const liveActivityTargets = (startToken?: string, activityToken?: string) => ({
  ...(startToken
    ? {
        token: startToken,
        environment: "sandbox",
        kind: "start",
        frequentUpdates: true,
        slot: 2,
        devices: ["device"],
      }
    : {}),
  ...(activityToken
    ? {
        token: activityToken,
        environment: "sandbox",
        kind: "liveactivity",
        frequentUpdates: true,
        slot: 2,
        devices: ["device"],
      }
    : {}),
});

/** A paired device's socket, with the ticket its credential buys. */
async function pairedClient(
  daemon: Awaited<ReturnType<typeof activityDaemon>>,
  device: { device: { id: DeviceId }; token: string },
) {
  const ticket = SocketTicket.parse(
    await accessRequest(daemon.f.server.httpUrl, "/v1/tickets", {
      method: "POST",
      token: device.token,
    }),
  );
  const client = await daemon.f.open();
  client.send({
    type: "hello",
    protocolVersion: 1,
    deviceId: device.device.id,
    ticket: ticket.ticket,
  });
  expect(await client.next()).toMatchObject({ type: "welcome" });
  return client;
}

async function registerPhone(
  client: Awaited<ReturnType<Awaited<ReturnType<typeof activityDaemon>>["f"]["connect"]>>,
  requestId: string,
  device: { channel: "websocket"; platform: "phone" } | Record<string, unknown>,
  liveActivity?: ReturnType<typeof liveActivityOf>,
) {
  client.send({
    type: "notification.register",
    requestId,
    device,
    ...(liveActivity ? { liveActivity } : {}),
  } as never);
  // A thread's earlier alert may still be on its way over the socket ahead of the reply.
  let reply = await client.next();
  while (reply.type === "notification") reply = await client.next();
  expect(reply).toEqual({ type: "notification.register.result", requestId });
}

it("an older gateway gets no activity handles and alerts keep working", async () => {
  const daemon = await activityDaemon({ capabilities: false });
  const client = await daemon.f.connect();
  expect(await client.next()).toMatchObject({ type: "welcome" });
  await registerPhone(
    client,
    "register",
    {
      channel: "push",
      platform: "phone",
      token: "ab".repeat(32),
      environment: "sandbox",
      ...phoneKeys(),
    },
    liveActivityOf(startOf, activityOf),
  );
  await sleep(500);
  // A 404 from capabilities means alerts only: no activity handle is asked for.
  expect(kindRegistrations(daemon.registrations)).toEqual([]);
  // The tokens stay stored for a gateway that upgrades, but nothing pushes with them yet.
  expect(await daemon.notifications.service.liveActivityTargets()).toHaveLength(2);
  const draining = daemon.raise();
  await poll(async () => daemon.apns.calls.at(-1), 15_000);
  await draining;
  const alert = JSON.parse(String(daemon.apns.calls[0]?.body)) as { aps: { alert?: unknown } };
  expect(alert.aps.alert).toBeDefined();
  expect(daemon.errors).toEqual([]);
});

it("a sync without a token drops it and forgets the gateway handle", async () => {
  const daemon = await activityDaemon();
  const client = await daemon.f.connect();
  expect(await client.next()).toMatchObject({ type: "welcome" });
  await registerPhone(
    client,
    "one",
    { channel: "websocket", platform: "phone" },
    liveActivityOf(startOf, activityOf),
  );
  await poll(
    async () => (kindRegistrations(daemon.registrations).length === 2 ? true : undefined),
    15_000,
  );

  // The activity ended on the phone: only its update token goes.
  await registerPhone(
    client,
    "two",
    { channel: "websocket", platform: "phone" },
    liveActivityOf(startOf),
  );
  expect(await daemon.notifications.service.liveActivityTargets()).toEqual([
    liveActivityTargets(startOf),
  ]);

  // Its handle was forgotten too: asking for the token again registers it afresh.
  const before = daemon.registrations.filter((entry) => entry.token === activityOf).length;
  await registerPhone(
    client,
    "three",
    { channel: "websocket", platform: "phone" },
    liveActivityOf(startOf, activityOf),
  );
  await poll(
    async () =>
      daemon.registrations.filter((entry) => entry.token === activityOf).length > before
        ? true
        : undefined,
    15_000,
  );

  // The object is gone: both tokens go.
  await registerPhone(client, "four", { channel: "websocket", platform: "phone" });
  expect(await daemon.notifications.service.liveActivityTargets()).toEqual([]);
  expect(daemon.errors).toEqual([]);
});

it("one phone over two linked ids registers each token once", async () => {
  const daemon = await activityDaemon();
  const account = DeviceId.parse("account-phone");
  const pair = async (name: string) => {
    const paired = daemon.f.store.devices.create(name, ["read"], Date.now());
    const proof = await pairingLinkProof(paired.token, paired.device.id, account, crypto.subtle);
    daemon.f.store.devices.link(account, proof, Date.now());
    return paired;
  };
  const direct = await pair("Phone direct");
  const relay = await pair("Phone relay");
  const first = await pairedClient(daemon, direct);
  await registerPhone(
    first,
    "direct",
    { channel: "websocket", platform: "phone" },
    liveActivityOf(startOf, activityOf),
  );
  await poll(
    async () => (kindRegistrations(daemon.registrations).length === 2 ? true : undefined),
    15_000,
  );

  const second = await pairedClient(daemon, relay);
  await registerPhone(
    second,
    "relay",
    { channel: "websocket", platform: "phone" },
    liveActivityOf(startOf, activityOf),
  );
  await sleep(300);
  // The same tokens over the install's other id: still one registration per kind.
  expect(kindRegistrations(daemon.registrations)).toHaveLength(2);

  // Either id leaving clears what both registered.
  await registerPhone(second, "relay-off", { channel: "websocket", platform: "phone" });
  expect(await daemon.notifications.service.liveActivityTargets()).toEqual([]);
  expect(daemon.errors).toEqual([]);
});

it("turning remote push off clears the tokens without a new phone sync", async () => {
  const daemon = await activityDaemon();
  const client = await daemon.f.connect();
  expect(await client.next()).toMatchObject({ type: "welcome" });
  await registerPhone(
    client,
    "on",
    { channel: "websocket", platform: "phone" },
    liveActivityOf(startOf, activityOf),
  );
  await poll(
    async () => (kindRegistrations(daemon.registrations).length === 2 ? true : undefined),
    15_000,
  );

  const applied: boolean[] = [];
  let cleared: Promise<void> | undefined;
  const stop = await followRemotePushSetting(
    daemon.settings,
    (enabled) => {
      applied.push(enabled);
      const run = daemon.notifications.service.liveActivitySetting(enabled);
      if (!enabled) cleared = run;
      return run;
    },
    (error) => daemon.errors.push(error),
  );
  cleanups.push(stop);
  await daemon.settings.set("notifications.remotePush", false, { kind: "global" });
  await poll(async () => (cleared === undefined ? undefined : true), 5000);
  await cleared;
  expect(applied).toEqual([false]);
  expect(await daemon.notifications.service.liveActivityTargets()).toEqual([]);

  // Back on does not resurrect what the switch erased: only a phone sync does.
  await daemon.settings.set("notifications.remotePush", true, { kind: "global" });
  expect(await daemon.notifications.service.liveActivityTargets()).toEqual([]);
  expect(daemon.errors).toEqual([]);
});

it("retained tokens are cleared at startup when remote push is off", async () => {
  const f = notificationFixture(cleanups);
  const phone = DeviceId.parse("phone");
  const worker = new NotificationWorker({
    path: f.path,
    transport: { send: async () => "accepted" },
  });
  await worker.register(phone, {
    channel: "push",
    platform: "phone",
    token: "ab".repeat(32),
    environment: "sandbox",
    ...phoneKeys(),
  });
  await worker.syncLiveActivity(phone, [], liveActivityOf(startOf, activityOf));
  await worker.close();

  const settings = new SettingsService({ dataDir: f.home });
  await settings.set("notifications.remotePush", false, { kind: "global" });
  const calls: string[] = [];
  const gateway = {
    async registerActivity() {
      calls.push("register");
      return { status: "disabled" as const };
    },
    forgetActivity() {
      calls.push("forget");
    },
  };
  const notifications = createDaemonNotifications(f.home, f.store, () => {}, {}, 0, {
    liveActivity: { gateway, target: () => pushTarget(settings), allowed: () => true },
  });
  cleanups.push(
    () => settings.close(),
    () => notifications.close(),
  );
  // The delivery run performs the post-catch-up resume, as it does in production.
  await notifications.start();
  await notifications.tick();
  expect(await notifications.service.liveActivityTargets()).toEqual([]);

  const check = new NotificationWorker({
    path: f.path,
    transport: { send: async () => "failed" },
  });
  expect(await check.liveActivityTargets()).toEqual([]);
  await check.close();
  // Nothing reached the gateway for tokens the switch had already erased.
  expect(calls).toEqual([]);
});

it("unregistering or revoking a phone removes its tokens", async () => {
  const daemon = await activityDaemon();
  const paired = daemon.f.store.devices.create("Phone", ["read", "operate", "admin"], Date.now());
  const client = await pairedClient(daemon, paired);
  await registerPhone(
    client,
    "one",
    { channel: "websocket", platform: "phone" },
    liveActivityOf(startOf, activityOf),
  );
  await poll(
    async () => (kindRegistrations(daemon.registrations).length === 2 ? true : undefined),
    15_000,
  );

  client.send({ type: "notification.unregister", requestId: "off" });
  expect(await client.next()).toEqual({
    type: "notification.unregister.result",
    requestId: "off",
  });
  expect(await daemon.notifications.service.liveActivityTargets()).toEqual([]);

  await registerPhone(
    client,
    "two",
    { channel: "websocket", platform: "phone" },
    liveActivityOf(startOf, activityOf),
  );
  expect(await daemon.notifications.service.liveActivityTargets()).toHaveLength(2);
  const host = await daemon.f.connect();
  expect(await host.next()).toMatchObject({ type: "welcome" });
  host.send({
    type: "fleet.request",
    requestId: "revoke",
    operation: { op: "revoke", deviceId: paired.device.id },
  });
  await poll(
    async () =>
      (await daemon.notifications.service.liveActivityTargets()).length === 0 ? true : undefined,
    5000,
  );
  expect(daemon.errors).toEqual([]);
});

it("pushes the latest machine state and ends only after its remote child and quiet window settle", async () => {
  const daemon = await activityDaemon({ schedule: true });
  const { f, notifications, apns, now, advance } = daemon;
  const client = await f.connect();
  expect(await client.next()).toMatchObject({ type: "welcome" });
  await registerPhone(
    client,
    "activity",
    { channel: "websocket", platform: "phone" },
    liveActivityOf(startOf, activityOf),
  );
  const activityCalls = () =>
    apns.calls.filter((call) => call.headers["apns-push-type"] === "liveactivity");
  const delivered = async (count: number) => {
    await notifications.tick();
    const call = await poll(async () => activityCalls()[count - 1], 2500);
    return {
      headers: call.headers,
      aps: JSON.parse(String(call.body)).aps as Record<string, unknown>,
    };
  };
  const status = (value: import("@ace/protocol").ThreadStatus) =>
    f.store.appendEvents(f.thread.id, [{ type: "thread.updated", status: value }], now());

  status({ state: "working", agents: 1 });
  const working = await delivered(1);
  expect(working.headers).toMatchObject({
    "apns-priority": "5",
    "apns-topic": "app.ace.ios.push-type.liveactivity",
  });
  expect(working.aps).toMatchObject({
    event: "update",
    "content-state": { phase: "busy", working: 1 },
  });

  status({ state: "needs_you", interactions: 1 });
  await notifications.tick();
  expect(activityCalls()).toHaveLength(1);
  advance(1000);
  const asking = await delivered(2);
  expect(asking.headers["apns-priority"]).toBe("10");
  expect(asking.aps).toMatchObject({ event: "update", "content-state": { needsYou: 1 } });

  const ledger = new ChildLedger(f.store);
  const child = ThreadId.parse("remote-child");
  ledger.insert({
    id: child,
    requestKey: "child-request",
    parentThreadId: f.thread.id,
    parentAgentId: AgentId.parse("root"),
    machine: "remote",
    role: "worker",
    provider: "codex",
    createdAt: now(),
    view: undefined,
    device: undefined,
  });
  status({ state: "done" });
  advance(1000);
  const childWorking = await delivered(3);
  expect(childWorking.aps).toMatchObject({
    event: "update",
    "content-state": { needsYou: 0, working: 1 },
  });
  advance(120_000);
  await notifications.tick();
  expect(activityCalls()).toHaveLength(3);

  ledger.writeView(child, "{}", true, now());
  await notifications.tick();
  advance(119_999);
  await notifications.tick();
  expect(
    activityCalls().every((call) => JSON.parse(String(call.body)).aps.event === "update"),
  ).toBe(true);
  const count = activityCalls().length;
  advance(1000);
  const end = await delivered(count + 1);
  expect(end.headers["apns-priority"]).toBe("10");
  expect(end.aps).toMatchObject({
    event: "end",
    "dismissal-date": Number(end.aps.timestamp) + 900,
    "content-state": { phase: "settled", done: 1, working: 0 },
  });
  expect(Number(end.aps.timestamp)).toBeGreaterThan(Number(childWorking.aps.timestamp));
  await poll(
    async () =>
      (await notifications.service.liveActivityTargets()).length === 1 ? true : undefined,
    2500,
  );

  await daemon.settings.set("notifications.remotePush", false, { kind: "global" });
  await notifications.service.liveActivitySetting(false);
  await registerPhone(
    client,
    "off",
    { channel: "websocket", platform: "phone" },
    liveActivityOf(startOf, activityOf),
  );
  status({ state: "working", agents: 1 });
  advance(180_000);
  await notifications.tick();
  expect(activityCalls()).toHaveLength(count + 1);
  expect(await notifications.service.liveActivityTargets()).toEqual([]);
  expect(daemon.errors).toEqual([]);
});
