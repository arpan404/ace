import { expect, it } from "vitest";
import { deviceStreamProfile } from "./stream-profile.ts";

it("panel and network budgets reduce pixels and bitrate under pressure with JPEG fallback", () => {
  const small = deviceStreamProfile({ width: 350, height: 650 }, "local", true);
  expect(small.maxWidth).toBe(384);
  expect(small.maxHeight).toBe(704);
  expect(small.fps).toBe(60);
  const large = deviceStreamProfile({ width: 3000, height: 4000 }, "local", true);
  const relay = deviceStreamProfile({ width: 3000, height: 4000 }, "relay", true);
  const slow = deviceStreamProfile({ width: 3000, height: 4000 }, "relay", false, 2);
  expect(relay.maxWidth).toBeLessThan(large.maxWidth);
  expect(relay.bitrate).toBeLessThan(large.bitrate);
  expect(relay.fps).toBe(30);
  expect(slow.maxWidth).toBeLessThan(relay.maxWidth);
  expect(slow.bitrate).toBeLessThan(relay.bitrate);
  expect(slow.codec).toBe("jpeg");
});

it("local decode pressure drops cadence without lowering the viewer's pixel density", () => {
  const panel = { width: 1051, height: 1951 };
  const stream = deviceStreamProfile(panel, "local", true, 3);
  expect(stream.maxWidth).toBe(1088);
  expect(stream.maxHeight).toBe(1984);
  expect(stream.fps).toBe(30);
  expect(stream.codec).toBe("h264");
});

it("a portrait viewer at DPR three keeps its full physical height", () => {
  expect(deviceStreamProfile({ width: 1440, height: 3300 }, "local", true)).toMatchObject({
    codec: "h264",
    maxWidth: 1472,
    maxHeight: 3328,
    fps: 60,
  });
});

it("small panel resizes keep the same capture budget until the next size bucket", () => {
  expect(deviceStreamProfile({ width: 390, height: 844 }, "local", true)).toEqual(
    deviceStreamProfile({ width: 400, height: 850 }, "local", true),
  );
});
