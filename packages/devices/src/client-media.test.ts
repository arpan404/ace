import { describe, expect, it } from "vitest";
import type { MediaRoute } from "@ace/browser/live-view";
import { streamKinds, type StreamMessage } from "@ace/browser/stream";
import { encodePicture } from "@ace/browser/stream-encode";
import type { MediaStreamClientMessage } from "@ace/protocol";
import type { DeviceAck, DeviceClientMessage } from "@ace/protocol/devices";
import { DeviceClient, type DeviceTransportEvents } from "./client.ts";

const deviceId = "android:Pixel_9";
const device = { id: deviceId, platform: "android", name: "Pixel", state: "booted" } as const;

const hevcFrame = (sequence: number) => ({
  sequence,
  timestamp: sequence,
  width: 100,
  height: 200,
  scale: 2,
  rotation: 0 as const,
  codec: "hvc1.1.6.L153.B0",
  key: true,
  streamId: "stream_1",
});
const hevc = (sequence: number): StreamMessage => ({
  kind: "device.frame",
  sourceId: deviceId,
  frame: { ...hevcFrame(sequence), bytes: Uint8Array.of(0, 0, 0, 1, 0x40) },
});

/** How the daemon answers a subscribe naming a connection. */
type Daemon = "binds" | "refuses" | "answers later";

function setup(initial: string | undefined, daemon: Daemon = "binds") {
  const sent: DeviceClientMessage[] = [];
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
      sent.push(message);
      if (message.operation.op !== "subscribe" || daemon === "answers later") return;
      const named = message.operation.media;
      const { requestId } = message;
      queueMicrotask(() =>
        events?.message(
          named && daemon === "refuses"
            ? {
                type: "devices.result",
                requestId,
                ok: false,
                error: {
                  code: "command_failed",
                  message: "media-connection: that media connection isn't this session's",
                  hint: "",
                },
              }
            : {
                type: "devices.result",
                requestId,
                ok: true,
                ...(named ? { media: { connection: named.connection } } : {}),
              },
        ),
      );
    },
    close() {},
  });
  let connection = initial;
  const watchers = new Set<() => void>();
  const streams = new Set<(message: StreamMessage) => void>();
  const mediaAcks: MediaStreamClientMessage[] = [];
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
      mediaAcks.push(message);
      return true;
    },
  };
  client.useMedia(route);
  const move = (next: string | undefined) => {
    connection = next;
    for (const watcher of watchers) watcher();
  };
  const deliver = (message: StreamMessage) => {
    for (const listener of streams) listener(message);
  };
  const receive = (message: unknown) => events?.message(message);
  const subscribes = () =>
    sent.flatMap((message) =>
      message.type === "devices.request" && message.operation.op === "subscribe"
        ? [message.operation]
        : [],
    );
  return { client, sent, channelAcks, mediaAcks, move, deliver, receive, subscribes };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("device pictures by the media connection", () => {
  it("subscribes on the media connection, draws its HEVC pictures and acks there", async () => {
    const { client, mediaAcks, channelAcks, deliver, subscribes } = setup("mc_aaaaaaaaaa");
    const drawn: number[] = [];
    client.watchPictures(deviceId, async (picture) => {
      drawn.push(picture.sequence);
      client.ack(picture);
    });
    client.retainStream(deviceId);
    await flush();
    expect(subscribes()).toEqual([
      {
        op: "subscribe",
        deviceId,
        media: { connection: "mc_aaaaaaaaaa" },
        codecs: ["hvc1.1.6.L153.B0", "avc1.42E033"],
      },
    ]);
    deliver(hevc(1));
    await flush();
    expect(drawn).toEqual([1]);
    expect(mediaAcks).toEqual([
      { type: "devices.ack", deviceId, streamId: "stream_1", sequence: 1 },
    ]);
    expect(channelAcks).toEqual([]);
  });

  it("subscribes again with the new connection after a reconnect", () => {
    const { client, move, subscribes } = setup("mc_aaaaaaaaaa");
    client.retainStream(deviceId);
    move("mc_bbbbbbbbbb");
    expect(subscribes().map((s) => s.media)).toEqual([
      { connection: "mc_aaaaaaaaaa" },
      { connection: "mc_bbbbbbbbbb" },
    ]);
  });

  it("without a binding, subscribes naming none, and says why instead of drawing pictures", async () => {
    const { client, subscribes } = setup(undefined);
    const states: unknown[] = [];
    client.watchDeliveries((state) => states.push(state));
    client.retainStream(deviceId);
    await flush();
    expect(subscribes()).toEqual([{ op: "subscribe", deviceId }]);
    expect(states.at(-1)).toMatchObject({
      path: "none",
      undelivered: { code: "connecting", reason: "Connecting to live video…" },
    });
  });

  it("a connection the daemon refuses isn't named again for the device, which says why", async () => {
    const { client, subscribes } = setup("mc_aaaaaaaaaa", "refuses");
    const states: unknown[] = [];
    client.watchDeliveries((state) => states.push(state));
    client.retainStream(deviceId);
    await flush();
    // No subscribe on the channel: only ace-media delivers (X3). It is tried again later.
    expect(subscribes().map((s) => s.media)).toEqual([{ connection: "mc_aaaaaaaaaa" }]);
    expect(states.at(-1)).toMatchObject({ path: "none", undelivered: { code: "failed" } });
  });

  it("a live picture on the channel, from an older daemon, never reaches the view", async () => {
    const { client, receive } = setup("mc_aaaaaaaaaa");
    const drawn: number[] = [];
    client.watchPictures(deviceId, async (picture) => void drawn.push(picture.sequence));
    client.retainStream(deviceId);
    await flush();
    receive(
      encodePicture(
        streamKinds.deviceFrame,
        1,
        deviceId,
        { ...hevcFrame(1), codec: "avc1.42E033" },
        Uint8Array.of(1),
      )[0],
    );
    await flush();
    expect(drawn).toEqual([]);
  });

  it("a viewer that can't decode HEVC moves only its own device to H.264", async () => {
    const { client, subscribes } = setup("mc_aaaaaaaaaa");
    client.retainStream(deviceId);
    client.retainStream("android:Other_Phone");
    await flush();
    expect(client.fallBack(deviceId, "hvc1.1.6.L153.B0")).toBe(true);
    await flush();
    const after = subscribes().slice(2);
    expect(after).toEqual([
      {
        op: "subscribe",
        deviceId,
        media: { connection: "mc_aaaaaaaaaa" },
        codecs: ["avc1.42E033"],
      },
    ]);
  });

  it("keeps the poster its media subscribe brings back", () => {
    const { client, sent, receive } = setup("mc_aaaaaaaaaa", "answers later");
    receive({
      type: "devices.state",
      state: { device, enabled: true, lifecycle: "live", streamId: "s", controller: "none" },
    });
    client.retainStream(deviceId);
    const request = sent.at(-1);
    const poster = { width: 100, height: 200, jpeg: "/9j/AA==" };
    receive({
      type: "devices.result",
      requestId: request?.requestId,
      ok: true,
      media: { connection: "mc_aaaaaaaaaa", poster },
    });
    expect(client.poster(deviceId)).toEqual(poster);
  });
});
