import { describe, expect, it } from "vitest";
import type { MediaRoute, SourcePicture } from "@ace/browser/live-view";
import type { StreamMessage } from "@ace/browser/stream";
import type { MediaStreamClientMessage } from "@ace/protocol";
import type { DeviceAck, DeviceClientMessage } from "@ace/protocol/devices";
import { DeviceClient, type DeviceTransportEvents } from "./client.ts";

/* A device's live stream while its media binding changes: nothing old steers or reaches the new. */

const deviceId = "android:Pixel_9";

const frame = (sequence: number): StreamMessage => ({
  kind: "device.frame",
  sourceId: deviceId,
  frame: {
    sequence,
    timestamp: sequence,
    width: 100,
    height: 200,
    scale: 2,
    rotation: 0,
    codec: "hvc1.1.6.L153.B0",
    key: true,
    streamId: "stream_1",
    bytes: Uint8Array.of(0, 0, 0, 1, 0x40),
  },
});

type Subscribe = Extract<DeviceClientMessage, { type: "devices.request" }>;

function setup(draw?: (picture: SourcePicture) => Promise<void>) {
  const subscribes: Subscribe[] = [];
  const channelAcks: DeviceAck[] = [];
  let events: DeviceTransportEvents | undefined;
  let ids = 0;
  const client = new DeviceClient({ id: () => `request_${ids++}`, schedule: () => () => {} });
  client.connect({
    open(next) {
      events = next;
      next.ready();
    },
    send(message) {
      if (message.type === "devices.ack") return void channelAcks.push(message);
      if (message.operation.op === "subscribe") subscribes.push(message);
    },
    close() {},
  });
  let connection: string | undefined = "mc_aaaaaaaaaa";
  const watchers = new Set<() => void>();
  const streams = new Set<(message: StreamMessage) => void>();
  const mediaAcks: { on: string; message: MediaStreamClientMessage }[] = [];
  const route: MediaRoute = {
    binding: () => (connection ? { connection } : undefined),
    codecs: () => ["hvc1.1.6.L153.B0", "avc1.42E033"],
    watch: (listener) => {
      watchers.add(listener);
      return () => void watchers.delete(listener);
    },
    onStream: (listener) => {
      streams.add(listener);
      return () => void streams.delete(listener);
    },
    ack: (message) => {
      if (!connection) return false;
      mediaAcks.push({ on: connection, message });
      return true;
    },
  };
  client.useMedia(route);
  const drawn: SourcePicture[] = [];
  client.watchPictures(deviceId, async (picture) => {
    drawn.push(picture);
    await draw?.(picture);
  });
  const reply = (subscribe: Subscribe) => {
    const named = subscribe.operation.op === "subscribe" ? subscribe.operation.media : undefined;
    events?.message({
      type: "devices.result",
      requestId: subscribe.requestId,
      ok: true,
      ...(named ? { media: { connection: named.connection } } : {}),
    });
  };
  return {
    client,
    subscribes,
    channelAcks,
    mediaAcks,
    drawn,
    reply,
    move(next: string | undefined) {
      connection = next;
      for (const watcher of watchers) watcher();
    },
    deliver(message: StreamMessage) {
      for (const listener of streams) listener(message);
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe("device pictures across a media rebind", () => {
  it("the old subscribe's late reply leaves the new subscribe's delivery alone", async () => {
    const view = setup();
    view.client.retainStream(deviceId);
    view.move("mc_bbbbbbbbbb");
    const [first, second] = view.subscribes;
    view.reply(first!);
    view.reply(second!);
    await flush();
    view.deliver(frame(1));
    await flush();
    view.client.ack(view.drawn[0]!);
    expect(view.mediaAcks.map((ack) => ack.on)).toEqual(["mc_bbbbbbbbbb"]);
    expect(view.channelAcks).toEqual([]);
  });

  it("a picture from the old connection is neither drawn after the rebind nor acked through the new one", async () => {
    let release: (() => void) | undefined;
    const view = setup(
      (picture) =>
        new Promise<void>((done) => {
          if (picture.sequence === 1) release = done;
          else done();
        }),
    );
    view.client.retainStream(deviceId);
    view.reply(view.subscribes[0]!);
    await flush();
    view.deliver(frame(1));
    view.deliver(frame(2));
    await flush();
    view.move("mc_bbbbbbbbbb");
    view.reply(view.subscribes[1]!);
    await flush();
    release?.();
    await flush();
    view.client.ack(view.drawn[0]!);
    expect(view.drawn.map((picture) => picture.sequence)).toEqual([1]);
    expect(view.mediaAcks).toEqual([]);
    expect(view.channelAcks).toEqual([]);
    expect(view.client.current(view.drawn[0]!)).toBe(false);
  });
});
