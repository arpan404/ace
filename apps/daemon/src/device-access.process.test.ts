import { expect, it, onTestFinished } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevicesService, DevicePlatform } from "@ace/devices";
import { ScreenManager, framePacket } from "@ace/screen";
import { spawnRawSupervised } from "@ace/provider-kit/process";
import { Command, DeviceOperation } from "@ace/protocol";
import { Store } from "./store.ts";
import { createDevThread } from "./commands.ts";
import { ScreenGrants } from "./screen-grants.ts";
import { ScreenApprovals } from "./screen-approvals.ts";
import { requestDeviceAccess } from "./device-access.ts";

const deviceId = "ios:11111111-1111-4111-8111-111111111111";
const human = { kind: "human", owner: "human" } as const;
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "ace-device-access-"));
  const store = new Store(join(home, "events.sqlite"));
  const thread = createDevThread(store, store.createWorkspace(home, "Devices", 1000));
  const caller = { threadId: thread.id, agentId: "agent" };
  const grants = new ScreenGrants(
    store,
    () => 1000,
    () => "turn",
  );
  let serial = 0;
  const approvals = new ScreenApprovals({
    store,
    grants,
    now: () => 1000,
    id: () => `approval-${++serial}`,
    engine: () => undefined,
    schedule: () => () => {},
  });
  const screen = new ScreenManager({
    command: process.execPath,
    platform: "darwin",
    nextId: () => `screen-${++serial}`,
    recordingDirectory: home,
    publishArtifact: async () => {},
  });
  screen.configureAccess({
    enabled: () => grants.enabled(),
    enable: (enabled) => grants.enable(enabled),
    list: (threadId) => grants.list(threadId),
    allows: (bundleId, scope) => grants.allows(bundleId, scope),
    approve: (bundleId, allowed, scope, threadId) =>
      grants.approve(bundleId, allowed, scope, threadId),
    request: (bundleId, reason, scope, signal) =>
      approvals.request(bundleId, reason, scope, signal),
    foreground: (state, reason, signal) => approvals.foreground(state, signal, reason),
    audit() {},
  });
  const platform = new DevicePlatform({ platform: "darwin", home, env: {} });
  let inventory: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  const inventoryEntered = Promise.withResolvers<void>();
  platform.list = async () => {
    if (inventory) {
      inventoryEntered.resolve();
      await inventory.promise;
    }
    return [{ id: deviceId, name: "iPhone", platform: "ios", state: "booted" }];
  };
  let cleanup: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  const cleanupEntered = Promise.withResolvers<void>();
  const devices = new DevicesService({
    platform,
    screen,
    env: {},
    recordingDirectory: home,
    publishArtifact: async () => {},
    runtime: {
      now: () => 1000,
      id: () => `device-${++serial}`,
      spawn: spawnRawSupervised,
      after: () => () => {},
    },
    async capture(options) {
      const child = spawnRawSupervised({
        command: process.execPath,
        args: ["-e", "process.stdin.resume()"],
        env: {},
        name: "device-access-native",
      });
      const payload = Buffer.from("frame");
      const header = {
        version: 1 as const,
        sessionId: options.streamId,
        sequence: 0,
        timestamp: 1000,
        width: 100,
        height: 200,
        codec: "jpeg" as const,
        bytes: payload.length,
      };
      options.publish({ header, payload, packet: framePacket(header, payload) });
      return {
        async stop() {
          cleanupEntered.resolve();
          await cleanup?.promise;
          await child.stop({ graceMs: 0 });
        },
      };
    },
  });
  onTestFinished(async () => {
    inventory?.resolve();
    cleanup?.resolve();
    await devices.close();
    await screen.close();
    approvals.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  });
  const request = (operation: unknown) => devices.request(DeviceOperation.parse(operation), human);
  const allow = async () => {
    // The durable interaction is the public approval result observed by the UI.
    await expect
      .poll(() =>
        Object.values(store.snapshotThread(thread.id).interactions).some(
          (row) => row.state === "pending",
        ),
      )
      .toBe(true);
    const pending = Object.values(store.snapshotThread(thread.id).interactions).find(
      (row) => row.state === "pending",
    );
    if (!pending) throw new Error("Missing approval");
    approvals.resolve(
      Command.parse({
        id: `resolve-${++serial}`,
        deviceId: "human",
        payload: {
          type: "interaction.resolve",
          interactionId: pending.id,
          resolution: { kind: "approval", optionId: "allow_thread" },
        },
      }),
    );
  };
  return {
    devices,
    grants,
    caller,
    approvals,
    request,
    allow,
    inventoryEntered,
    cleanupEntered,
    holdInventory() {
      inventory = Promise.withResolvers<void>();
      return inventory;
    },
    holdCleanup() {
      cleanup = Promise.withResolvers<void>();
      return cleanup;
    },
  };
}

