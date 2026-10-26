import { expect, onTestFinished, test, vi } from "vitest";
import { WebSocket } from "ws";
import { DeviceClient } from "@ace/devices/client";
import { DevicePlatform, DevicesService } from "@ace/devices";
import { DeviceId, SocketTicket } from "@ace/protocol";
import { LazyDevices } from "./lazy-devices.ts";
import { fixture } from "./socket-test-support.ts";

function devicesService() {
  const platform = new DevicePlatform({ platform: "linux", home: "/unused", env: {} });
  platform.list = async () => [
    { id: "android:Pixel", name: "Pixel", platform: "android", state: "shutdown" },
  ];
  return new DevicesService({
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
}

/** An administrator's devices channel, as the Devices page opens it. */
async function viewer(f: Awaited<ReturnType<typeof fixture>>) {
  const credential = f.store.devices.create("Viewer", ["admin"], 1);
  const ticketResponse = await fetch(f.server.url.replace("ws:", "http:") + "/v1/tickets", {
    method: "POST",
    headers: { Authorization: `Bearer ${credential.token}` },
  });
  const admission = SocketTicket.parse(await ticketResponse.json());
  const socket = new WebSocket(f.server.url);
  const ready = Promise.withResolvers<void>();
  let serial = 0;
  const client = new DeviceClient({ id: () => `request-${++serial}`, schedule: () => () => {} });
  client.connect({
    open(events) {
      socket.on("open", () =>
        socket.send(
          JSON.stringify({
            type: "hello",
            protocolVersion: 1,
            deviceId: DeviceId.parse(credential.device.id),
            ticket: admission.ticket,
            channel: "devices",
          }),
        ),
      );
      socket.on("message", (data) => {
        const message: unknown = JSON.parse(data.toString());
        if (typeof message === "object" && message !== null && "type" in message) {
          if (message.type === "welcome") {
            events.ready();
            ready.resolve();
          } else events.message(message);
        }
      });
      socket.on("close", () => events.close());
    },
    send: (message) => socket.send(JSON.stringify(message)),
    close: () => socket.close(),
  });
  onTestFinished(async () => {
    client.disconnect();
    if (socket.readyState !== WebSocket.CLOSED)
      await new Promise<void>((resolve) => socket.once("close", resolve));
  });
  await ready.promise;
  return client;
}

test("devices load on first use, and viewers already watching hear about them", async () => {
  let builds = 0;
  const service = devicesService();
  const devices = new LazyDevices(async () => {
    builds++;
    return service;
  });
  const f = await fixture({ devices });
  onTestFinished(async () => {
    await f.close();
    await devices.close();
  });
  const watching = await viewer(f);
  const person = await viewer(f);
  // Open channels alone hold no devices code: nothing has asked for devices yet.
  expect(builds).toBe(0);
  expect(devices.isEnabled()).toBe(false);

  expect(await person.request({ op: "enable", enabled: true })).toEqual({ enabled: true });
  expect(builds).toBe(1);
  await vi.waitFor(() => expect(watching.getSnapshot().enabled).toBe(true), { timeout: 10_000 });
  expect(await watching.request({ op: "list" })).toMatchObject({
    devices: [{ id: "android:Pixel", name: "Pixel" }],
  });
  expect(builds).toBe(1);
});
