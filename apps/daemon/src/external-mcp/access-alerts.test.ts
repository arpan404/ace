import { expect, test } from "vitest";
import type { DeliveryResult } from "@ace/notify";
import {
  DeviceId,
  type Device,
  type NotificationDevice,
  type PushAccessAlert,
} from "@ace/protocol";
import { alertAccessRequests } from "./access-alerts.ts";
import { AccessRequests } from "./access-requests.ts";

const now = 1_000_000;
const phone = (id: string): NotificationDevice => ({
  id: DeviceId.parse(id),
  address: {
    channel: "push",
    platform: "phone",
    token: "ab".repeat(32),
    environment: "sandbox",
    p256dh: "B".repeat(87),
    auth: "A".repeat(22),
  },
  preferences: { quietHours: null, includePreview: false },
});
const paired = (id: string, scopes: Device["scopes"], extra: Partial<Device> = {}): Device => ({
  id: DeviceId.parse(id),
  name: id,
  scopes,
  createdAt: 0,
  lastSeenAt: 0,
  revokedAt: null,
  ...extra,
});

/** Timers the test fires by hand, and sends it can hold open. */
function harness(
  devices: Device[],
  reply: () => DeliveryResult | Promise<DeliveryResult> = () => "accepted",
) {
  const timers = new Set<() => void>();
  const after = (_ms: number, run: () => void) => {
    timers.add(run);
    return () => void timers.delete(run);
  };
  let next = 0;
  const requests = new AccessRequests({
    now: () => now,
    id: () => `request-${++next}`,
    random: (size) => Buffer.alloc(size, 3),
    // The request's own ten minutes never run out here.
    after: () => () => {},
  });
  const sent: { device: string; alert: PushAccessAlert }[] = [];
  const asked: string[][] = [];
  let addressGate: Promise<void> = Promise.resolve();
  const stop = alertAccessRequests(requests, {
    devices: () => devices,
    now: () => now,
    async addresses(ids) {
      asked.push([...ids]);
      await addressGate;
      // The notification store knows push addresses for every one of these phones.
      return ids.map((id) => phone(id));
    },
    async send(device, alert) {
      sent.push({ device: device.id, alert });
      return reply();
    },
    after,
    report: (error) => {
      throw error;
    },
  });
  const fireTimers = async () => {
    for (const run of Array.from(timers)) {
      timers.delete(run);
      run();
    }
    await settle();
  };
  const hold = () => {
    const gate = Promise.withResolvers<void>();
    addressGate = gate.promise;
    return gate.resolve;
  };
  return { requests, sent, asked, stop, fireTimers, hold };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const ask = {
  clientName: "Claude",
  domain: "claude.ai",
  scopes: ["threads:read"] as const,
  redirectHost: "claude.ai",
  redirectKind: "web" as const,
};

test("a new sign-in request is pushed once to each admin phone and to nobody else", async () => {
  const { requests, sent, asked } = harness([
    paired("admin-phone", ["read", "operate", "admin"]),
    paired("viewer-phone", ["read"]),
    paired("operator-phone", ["read", "operate"]),
    paired("revoked-admin", ["admin"], { revokedAt: 5 }),
    paired("lapsed-admin", ["admin"], { expiresAt: now - 1 }),
  ]);
  const { request } = requests.open({ ...ask, scopes: [...ask.scopes] });
  await settle();
  // Another request opening re-announces the list; the first is not pushed again.
  requests.open({ ...ask, clientName: "Bot", scopes: [...ask.scopes] });
  await settle();
  expect(asked).toEqual([["admin-phone"], ["admin-phone"]]);
  expect(sent.map(({ device, alert }) => [device, alert.requestId])).toEqual([
    ["admin-phone", request.requestId],
    ["admin-phone", "request-2"],
  ]);
});

test("the push names who asks and the match code, and nothing that signs anyone in", async () => {
  const { requests, sent } = harness([paired("admin-phone", ["admin"])]);
  const { request } = requests.open({
    clientName: "Claude",
    domain: null,
    scopes: ["threads:read", "computer"],
    redirectHost: "127.0.0.1",
    redirectKind: "this-device",
  });
  await settle();
  expect(sent[0]?.alert).toEqual({
    requestId: request.requestId,
    clientName: "Claude",
    domain: null,
    matchCode: request.matchCode,
    expiresAt: request.expiresAt,
  });
});

test("a request decided before its push leaves sends nothing", async () => {
  const { requests, sent, hold } = harness([paired("admin-phone", ["admin"])]);
  const release = hold();
  const { request } = requests.open({ ...ask, scopes: [...ask.scopes] });
  await settle();
  requests.decide(request.requestId, { decision: "deny" }, "desktop");
  release();
  await settle();
  expect(sent).toEqual([]);
});

test("a push the gateway asked to retry stops retrying once the request is answered", async () => {
  const { requests, sent, fireTimers } = harness([paired("admin-phone", ["admin"])], () => "retry");
  const { request } = requests.open({ ...ask, scopes: [...ask.scopes] });
  await settle();
  expect(sent).toHaveLength(1);
  await fireTimers();
  expect(sent).toHaveLength(2);
  requests.decide(
    request.requestId,
    { decision: "approve", scopes: ["threads:read"], projects: "all", expiresAt: null },
    "admin-phone",
  );
  await fireTimers();
  await fireTimers();
  expect(sent).toHaveLength(2);
});

test("a machine with no admin phone asks the notification store nothing", async () => {
  const { requests, sent, asked } = harness([paired("viewer-phone", ["read", "operate"])]);
  requests.open({ ...ask, scopes: [...ask.scopes] });
  await settle();
  expect(asked).toEqual([]);
  expect(sent).toEqual([]);
});
