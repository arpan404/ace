import { expect, it } from "vitest";
import { simulatorEncodeSpec } from "./simulator-transcode.ts";

it("ace-media re-encodes a Simulator inside the viewer's box at its aspect, never above native, with even sides", () => {
  const native = { width: 1206, height: 2622 };
  expect(
    simulatorEncodeSpec(native, { maxWidth: 800, maxHeight: 1280, bitrate: 3_000_000 }),
  ).toEqual({ id: 1, codec: "avc1.640033", width: 588, height: 1280, fps: 60, bitrate: 3_000_000 });
  expect(
    simulatorEncodeSpec(native, { maxWidth: 4000, maxHeight: 4000, bitrate: 1 }),
  ).toMatchObject({
    width: 1206,
    height: 2622,
  });
  expect(simulatorEncodeSpec(native, { maxWidth: 301, maxHeight: 4000, bitrate: 1 })).toMatchObject(
    {
      width: 300,
      height: 654,
    },
  );
});
