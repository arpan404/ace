import { expect, it } from "vitest";
import { ScrcpyVideoUnits, type VideoUnit } from "./scrcpy-video.ts";

const nal = (...bytes: number[]) => Buffer.from([0, 0, 0, 1, ...bytes]);
const config = Buffer.concat([nal(0x67, 0x42, 0xc0, 0x29, 0x8d), nal(0x68, 0xce)]);
function units() {
  const emitted: VideoUnit[] = [];
  const sizes: [number, number][] = [];
  const reader = new ScrcpyVideoUnits(
    (unit) => emitted.push(unit),
    (width, height) => sizes.push([width, height]),
  );
  return { reader, emitted, sizes };
}

it("every keyframe carries the stream's parameter sets and codec, so a viewer can join there", () => {
  const { reader, emitted } = units();
  reader.push({ type: "codec", id: 0x68323634 });
  reader.push({ type: "session", width: 576, height: 1280 });
  reader.push({ type: "packet", config: true, keyframe: false, pts: 0n, payload: config });
  reader.push({ type: "packet", config: false, keyframe: true, pts: 1n, payload: nal(0x65, 1) });
  reader.push({ type: "packet", config: false, keyframe: false, pts: 2n, payload: nal(0x41, 2) });
  expect(emitted.map((unit) => [unit.keyframe, unit.videoCodec, unit.width, unit.height])).toEqual([
    [true, "avc1.42C029", 576, 1280],
    [false, "avc1.42C029", 576, 1280],
  ]);
  expect(emitted[0]?.payload).toEqual(Buffer.concat([config, nal(0x65, 1)]));
  expect(emitted[1]?.payload).toEqual(nal(0x41, 2));
});

it("after rotation, deltas wait for the new session's configuration and keyframe", () => {
  const { reader, emitted, sizes } = units();
  reader.push({ type: "codec", id: 0x68323634 });
  reader.push({ type: "session", width: 576, height: 1280 });
  reader.push({ type: "packet", config: true, keyframe: false, pts: 0n, payload: config });
  reader.push({ type: "packet", config: false, keyframe: true, pts: 1n, payload: nal(0x65) });
  reader.push({ type: "session", width: 1280, height: 576 });
  reader.push({ type: "packet", config: false, keyframe: false, pts: 2n, payload: nal(0x41) });
  reader.push({ type: "packet", config: true, keyframe: false, pts: 3n, payload: config });
  reader.push({ type: "packet", config: false, keyframe: true, pts: 4n, payload: nal(0x65) });
  expect(sizes).toEqual([
    [576, 1280],
    [1280, 576],
  ]);
  expect(emitted.map((unit) => [unit.keyframe, unit.width])).toEqual([
    [true, 576],
    [true, 1280],
  ]);
});

it("a stream in any codec other than H.264 is refused rather than shown as garbage", () => {
  const { reader } = units();
  expect(() => reader.push({ type: "codec", id: 0x68323635 })).toThrow("unsupported video codec");
});
