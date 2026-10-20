import { expect, it } from "vitest";
import { encodePicture, streamKinds } from "@ace/browser/stream";
import { DeviceClient, type DeviceTransportEvents } from "./client.ts";
import type { DeviceClientMessage } from "@ace/protocol/devices";

function setup() {
  let id = 0;
  let events: DeviceTransportEvents | undefined;
  const sent: DeviceClientMessage[] = [];
  const client = new DeviceClient({
    id: () => `image_${id++}`,
    schedule: () => () => {},
  });
  client.connect({
    open(next) {
      events = next;
      next.ready();
    },
    send(message) {
      if (message.type === "devices.request") sent.push(message);
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
  sequence: 5,
  timestamp: 10,
  width: 100,
  height: 200,
  scale: 1,
  rotation: 0,
  codec: "jpeg",
  key: true,
  streamId: "snapshot",
} as const;
const result = { streamId: "snapshot", sequence: 5, width: 100, height: 200, bytes: 1 };
let ids = 0;
/** The daemon's still picture for a screenshot (or a live one), as its stream pieces. */
const picture = (byte: number, options: { still?: boolean; sequence?: number } = {}) =>
  encodePicture(
    streamKinds.deviceFrame,
    ++ids,
    deviceId,
    {
      ...header,
      sequence: options.sequence ?? header.sequence,
      ...(options.still === false ? {} : { still: true as const }),
    },
    new Uint8Array([byte]),
  );

it("a screenshot resolves with the still picture its result names, without a subscription", async () => {
  const host = setup();
  const shot = host.client.screenshot(deviceId);
  const sent = host.sent[0];
  if (!sent) throw new Error("Missing screenshot request");
  for (const piece of picture(5)) host.receive(piece);
  host.receive({ type: "devices.result", requestId: sent.requestId, ok: true, data: result });
  const image = await shot;
  expect([...image.bytes]).toEqual([5]);
  expect(image).toMatchObject({ sourceId: deviceId, width: 100, height: 200, still: true });
  expect(host.sent.map((message) => message.operation.op)).toEqual(["screenshot"]);
  host.client.disconnect();
});

it("a screenshot's still never reaches the live view, which only draws paced pictures", async () => {
  const host = setup();
  const drawn: number[] = [];
  host.client.watchPictures(deviceId, async (next) => void drawn.push(next.bytes[0] ?? -1));
  const shot = host.client.screenshot(deviceId);
  const sent = host.sent[0];
  if (!sent) throw new Error("Missing screenshot request");
  for (const piece of picture(5)) host.receive(piece);
  for (const piece of picture(6, { still: false, sequence: 6 })) host.receive(piece);
  host.receive({ type: "devices.result", requestId: sent.requestId, ok: true, data: result });
  expect([...(await shot).bytes]).toEqual([5]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(drawn).toEqual([6]);
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

it("rejects a screenshot result whose still picture never arrived", async () => {
  const host = setup();
  const shot = host.client.screenshot(deviceId);
  const sent = host.sent[0];
  if (!sent) throw new Error("Missing request");
  // A live picture with the same sequence is not the screenshot.
  for (const piece of picture(5, { still: false })) host.receive(piece);
  host.receive({ type: "devices.result", requestId: sent.requestId, ok: true, data: result });
  await expect(shot).rejects.toThrow("Screenshot pixels missing");
  host.client.disconnect();
});

it("concurrent screenshots of the same unchanged image both get its pixels", async () => {
  const host = setup();
  const first = host.client.screenshot(deviceId);
  const second = host.client.screenshot(deviceId);
  for (const piece of picture(5)) host.receive(piece);
  for (const piece of picture(5)) host.receive(piece);
  for (const sent of host.sent)
    host.receive({ type: "devices.result", requestId: sent.requestId, ok: true, data: result });
  const images = await Promise.all([first, second]);
  expect(images.map((image) => [...image.bytes])).toEqual([[5], [5]]);
  host.client.disconnect();
});
