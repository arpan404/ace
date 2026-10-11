import { expect, it, onTestFinished } from "vitest";
import { WebSocket } from "ws";
import { DeviceClient, type DeviceTransportEvents } from "@ace/devices/client";
import { DevicePlatform, DevicesService } from "@ace/devices";
import { DeviceId, SocketTicket, type DeviceScope } from "@ace/protocol";
import { fixture } from "./socket-test-support.ts";

async function setup(scopes: DeviceScope[], available = true) {
  const platform = new DevicePlatform({ platform: "linux", home: "/unused", env: {} });
  platform.list = async () => [
    { id: "android:Pixel", name: "Pixel", platform: "android", state: "shutdown" },
  ];
  const devices = new DevicesService({
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
  const f = await fixture(available ? { devices } : {});
  const credential = f.store.devices.create("Viewer", scopes, 1);
  const ticketResponse = await fetch(f.server.url.replace("ws:", "http:") + "/v1/tickets", {
    method: "POST",
    headers: { Authorization: `Bearer ${credential.token}` },
  });
  const admission = SocketTicket.parse(await ticketResponse.json());
  const socket = new WebSocket(f.server.url);
  const ready = Promise.withResolvers<void>();
  let response = Promise.withResolvers<void>();
  const deadlines = new Set<() => void>();
  let serial = 0;
  let events: DeviceTransportEvents | undefined;
  const client = new DeviceClient({
    id: () => `request-${++serial}`,
    schedule(run) {
      deadlines.add(run);
      return () => {
        deadlines.delete(run);
      };
    },
  });
  client.connect({
    open(next) {
      events = next;
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
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "welcome"
        ) {
          next.ready();
          ready.resolve();
        } else {
          next.message(message);
          if (
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            (message.type === "devices.result" || message.type === "error")
          )
            response.resolve();
        }
      });
      socket.on("close", () => events?.close());
    },
    send(message) {
      socket.send(JSON.stringify(message));
    },
    close() {
      socket.close();
    },
  });
  onTestFinished(async () => {
    client.disconnect();
    if (socket.readyState !== WebSocket.CLOSED)
      await new Promise<void>((resolve) => socket.once("close", resolve));
    await f.close();
    await devices.close();
  });
  socket.on("error", ready.reject);
  socket.once("close", () => ready.reject(new Error("Authentication closed before welcome")));
  await ready.promise;
  return {
    client,
    devices,
    deadlines,
    reply: () => response.promise,
    nextReply() {
      response = Promise.withResolvers<void>();
    },
  };
}

it.each(["read", "operate"] as const)(
  "%s device channels explain administrator refusals without timing out or enabling devices",
  async (scope) => {
    const f = await setup([scope]);
    for (const operation of [
      { op: "inventory.watch", watching: true },
      { op: "enable", enabled: true },
    ] as const) {
      const outcome = f.client.request(operation).then(
        () => "unexpected success",
        (error: unknown) => error,
      );
      await f.reply();
      expect(await Promise.race([outcome, Promise.resolve("still pending")])).toMatchObject({
        code: "permission_denied",
        message: expect.stringMatching(/admin/i),
        hint: expect.stringMatching(/admin/i),
      });
      expect(f.deadlines.size).toBe(0);
      expect(f.devices.isEnabled()).toBe(false);
      expect(f.client.getSnapshot().connected).toBe(true);
      f.nextReply();
    }
  },
);

it("an administrator loads and enables devices on the same daemon/client boundary", async () => {
  const f = await setup(["admin"]);
  expect(await f.client.request({ op: "inventory.watch", watching: true })).toEqual({
    watching: true,
  });
  expect(await f.client.request({ op: "list" })).toMatchObject({
    devices: [{ id: "android:Pixel", name: "Pixel" }],
  });
  expect(await f.client.request({ op: "enable", enabled: true })).toEqual({ enabled: true });
  expect(f.devices.isEnabled()).toBe(true);
});

it("an unavailable devices service returns a correlated explanation immediately", async () => {
  const f = await setup(["admin"], false);
  const outcome = f.client.request({ op: "list" }).then(
    () => "unexpected success",
    (error: unknown) => error,
  );
  await f.reply();
  expect(await Promise.race([outcome, Promise.resolve("still pending")])).toMatchObject({
    code: "not_supported",
    message: expect.stringMatching(/unavailable/i),
  });
  expect(f.deadlines.size).toBe(0);
});
