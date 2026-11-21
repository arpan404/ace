import { describe, expect, it } from "vitest";
import type { MediaRoute } from "@ace/browser/live-view";
import {
  decodeStreamMessage,
  StreamAssembler,
  streamKinds,
  type StreamMessage,
} from "@ace/browser/stream";
import { encodePicture } from "@ace/browser/stream-encode";
import { devicePoint } from "@ace/ui-core";
import { DeviceClient, type DeviceTransport, type DeviceTransportEvents } from "./client.ts";
import type { DeviceAck, DeviceClientMessage, DeviceState } from "@ace/protocol/devices";

const deviceId = "android:Pixel_9";
const device = { id: deviceId, platform: "android", name: "Pixel", state: "booted" } as const;
function state(streamId = "stream_1"): DeviceState {
  return {
    device,
    enabled: true,
    lifecycle: "live",
    streamId,
    controller: "none",
  };
}
/** A device's live JPEG picture as its stream pieces. */
function frame(sequence: number, streamId = "stream_1"): Uint8Array[] {
  return encodePicture(
    streamKinds.deviceFrame,
    sequence,
    deviceId,
    {
      sequence,
      timestamp: 10,
      width: 100,
      height: 200,
      scale: 2,
      rotation: 0,
      codec: "jpeg",
      key: true,
      streamId,
    },
    new Uint8Array([sequence]),
  );
}
const encodeDeviceFrame = (
  id: number,
  source: string,
  chunk: Parameters<typeof encodePicture>[3],
  bytes: Uint8Array,
) => encodePicture(streamKinds.deviceFrame, id, source, chunk, bytes);
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error(`Uninitialized promise ${typeof promise}`);
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  let sequence = 0;
  const deadlines = new Set<() => void>();
  const sent: DeviceClientMessage[] = [];
  const acks: DeviceAck[] = [];
  let events: DeviceTransportEvents | undefined;
  const connection = "mc_aaaaaaaaaa";
  const transport: DeviceTransport = {
    open(next) {
      events = next;
      next.ready();
    },
    send(message) {
      if (message.type === "devices.ack") return void acks.push(message);
      sent.push(message);
      // ace-media delivers every subscribe that names the media connection (X3).
      if (message.operation.op === "subscribe" && message.operation.media) {
        const { requestId } = message;
        queueMicrotask(() =>
          events?.message({ type: "devices.result", requestId, ok: true, media: { connection } }),
        );
      }
    },
    close() {},
  };
  const streams = new Set<(message: StreamMessage) => void>();
  const route: MediaRoute = {
    binding: () => ({ connection }),
    codecs: () => ["avc1.42E033"],
    watch: () => () => {},
    onStream: (listener) => {
      streams.add(listener);
      return () => void streams.delete(listener);
    },
    ack: (message) => {
      if (message.type === "devices.ack") acks.push(message);
      return true;
    },
  };
  const assembler = new StreamAssembler();
  /** Pieces on the media connection, as ace-media sends them. */
  const deliver = (pieces: Uint8Array[]) => {
    for (const piece of pieces) {
      const envelope = assembler.push(piece);
      const message = envelope && decodeStreamMessage(envelope);
      if (message) for (const listener of streams) listener(message);
    }
  };
  const client = new DeviceClient({
    id: () => `request_${sequence++}`,
    schedule(callback) {
      deadlines.add(callback);
      return () => {
        deadlines.delete(callback);
      };
    },
  });
  client.connect(transport);
  client.useMedia(route);
  /** A watched device whose subscribe ace-media delivers. */
  const live = async () => {
    client.retainStream(deviceId);
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
  };
  const receive = (message: unknown) => {
    if (!events) throw new Error("Transport not open");
    if (Array.isArray(message)) for (const piece of message) events.message(piece);
    else events.message(message);
  };
  const result = (index: number, data: unknown) => {
    const message = sent[index];
    if (!message) throw new Error("Request not sent");
    receive({ type: "devices.result", requestId: message.requestId, ok: true, data });
  };
  return {
    client,
    transport,
    sent,
    acks,
    receive,
    result,
    deadlines,
    deliver,
    live,
    events: () => events,
  };
}

