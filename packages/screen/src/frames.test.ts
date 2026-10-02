import { expect, it } from "vitest";
import { FrameDecoder, FrameHub, type Frame } from "./index.ts";
import { deferred, frame } from "./testing/support.ts";
it("decodes arbitrary fragments and consecutive frames without changing payloads", () => {
  const output: Frame[] = [];
  const decoder = new FrameDecoder((value) => output.push(value));
  const packets = Buffer.concat([frame(1).packet, frame(2, 2048).packet]);
  for (let i = 0; i < packets.length; i += 7) decoder.push(packets.subarray(i, i + 7));
  decoder.end();
  expect(output.map((value) => value.header.sequence)).toEqual([1, 2]);
  expect(output[1]?.payload).toEqual(frame(2, 2048).payload);
  expect(output[0]?.packet).toEqual(frame(1).packet);
});
it("rejects oversized headers, oversized payloads and truncated frames", () => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(4097);
  expect(() => makeDecoder().push(length)).toThrow("limit");
  const json = Buffer.from(JSON.stringify({ ...frame(1).header, bytes: 8 * 1024 * 1024 + 1 }));
  length.writeUInt32BE(json.length);
  expect(() => makeDecoder().push(Buffer.concat([length, json]))).toThrow();
  const partial = makeDecoder();
  partial.push(frame(1).packet.subarray(0, -1));
  expect(() => partial.end()).toThrow("Truncated");
});
it("slow subscribers get the newest frame and fast subscribers keep receiving", async () => {
  const hub = new FrameHub();
  const gate = deferred<void>();
  const started = deferred<void>();
  const latest = deferred<void>();
  const slow: number[] = [];
  const fast: number[] = [];
  hub.subscribe(async (value) => {
    slow.push(value.header.sequence);
    if (value.header.sequence === 1) {
      started.resolve();
      await gate.promise;
    } else latest.resolve();
  });
  hub.subscribe(async (value) => {
    fast.push(value.header.sequence);
  });
  hub.publish(frame(1));
  await started.promise;
  for (let i = 2; i <= 100; i++) hub.publish(frame(i));
  gate.resolve();
  await latest.promise;
  expect(slow).toEqual([1, 100]);
  expect(fast.at(-1)).toBe(100);
});
it("unsubscribe discards queued frames and a failed subscriber does not block other viewers", async () => {
  const hub = new FrameHub();
  const gate = deferred<void>();
  const started = deferred<void>();
  const delivered = deferred<void>();
  const received: number[] = [];
  const stop = hub.subscribe(async (value) => {
    received.push(value.header.sequence);
    started.resolve();
    await gate.promise;
  });
  hub.subscribe(async () => {
    throw new Error("gone");
  });
  hub.publish(frame(1));
  await started.promise;
  hub.publish(frame(2));
  stop();
  gate.resolve();
  hub.subscribe(async () => {
    delivered.resolve();
  });
  hub.publish(frame(3));
  await delivered.promise;
  // Drain the queued promise chain, then offer another frame to expose retained viewers.
  await new Promise<void>((resolve) => setImmediate(resolve));
  hub.publish(frame(4));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(received).toEqual([1]);
});

function makeDecoder() {
  return new FrameDecoder(() => {});
}

it("a new viewer gets its initial frame without replaying it to existing viewers", async () => {
  const hub = new FrameHub();
  const received: number[] = [];
  const first = deferred<void>();
  const second = deferred<void>();
  hub.subscribe(async (value) => {
    received.push(value.header.sequence);
    first.resolve();
  });
  hub.publish(frame(1));
  await first.promise;
  hub.subscribe(async () => {
    second.resolve();
  }, frame(1));
  await second.promise;
  expect(received).toEqual([1]);
});
it("subscriber limits reject excess viewers and free a slot on unsubscribe", () => {
  const hub = new FrameHub();
  const stops = Array.from({ length: 64 }, () => hub.subscribe(async () => {}));
  expect(() => hub.subscribe(async () => {})).toThrow("limit");
  stops[0]?.();
  expect(() => hub.subscribe(async () => {})).not.toThrow();
  hub.clear();
});
