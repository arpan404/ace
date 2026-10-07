import { expect, it } from "vitest";
import sharp from "sharp";
import { InteractionMeasurement } from "@ace/protocol";
import { measurementFilmstrip, MeasurementFrames } from "./measurement-filmstrip.ts";

const jpeg = async (background: string) =>
  sharp({ create: { width: 4, height: 4, channels: 3, background } })
    .jpeg()
    .toBuffer();
const incoming = (data: Buffer) => ({
  sessionId: 1,
  data: data.toString("base64"),
  metadata: { deviceWidth: 4, deviceHeight: 4 },
});

it("includes the settled keyframe when before, response and hitch pairs fill the grid", async () => {
  const blue = await sharp({ create: { width: 400, height: 250, channels: 3, background: "blue" } })
    .jpeg()
    .toBuffer();
  const red = await sharp({ create: { width: 400, height: 250, channels: 3, background: "red" } })
    .jpeg()
    .toBuffer();
  const candidates = Array.from({ length: 16 }, (_, index) => ({
    atMs: (index - 1) * 100,
    data: (index === 15 ? red : blue).toString("base64"),
  }));
  const measurement = InteractionMeasurement.parse({
    source: "browser-trace",
    target: { kind: "browser-tab", threadId: "thread" },
    windowMs: 1400,
    refreshHz: 60,
    latencyMs: 100,
    settleMs: 1400,
    frames: 60,
    hitches: [
      { atMs: 200, durationMs: 100 },
      { atMs: 400, durationMs: 100 },
    ],
    verdict: "janky",
    confidence: "high",
    notes: [],
  });
  const strip = await measurementFilmstrip(candidates, measurement);
  expect(strip).toBeDefined();
  const pixel = await sharp(Buffer.from(strip?.data ?? "", "base64"))
    .extract({ left: 1400, top: 400, width: 1, height: 1 })
    .raw()
    .toBuffer();
  expect(pixel[0]).toBeGreaterThan(200);
  expect(pixel[2]).toBeLessThan(50);
});

it("filmstrip timing excludes setup images while preserving the before image", async () => {
  const before = await jpeg("blue"),
    setup = await jpeg("red"),
    response = await jpeg("green");
  let now = 0;
  const frames = new MeasurementFrames(1000, () => now);
  frames.seed(before);
  now = 100;
  frames.accept(incoming(setup));
  now = 250;
  frames.begin();
  now = 260;
  frames.accept(incoming(response));
  expect(frames.candidates()).toEqual([
    { atMs: 0, data: before.toString("base64") },
    { atMs: 10, data: response.toString("base64") },
  ]);
});
