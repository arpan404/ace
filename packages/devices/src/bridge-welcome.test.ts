import { expect, it, onTestFinished } from "vitest";
import type { DeviceServerMessage } from "@ace/protocol/devices";
import { DevicePlatform, DevicesService, reserveDevices } from "./index.ts";

const person = { kind: "human", owner: "window-1" } as const;

function devicesService() {
  const platform = new DevicePlatform({ platform: "linux", home: "/unused", env: {} });
  platform.list = async () => [];
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
function reserved(service: DevicesService) {
  const sent: DeviceServerMessage[] = [];
  const channel = reserveDevices(service, "window-2", {
    authorize: () => true,
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
