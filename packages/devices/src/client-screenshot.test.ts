import { expect, it } from "vitest";
import { framePacket } from "@ace/screen";
import { DeviceClient, type DeviceTransportEvents } from "./client.ts";
import type { DeviceClientMessage } from "@ace/protocol/devices";

function setup() {
  let id = 0;
  let events: DeviceTransportEvents | undefined;
  const sent: DeviceClientMessage[] = [];
  const deadlines = new Set<() => void>();
  const client = new DeviceClient({
    id: () => `image_${id++}`,
    schedule(callback) {
      deadlines.add(callback);
      return () => {
        deadlines.delete(callback);
      };
    },
  });
  client.connect({
    open(next) {
      events = next;
      next.ready();
    },
    send(message) {
      sent.push(message);
    },
    close() {},
  });
  return {
    client,
    sent,
    receive(data: unknown) {
      events?.message(data);
    },
  };
}
const deviceId = "android:Pixel";
const header = {
  version: 2,
  sessionId: "snapshot",
  seq: 5,
  ts: 10,
  width: 100,
  height: 200,
  scale: 1,
  codec: "jpeg",
  bytes: 1,
} as const;

it("renders screenshot pixels preceding metadata before device state is loaded", async () => {
  const host = setup();
  let draw: (value: number) => void = () => {
    throw new Error(`Missing draw promise ${host.sent.length}`);
  };
  const drawn = new Promise<number>((resolve) => {
    draw = resolve;
  });
  host.client.watchFrames(deviceId, async (frame) => {
    draw(frame.payload[0] ?? -1);
  });
  const request = host.client.request({ op: "screenshot", deviceId });
  const sent = host.sent[0];
  if (!sent) throw new Error("Missing screenshot request");
  host.receive(framePacket(header, Buffer.from([5])));
  host.receive({ type: "devices.result", requestId: sent.requestId, ok: true, data: header });
  expect(await drawn).toBe(5);
  await expect(request).resolves.toEqual(header);
  expect(host.sent.map((message) => message.operation.op)).toEqual(["screenshot"]);
  host.client.disconnect();
});

it("renders a screenshot without requiring a stream subscription", async () => {
  const host = setup();
  host.receive({
    type: "devices.state",
    state: {
      device: { id: deviceId, platform: "android", name: "Pixel", state: "booted" },
      enabled: true,
      approved: false,
      lifecycle: "live",
      streamId: "snapshot",
      controller: "none",
    },
  });
  let draw: (value: number) => void = () => {
    throw new Error(`Missing draw promise ${host.sent.length}`);
  };
  const drawn = new Promise<number>((resolve) => {
    draw = resolve;
  });
  host.client.watchFrames(deviceId, async (frame) => {
    draw(frame.payload[0] ?? -1);
  });
  const request = host.client.request({ op: "screenshot", deviceId });
  const sent = host.sent[0];
  if (!sent) throw new Error("Missing screenshot request");
  host.receive(framePacket(header, Buffer.from([5])));
  host.receive({ type: "devices.result", requestId: sent.requestId, ok: true, data: header });
  expect(await drawn).toBe(5);
  await request;
  expect(host.sent.map((message) => message.operation.op)).toEqual(["screenshot"]);
  host.client.disconnect();
});

it("bounds unsettled screenshots separately from ordinary device requests", async () => {
  const host = setup();
  const pending = Array.from({ length: 4 }, () =>
    host.client.request({ op: "screenshot", deviceId }).catch((error: unknown) => error),
  );
  await expect(host.client.request({ op: "screenshot", deviceId })).rejects.toMatchObject({
    code: "limit",
  });
  expect(host.sent).toHaveLength(4);
  host.client.disconnect();
  for (const error of await Promise.all(pending))
    expect(error).toMatchObject({ code: "disconnected" });
});
