import { expect, it, onTestFinished } from "vitest";
import type { DeviceServerMessage } from "@ace/protocol/devices";
import { DevicePlatform, DevicesService, reserveDevices } from "./index.ts";

const person = { kind: "human", owner: "window-1" } as const;

function devicesService(options: { boot?: (authorize?: () => void) => Promise<void> } = {}) {
  const platform = new DevicePlatform({ platform: "linux", home: "/unused", env: {} });
  platform.list = async () => [
    { id: "android:Pixel", platform: "android", name: "Pixel", state: "booted" },
  ];
  if (options.boot)
    platform.boot = (_device, authorize) => options.boot?.(authorize) ?? Promise.resolve();
  const service = new DevicesService({
    platform,
    env: {},
    recordingDirectory: "/unused",
    publishArtifact: async () => {},
    runtime: {
      now: () => 0,
      id: () => "device",
      after: () => () => {},
      spawn() {
        throw new Error("No native effect expected");
      },
    },
  });
  onTestFinished(() => service.close());
  return service;
}

/** A second window's channel, opened before its socket has been welcomed. */
function reserved(service: DevicesService, options: { authorize?: () => boolean } = {}) {
  const sent: DeviceServerMessage[] = [];
  const channel = reserveDevices(service, "window-2", {
    authorize: options.authorize ?? (() => true),
    canReadThread: () => true,
    agentExists: () => true,
    async send(message) {
      sent.push(message);
    },
    media: { bufferedBytes: () => 0, async write() {} },
  });
  onTestFinished(() => channel.close());
  return { channel, sent };
}

it("a channel waiting for its welcome says nothing, then the current state, then the change it missed", async () => {
  const service = devicesService();
  const { channel, sent } = reserved(service);

  await service.request({ op: "enable", enabled: false }, person);
  expect(sent).toEqual([]);

  channel.activate();
  await Promise.resolve();
  expect(sent).toEqual([
    { type: "devices.enabled", enabled: false },
    { type: "devices.enabled", enabled: false },
  ]);

  await service.request({ op: "enable", enabled: true }, person);
  expect(sent.at(-1)).toEqual({ type: "devices.enabled", enabled: true });
});

it("turning devices off and back on before the welcome leaves the window reading them as on", async () => {
  const service = devicesService();
  const { channel, sent } = reserved(service);

  await service.request({ op: "enable", enabled: false }, person);
  await service.request({ op: "enable", enabled: true }, person);
  channel.activate();
  await Promise.resolve();

  expect(sent.at(0)).toEqual({ type: "devices.enabled", enabled: true });
  expect(sent.at(-1)).toEqual({ type: "devices.enabled", enabled: true });
});

it("a boot that outlives its devices channel still boots the device, and only its reply is dropped", async () => {
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let booted = false;
  const service = devicesService({
    boot: async (authorize) => {
      started.resolve();
      await finish.promise;
      // The check a long action makes after its work, while the view has already unmounted.
      authorize?.();
      booted = true;
    },
  });
  const { channel, sent } = reserved(service);

  const request = channel.request({
    type: "devices.request",
    requestId: "boot-1",
    operation: { op: "boot", deviceId: "android:Pixel" },
  });
  await started.promise;
  channel.close();
  finish.resolve();

  await expect(request).resolves.toBeUndefined();
  expect(booted).toBe(true);
  expect(sent).toEqual([]);
});

it("a boot stops when the connection behind its channel is revoked", async () => {
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let authorized = true;
  let booted = false;
  const service = devicesService({
    boot: async (authorize) => {
      started.resolve();
      await finish.promise;
      authorize?.();
      booted = true;
    },
  });
  const { channel, sent } = reserved(service, { authorize: () => authorized });

  const request = channel.request({
    type: "devices.request",
    requestId: "boot-2",
    operation: { op: "boot", deviceId: "android:Pixel" },
  });
  await started.promise;
  // The socket behind the channel went away mid-boot: the work must not finish as if authorized.
  authorized = false;
  finish.resolve();

  // Its reply has nobody to go to; what matters is that the boot did not complete.
  await expect(request).resolves.toBeUndefined();
  expect(booted).toBe(false);
  expect(sent).toEqual([]);
});