describe("portable device clients", () => {
  it("maps scaled simulator images to logical input coordinates and clamps their edges", () => {
    const header = {
      version: 2,
      sessionId: "image",
      seq: 1,
      ts: 0,
      width: 100,
      height: 200,
      scale: 2,
      codec: "jpeg",
      bytes: 1,
    } as const;
    const bounds = { left: 10, top: 20, width: 200, height: 400 };
    expect(devicePoint(header, bounds, { x: 110, y: 220 })).toEqual({ x: 25, y: 50 });
    expect(devicePoint(header, bounds, { x: 500, y: -100 })).toEqual({ x: 49, y: 0 });
    expect(devicePoint(header, { ...bounds, width: 0 }, { x: 10, y: 20 })).toBeUndefined();
  });

  it("accepts inventory larger than the bounded active session registry", async () => {
    const host = setup();
    const devices = Array.from({ length: 33 }, (_, index) => ({
      ...device,
      id: `android:Pixel_${index}`,
    }));
    const request = host.client.request({ op: "list" });
    host.result(0, { devices });
    await request;
    expect(host.client.getSnapshot().devices).toHaveLength(33);
    expect(host.client.getSnapshot().connected).toBe(true);
    host.client.disconnect();
  });

  it("publishes validated device inventory and live controller state", async () => {
    const host = setup();
    const list = host.client.request({ op: "list" });
    host.result(0, { devices: [device] });
    await list;
    host.receive(
      JSON.stringify({
        type: "devices.state",
        state: { ...state(), controller: "human", leaseExpiresAt: 30000 },
      }),
    );
    expect(host.client.getSnapshot().devices.map((entry) => entry.name)).toEqual(["Pixel"]);
    expect(host.client.getSnapshot().states[0]?.controller).toBe("human");
    host.client.disconnect();
  });

  it("keeps discovered devices available alongside missing SDK diagnostics", async () => {
    const host = setup();
    const issue = {
      code: "sdk_missing",
      message: "Android SDK is missing",
      hint: "Set ANDROID_HOME",
    } as const;
    const request = host.client.request({ op: "list" });
    host.result(0, { devices: [device], issues: [issue] });
    await request;
    expect(host.client.getSnapshot()).toMatchObject({
      connected: true,
      devices: [device],
      issues: [issue],
    });
    host.client.disconnect();
  });

  it("a busy view gets every paced picture in order once it is free", async () => {
    const host = setup();
    host.receive({ type: "devices.state", state: state() });
    const first = deferred<void>();
    const unblock = deferred<void>();
    const latest = deferred<void>();
    const drawn: number[] = [];
    host.client.watchPictures(deviceId, async (image) => {
      drawn.push(image.bytes[0] ?? -1);
      if (drawn.length === 1) {
        first.resolve();
        await unblock.promise;
      } else latest.resolve();
    });
    await host.live();
    host.deliver(frame(1));
    await first.promise;
    host.deliver(frame(2));
    host.deliver(frame(3));
    expect(drawn).toEqual([1]);
    unblock.resolve();
    await latest.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    // ace-media's ack window paces pictures, so the view loses none of them.
    expect(drawn).toEqual([1, 2, 3]);
    host.client.disconnect();
  });

  it("keeps other viewers receiving after one viewer unmounts", async () => {
    const host = setup();
    host.receive({ type: "devices.state", state: state() });
    const removed = host.client.watchPictures(deviceId, async () => {
      throw new Error("Unmounted viewer invoked");
    });
    const drawn = deferred<number>();
    host.client.watchPictures(deviceId, async (image) => {
      drawn.resolve(image.bytes[0] ?? -1);
    });
    removed();
    await host.live();
    host.deliver(frame(9));
    expect(await drawn.promise).toBe(9);
    host.client.disconnect();
  });

  it("disconnect clears state and rejects input without replaying it on reconnect", async () => {
    const host = setup();
    host.receive({ type: "devices.state", state: state() });
    const input = host.client.request({
      op: "input",
      deviceId,
      input: { kind: "tap", x: 2, y: 3 },
    });
    const outcome = expect(input).rejects.toMatchObject({ code: "disconnected" });
    const oldEvents = host.events();
    host.client.disconnect();
    await outcome;
    expect(host.client.getSnapshot()).toMatchObject({ connected: false, devices: [], states: [] });
    host.client.connect(host.transport);
    oldEvents?.message({ type: "devices.state", state: state("stale") });
    expect(host.client.getSnapshot().states).toEqual([]);
    expect(host.sent.map((message) => message.operation.op)).toEqual(["input"]);
    host.client.disconnect();
  });

  it("drops a queued old frame across disconnect even when the renderer is still busy", async () => {
    const host = setup();
    host.receive({ type: "devices.state", state: state() });
    const started = deferred<void>();
    const unblock = deferred<void>();
    const resumed = deferred<void>();
    const drawn: number[] = [];
    host.client.watchPictures(deviceId, async (image) => {
      drawn.push(image.bytes[0] ?? -1);
      if (drawn.length === 1) {
        started.resolve();
        await unblock.promise;
      } else resumed.resolve();
    });
    await host.live();
    host.deliver(frame(1));
    await started.promise;
    host.deliver(frame(2));
    host.client.disconnect();
    host.client.connect(host.transport);
    host.receive({ type: "devices.state", state: state() });
    await host.live();
    host.deliver(frame(4));
    unblock.resolve();
    await resumed.promise;
    expect(drawn).toEqual([1, 4]);
    host.client.disconnect();
  });

  it("caps unsettled requests and releases their slots on injected deadlines", async () => {
    const host = setup();
    const waiting = Array.from({ length: 32 }, () =>
      host.client.request({ op: "list" }).catch((error: unknown) => error),
    );
    await expect(host.client.request({ op: "list" })).rejects.toMatchObject({ code: "limit" });
    expect(host.sent).toHaveLength(32);
    for (const timeout of host.deadlines) timeout();
    const errors = await Promise.all(waiting);
    for (const error of errors) expect(error).toMatchObject({ code: "timeout" });
    const next = host.client.request({ op: "list" });
    host.result(32, { devices: [device] });
    await expect(next).resolves.toEqual({ devices: [device] });
    host.client.disconnect();
  });

  it("preserves typed host failures and fix hints without losing the connection", async () => {
    const host = setup();
    const pending = host.client.request({ op: "boot", deviceId });
    const sent = host.sent[0];
    if (!sent) throw new Error("Missing request");
    host.receive({
      type: "devices.result",
      requestId: sent.requestId,
      ok: false,
      error: { code: "sdk_missing", message: "Android SDK missing", hint: "Set ANDROID_HOME" },
    });
    await expect(pending).rejects.toMatchObject({ code: "sdk_missing", hint: "Set ANDROID_HOME" });
    expect(host.client.getSnapshot().connected).toBe(true);
    host.client.disconnect();
  });

  it("a binary message that is not a stream piece ends the connection", () => {
    const host = setup();
    host.receive({ type: "devices.state", state: state() });
    const json = new TextEncoder().encode(JSON.stringify({ sessionId: "stream_1", bytes: 1 }));
    const packet = new Uint8Array(4 + json.length + 1);
    new DataView(packet.buffer).setUint32(0, json.length);
    packet.set(json, 4);
    host.receive(packet);
    expect(host.client.getSnapshot()).toMatchObject({
      connected: false,
      error: { code: "invalid_data" },
    });
  });

  it("routes bounded log batches only to the selected device", () => {
    const host = setup();
    const batches: string[][] = [];
    host.client.watchLogs(deviceId, (batch) => batches.push(batch.lines));
    host.receive({
      type: "devices.logs",
      deviceId: "android:Other",
      sequence: 1,
      lines: ["Other log"],
      dropped: 0,
    });
    host.receive({
      type: "devices.logs",
      deviceId,
      sequence: 2,
      lines: ["Selected log"],
      dropped: 20,
    });
    expect(batches).toEqual([["Selected log"]]);
    host.receive({
      type: "devices.logs",
      deviceId,
      sequence: 3,
      lines: Array.from({ length: 65 }, () => "excess"),
      dropped: 0,
    });
    expect(batches).toEqual([["Selected log"]]);
    expect(host.client.getSnapshot().connected).toBe(false);
  });
});

