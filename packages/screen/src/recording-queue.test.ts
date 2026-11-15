import { expect, test } from "vitest";
import { RecordingQueue } from "./recording-queue.ts";
import { framePacket, type Frame } from "./frames.ts";
import { frame } from "./testing/support.ts";

function accessUnit(sequence: number, keyframe = false, bytes = 8): Frame {
  const source = frame(sequence, bytes);
  const header = { ...source.header, codec: "h264" as const, keyframe };
  return { header, payload: source.payload, packet: framePacket(header, source.payload) };
}

test("an overflow preserves the admitted prefix and skips deltas even after space returns", () => {
  const queue = new RecordingQueue(accessUnit(2).packet.length);
  queue.push(accessUnit(1, true));
  expect(queue.next()?.header.sequence).toBe(1);
  queue.push(accessUnit(2));
  queue.push(accessUnit(3));
  expect(queue.next()?.header.sequence).toBe(2);
  queue.push(accessUnit(4));
  expect(queue.next()).toBeUndefined();
  queue.push(accessUnit(5, true));
  expect(queue.next()?.header.sequence).toBe(5);
  queue.push(accessUnit(6));
  expect(queue.next()?.header.sequence).toBe(6);
  expect(queue.gaps).toEqual([{ first: 3, last: 4 }]);
});

test("a keyframe that cannot fit keeps the same gap open until a fitting keyframe", () => {
  const queue = new RecordingQueue(accessUnit(1, true).packet.length);
  queue.push(accessUnit(1, true, 1000));
  queue.push(accessUnit(2, false));
  queue.push(accessUnit(3, true, 1000));
  queue.push(accessUnit(4, false));
  expect(queue.next()).toBeUndefined();
  queue.push(accessUnit(5, true));
  expect(queue.next()?.header.sequence).toBe(5);
  expect(queue.gaps).toEqual([{ first: 1, last: 4 }]);
});
