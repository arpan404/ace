import { setTimeout as settle } from "node:timers/promises";
import { DeviceId } from "@ace/protocol";
import type { ActivityAddress, ActivityRegistration, LiveActivityTarget } from "@ace/notify";
import { expect, it } from "vitest";
import {
  createLiveActivityRegistrar,
  type LiveActivityGateway,
  type LiveActivityTokens,
} from "./notification-live-activity.ts";

const now = 1_800_000_000_000;
const token = "a1".repeat(32);
const phone = DeviceId.parse("phone");
const target: LiveActivityTarget = {
  token,
  environment: "sandbox",
  kind: "start",
  frequentUpdates: true,
  slot: 2,
  devices: [phone],
};
function fixture(
  options: {
    authorize?: (devices: readonly DeviceId[]) => boolean;
    register?: (address: ActivityAddress) => Promise<ActivityRegistration> | undefined;
    stored?: LiveActivityTarget[];
    cleanupFailed?: () => void;
  } = {},
) {
  const stored = [...(options.stored ?? [target])];
  const dropped: string[] = [];
  const registrationCalls: string[] = [];
  const forgets: string[] = [];
  let failClear = false;
  const tokens: LiveActivityTokens = {
    async sync() {},
    async targets() {
      return [...stored];
    },
    async clear() {
      if (failClear) throw new Error("worker unavailable");
      stored.length = 0;
    },
    async drop(address) {
      dropped.push(address.token);
      const index = stored.findIndex((entry) => entry.token === address.token);
      if (index >= 0) stored.splice(index, 1);
    },
  };
  const gateway: LiveActivityGateway = {
    async registerActivity(address) {
      registrationCalls.push(address.token === token ? address.kind : address.token);
      return (
        options.register?.(address) ?? {
          status: "registered",
          handle: "handle",
          expiresAt: now + 30 * 24 * 60 * 60_000,
        }
      );
    },
    forgetActivity(address) {
      forgets.push(address.kind);
    },
  };
  let origin = "http://127.0.0.1:1";
  const registrar = createLiveActivityRegistrar({
    tokens,
    gateway,
    target: async () => ({ enabled: true, origin }),
    ...(options.authorize ? { authorize: options.authorize } : {}),
    ...(options.cleanupFailed ? { cleanupFailed: options.cleanupFailed } : {}),
    now: () => now,
    signal: new AbortController().signal,
    report: () => {},
    delay: () => () => {},
  });
  return {
    registrar,
    stored,
    dropped,
    registrationCalls,
    forgets,
    setFailClear(value: boolean) {
      failClear = value;
    },
    setOrigin(next: string) {
      origin = next;
    },
  };
}

it("a cleanup the worker refused stays pending and runs before anything registers", async () => {
  const f = fixture();
  f.setFailClear(true);
  await expect(f.registrar.clear()).rejects.toThrow("worker unavailable");
  expect(await f.registrar.targets()).toEqual([]);
  await expect(f.registrar.resume()).rejects.toThrow("worker unavailable");
  expect(f.registrationCalls).toEqual([]);

  f.setFailClear(false);
  await f.registrar.resume();
  expect(f.stored).toEqual([]);
  expect(f.registrationCalls).toEqual([]);
});

it("a device being unregistered is hidden until its cleanup is confirmed", async () => {
  const f = fixture();
  await f.registrar.resume();
  await settle(0);
  expect(f.registrationCalls).toEqual(["start"]);

  f.registrar.fenceDevice(phone);
  expect(await f.registrar.targets()).toEqual([]);
  await f.registrar.resume();
  await settle(0);
  expect(f.registrationCalls).toEqual(["start"]);

  f.registrar.clearFence(phone);
  await f.registrar.resume();
  await settle(0);
  expect(await f.registrar.targets()).toEqual([target]);
  // The fenced handle was forgotten, so the token is registered again rather than reused.
  expect(f.registrationCalls).toEqual(["start", "start"]);
});

it("a pairing that lapsed while the daemon was down is dropped, not registered", async () => {
  const f = fixture({ authorize: () => false });
  await f.registrar.resume();
  expect(f.dropped).toEqual([token]);
  expect(f.registrationCalls).toEqual([]);
  expect(await f.registrar.targets()).toEqual([]);
});

it("a cleanup the worker refused asks the retry lane to replay it", async () => {
  let retries = 0;
  const f = fixture({ cleanupFailed: () => retries++ });
  f.setFailClear(true);
  await expect(f.registrar.clear()).rejects.toThrow("worker unavailable");
  expect(retries).toBe(1);

  f.setFailClear(false);
  await f.registrar.resume();
  expect(f.stored).toEqual([]);
  expect(retries).toBe(1);
});

it("one phone's lapsed pairing does not keep another phone's token from registering", async () => {
  const lapsedPhone = DeviceId.parse("old-phone");
  const otherToken = "b2".repeat(32);
  const lapsed: LiveActivityTarget = { ...target, token: otherToken, devices: [lapsedPhone] };
  const f = fixture({
    stored: [lapsed, target],
    authorize: (devices) => !devices.includes(lapsedPhone),
  });
  await f.registrar.resume();
  await settle(0);
  expect(f.registrationCalls).toEqual(["start"]);
  expect(f.dropped).toEqual([otherToken]);
  expect(await f.registrar.targets()).toEqual([target]);
});

it("two syncs while one registration is in flight start only one", async () => {
  const pending = Promise.withResolvers<ActivityRegistration>();
  const f = fixture({ register: () => pending.promise });
  const first = f.registrar.resume();
  await settle(0);
  const second = f.registrar.resume();
  await settle(0);
  expect(f.registrationCalls).toEqual(["start"]);
  pending.resolve({ status: "registered", handle: "handle", expiresAt: now + 86_400_000 });
  await Promise.all([first, second]);
});

it("a late 410 from the gateway the daemon already left does not delete the token", async () => {
  const pending = Promise.withResolvers<ActivityRegistration>();
  const f = fixture({ register: () => pending.promise });
  void f.registrar.resume();
  await settle(0);
  f.setOrigin("http://127.0.0.1:2");
  pending.resolve({ status: "gone" });
  await settle(0);
  expect(f.dropped).toEqual([]);
  expect(f.stored).toEqual([target]);
});