it("the inventory stays loading until a successful reply and resets on reconnect", async () => {
  const host = setup();
  expect(host.client.getSnapshot().inventoryLoaded).toBe(false);
  const reading = host.client.request({ op: "list" });
  expect(host.client.getSnapshot().inventoryLoaded).toBe(false);
  host.result(0, { devices: [device] });
  await reading;
  expect(host.client.getSnapshot()).toMatchObject({ inventoryLoaded: true, devices: [device] });
  host.client.disconnect();
  expect(host.client.getSnapshot().inventoryLoaded).toBe(false);
});

it("a mounted viewer subscribes to replacement capture after the device moves to a thread", () => {
  const host = setup();
  host.receive({ type: "devices.state", state: state() });
  const release = host.client.retainStream(deviceId);
  host.receive({ type: "devices.state", state: { ...state(), lifecycle: "stopping" } });
  host.receive({
    type: "devices.state",
    state: { ...state("stream_2"), threadId: "thread-1" },
  });
  const named = { op: "subscribe", deviceId, media: { connection: "mc_aaaaaaaaaa" } };
  expect(host.sent.map((message) => message.operation)).toMatchObject([named, named]);
  release();
  host.client.disconnect();
});

it("pictures on the media connection reach the view in order, and its acks there name their capture", async () => {
  const host = setup();
  host.receive({ type: "devices.state", state: state() });
  await host.live();
  const drawn: { sequence: number; codec: string; rotation: number }[] = [];
  const shown = deferred<void>();
  host.client.watchPictures(deviceId, async (picture) => {
    drawn.push(picture);
    host.client.ack(picture);
    if (drawn.length === 3) shown.resolve();
  });
  const picture = (sequence: number, key: boolean, size = 10) =>
    encodeDeviceFrame(
      sequence,
      deviceId,
      {
        sequence,
        timestamp: sequence,
        width: 1080,
        height: 2400,
        scale: 0.5,
        rotation: sequence === 3 ? 90 : 0,
        codec: "avc1.640028",
        key,
        streamId: "stream_1",
      },
      new Uint8Array(size).fill(sequence),
    );
  // A keyframe bigger than one binary message, then deltas.
  host.deliver([...picture(1, true, 200_000), ...picture(2, false), ...picture(3, false)]);
  await shown.promise;
  expect(drawn.map(({ sequence, codec, rotation }) => ({ sequence, codec, rotation }))).toEqual([
    { sequence: 1, codec: "avc1.640028", rotation: 0 },
    { sequence: 2, codec: "avc1.640028", rotation: 0 },
    { sequence: 3, codec: "avc1.640028", rotation: 90 },
  ]);
  expect(host.acks).toEqual(
    [1, 2, 3].map((sequence) => ({
      type: "devices.ack",
      deviceId,
      streamId: "stream_1",
      sequence,
    })),
  );
  expect(host.client.getSnapshot().connected).toBe(true);
  host.client.disconnect();
});
