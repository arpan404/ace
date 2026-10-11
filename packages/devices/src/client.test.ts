import { describe, expect, it } from "vitest";
import { framePacket } from "@ace/screen";
import { devicePoint } from "@ace/ui-core";
import { ScreenFrameReader } from "@ace/screen/frames-client";
import { DeviceClient, type DeviceTransport, type DeviceTransportEvents } from "./client.ts";
import type { DeviceClientMessage, DeviceState } from "@ace/protocol/devices";

const deviceId = "android:Pixel_9";
const device = { id: deviceId, platform: "android", name: "Pixel", state: "booted" } as const;
function state(streamId = "stream_1"): DeviceState {
  return {
    device,
    enabled: true,
    approved: false,
    lifecycle: "live",
    streamId,
    controller: "none",
  };
}
function frame(sequence: number, sessionId = "stream_1", version: 1 | 2 = 1): Uint8Array {
  const payload = Buffer.from([sequence]);
  const shared = {
    sessionId,
    width: 100,
    height: 200,
    codec: "jpeg",
    bytes: payload.length,
  } as const;
  return framePacket(
    version === 1
      ? { ...shared, version, sequence, timestamp: 10 }
      : { ...shared, version, seq: sequence, ts: 10, scale: 2 },
    payload,
  );
}
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
  let events: DeviceTransportEvents | undefined;
  const transport: DeviceTransport = {
    open(next) {
      events = next;
      next.ready();
    },
    send(message) {
      sent.push(message);
    },
    close() {},
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
  const receive = (message: unknown) => {
    if (!events) throw new Error("Transport not open");
    events.message(message);
  };
  const result = (index: number, data: unknown) => {
    const message = sent[index];
    if (!message) throw new Error("Request not sent");
    receive({ type: "devices.result", requestId: message.requestId, ok: true, data });
  };
  return { client, transport, sent, receive, result, deadlines, events: () => events };
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

  it("renders a fragmented v2 frame using the existing screen wire format", async () => {
    const host = setup();
    host.receive({ type: "devices.state", state: state() });
    const drawn = deferred<{ width: number; payload: number[] }>();
    host.client.watchFrames(deviceId, async (image) => {
      drawn.resolve({ width: image.header.width, payload: [...image.payload] });
    });
    const packet = frame(7, "stream_1", 2);
    for (const byte of packet) host.receive(new Uint8Array([byte]));
    expect(await drawn.promise).toEqual({ width: 100, payload: [7] });
    host.client.disconnect();
  });

  it("replaces blocked renderer frames with the newest complete frame", async () => {
    const host = setup();
    host.receive({ type: "devices.state", state: state() });
    const first = deferred<void>();
    const unblock = deferred<void>();
    const latest = deferred<void>();
    const drawn: number[] = [];
    host.client.watchFrames(deviceId, async (image) => {
      drawn.push(image.payload[0] ?? -1);
      if (drawn.length === 1) {
        first.resolve();
        await unblock.promise;
      } else latest.resolve();
    });
    host.receive(frame(1));
    await first.promise;
    host.receive(frame(2));
    host.receive(frame(3));
    expect(drawn).toEqual([1]);
    unblock.resolve();
    await latest.promise;
    expect(drawn).toEqual([1, 3]);
    host.client.disconnect();
  });

  it("keeps other viewers receiving after one viewer unmounts", async () => {
    const host = setup();
    host.receive({ type: "devices.state", state: state() });
    const removed = host.client.watchFrames(deviceId, async () => {
      throw new Error("Unmounted viewer invoked");
    });
    const drawn = deferred<number>();
    host.client.watchFrames(deviceId, async (image) => {
      drawn.resolve(image.payload[0] ?? -1);
    });
    removed();
    host.receive(frame(9));
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
    host.client.watchFrames(deviceId, async (image) => {
      drawn.push(image.payload[0] ?? -1);
      if (drawn.length === 1) {
        started.resolve();
        await unblock.promise;
      } else resumed.resolve();
    });
    host.receive(frame(1));
    await started.promise;
    host.receive(frame(2));
    host.client.disconnect();
    host.client.connect(host.transport);
    host.receive({ type: "devices.state", state: state() });
    host.receive(frame(4));
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

  it("rejects an oversized payload header before allocating or rendering its image", () => {
    const host = setup();
    host.receive({ type: "devices.state", state: state() });
    const json = new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        sessionId: "stream_1",
        sequence: 0,
        timestamp: 0,
        width: 100,
        height: 200,
        codec: "jpeg",
        bytes: 8 * 1024 * 1024 + 1,
      }),
    );
    const packet = new Uint8Array(4 + json.length);
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

  it("decodes coalesced packets without consuming the next frame's prefix as pixels", () => {
    const observed: number[][] = [];
    const reader = new ScreenFrameReader((image) => observed.push([...image.payload]));
    const first = frame(5);
    const second = frame(6, "stream_1", 2);
    const combined = new Uint8Array(first.length + second.length);
    combined.set(first);
    combined.set(second, first.length);
    reader.push(combined);
    reader.end();
    expect(observed).toEqual([[5], [6]]);
  });

  it("detects truncated wire images and resumes after an explicit reset", () => {
    const payloads: number[] = [];
    const reader = new ScreenFrameReader((image) => payloads.push(image.payload[0] ?? -1));
    const packet = frame(5);
    reader.push(packet.subarray(0, packet.length - 1));
    expect(() => reader.end()).toThrow("Truncated frame");
    reader.reset();
    reader.push(frame(6));
    reader.end();
    expect(payloads).toEqual([6]);
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

it("a mounted viewer subscribes to replacement capture after an approval handoff", () => {
  const host = setup();
  host.receive({ type: "devices.state", state: state() });
  const release = host.client.retainStream(deviceId);
  host.receive({ type: "devices.state", state: { ...state(), lifecycle: "stopping" } });
  host.receive({
    type: "devices.state",
    state: { ...state("stream_2"), approved: true, threadId: "thread-1" },
  });
  expect(host.sent.map((message) => message.operation)).toEqual([
    { op: "subscribe", deviceId },
    { op: "subscribe", deviceId },
  ]);
  release();
  host.client.disconnect();
});
