import { createServer, type Server } from "node:http";
import { createECDH, generateKeyPairSync, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { DeviceId, type Notification } from "@ace/protocol";
import { createPushGatewayTransport } from "@ace/notify";
import { fixture } from "./socket-test-support.ts";
import { createDaemonNotifications, type DaemonNotifications } from "./notifications.ts";

const cleanups: (() => Promise<void>)[] = [];
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

async function setup() {
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
  const f = await fixture({}, (store, home) => {
    notifications = createDaemonNotifications(
      home,
      store,
      (error) => errors.push(error),
      { push },
      0,
    );
    return { notifications: notifications.service };
  });
  notifications.setSender((device, notification) => f.server.notify(device, notification));
  notifications.setConnected(() => f.server.notificationDevices());
  notifications.activate();
  cleanups.push(async () => {
    await notifications.close();
    await f.close();
  });
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
  // The thread genuinely needs the person: the worker raises a needs_you alert from this.
  const raise = async () => {
    f.store.appendEvents(f.thread.id, [
      { type: "thread.updated", status: { state: "working", agents: 1 } },
      { type: "thread.updated", status: { state: "needs_you", interactions: 1 } },
    ]);
    return notifications.tick();
  };
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
  return { f, gateway, state, errors, notifications, client, phone, raise, liveFrame, delivered };
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
