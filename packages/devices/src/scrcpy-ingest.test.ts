import { expect, it } from "vitest";
import { scrcpyFrame } from "./scrcpy-capture.ts";
import type { VideoUnit } from "./scrcpy-video.ts";

const unit = (width: number, height: number): VideoUnit => ({
  payload: Buffer.from([0, 0, 0, 1, 0x65, 1]),
  keyframe: true,
  videoCodec: "avc1.42E01F",
  width,
  height,
  pts: 1_000_000n,
});

it("a downscaled scrcpy unit still depicts its native display size", () => {
  // A 1080x2400 display encoded at 540x1200: the frame is 540 wide, but it depicts the 1080
  // points input uses, at scale 1.
  const frame = scrcpyFrame(unit(540, 1200), { width: 1080, height: 2400 }, 7);
  expect(frame.width).toBe(540);
  expect(frame.displayWidth).toBe(1080);
  expect(frame.displayHeight).toBe(2400);
  expect(frame.scale).toBe(1000);
});