it("cancelling allowed device access during inventory leaves devices off and no Simulator grant", async () => {
  const h = await fixture();
  const controller = new AbortController();
  const pending = requestDeviceAccess(
    h.devices,
    h.approvals,
    deviceId,
    h.caller,
    controller.signal,
  );
  const rejected = expect(pending).rejects.toThrow();
  await expect.poll(() => h.devices.isEnabled()).toBe(false);
  // First inventory found the approval target. Hold session discovery after Allow.
  const lookup = h.holdInventory();
  await h.allow();
  await h.inventoryEntered.promise;
  controller.abort();
  lookup.resolve();
  await rejected;
  expect(h.devices.isEnabled()).toBe(false);
  expect(h.devices.approvedThread(deviceId)).toBeUndefined();
  expect(h.grants.allowlist(h.caller)).not.toContain("com.apple.iphonesimulator");
  expect(h.devices.states().every((state) => state.controller === "none")).toBe(true);
});

it("cancelling allowed device access during native cleanup creates no thread or Simulator grant", async () => {
  const h = await fixture();
  await h.request({ op: "enable", enabled: true });
  await h.request({ op: "start", deviceId, fps: 10 });
  const cleanup = h.holdCleanup();
  const controller = new AbortController();
  const pending = requestDeviceAccess(
    h.devices,
    h.approvals,
    deviceId,
    h.caller,
    controller.signal,
  );
  const rejected = expect(pending).rejects.toThrow();
  await h.allow();
  await h.cleanupEntered.promise;
  controller.abort();
  cleanup.resolve();
  await rejected;
  expect(h.devices.isEnabled()).toBe(true);
  expect(h.devices.approvedThread(deviceId)).toBeUndefined();
  expect(h.grants.allowlist(h.caller)).not.toContain("com.apple.iphonesimulator");
  expect(h.devices.states()[0]?.controller).toBe("none");
});

it.each([false, true])(
  "cancelled transaction enablement respects a later explicit human enable: %s",
  async (independentEnable) => {
    const h = await fixture();
    const controller = new AbortController();
    let humanEnable: Promise<unknown> | undefined;
    const unwatch = h.devices.watchEnabled((enabled) => {
      if (!enabled) return;
      if (independentEnable) humanEnable = h.request({ op: "enable", enabled: true });
      controller.abort();
    });
    const pending = requestDeviceAccess(
      h.devices,
      h.approvals,
      deviceId,
      h.caller,
      controller.signal,
    );
    const rejected = expect(pending).rejects.toThrow();
    await h.allow();
    await rejected;
    await humanEnable;
    unwatch();
    expect(h.devices.isEnabled()).toBe(independentEnable);
    expect(h.devices.approvedThread(deviceId)).toBeUndefined();
    expect(h.grants.allowlist(h.caller)).not.toContain("com.apple.iphonesimulator");
  },
);

it("cancellation after approval commits rolls back the new grant and delegation", async () => {
  const h = await fixture();
  const controller = new AbortController();
  const unwatch = h.devices.watch((state) => {
    if (state.approved) controller.abort();
  });
  const pending = requestDeviceAccess(
    h.devices,
    h.approvals,
    deviceId,
    h.caller,
    controller.signal,
  );
  const rejected = expect(pending).rejects.toThrow();
  await h.allow();
  await rejected;
  unwatch();
  expect(h.devices.isEnabled()).toBe(false);
  expect(h.devices.approvedThread(deviceId)).toBeUndefined();
  expect(h.grants.allowlist(h.caller)).not.toContain("com.apple.iphonesimulator");
  expect(h.devices.states().every((state) => state.controller === "none")).toBe(true);
});

it("a later human approval survives completion of an older cancelled inventory lookup", async () => {
  const h = await fixture();
  const controller = new AbortController();
  const pending = requestDeviceAccess(
    h.devices,
    h.approvals,
    deviceId,
    h.caller,
    controller.signal,
  );
  const rejected = expect(pending).rejects.toThrow();
  const lookup = h.holdInventory();
  await h.allow();
  await h.inventoryEntered.promise;
  controller.abort();
  await h.request({ op: "enable", enabled: true });
  const humanApproval = h.request({
    op: "approve",
    deviceId,
    threadId: h.caller.threadId,
    allowed: true,
  });
  lookup.resolve();
  await Promise.all([rejected, humanApproval]);
  expect(h.devices.isEnabled()).toBe(true);
  expect(h.devices.approvedThread(deviceId)).toBe(h.caller.threadId);
  expect(h.grants.allowlist(h.caller)).toContain("com.apple.iphonesimulator");
});
