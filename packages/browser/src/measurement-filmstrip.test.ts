import { expect, it } from "vitest";
import { decodedPixels, flatJpeg, mediaBinary, testImages } from "./media-image-test-support.ts";
import { InteractionMeasurement } from "@ace/protocol";
import { measurementFilmstrip, MeasurementFrames } from "./measurement-filmstrip.ts";

/* Frames are only carried here; any bytes stand for a JPEG. */
const jpeg = async (background: string) => Buffer.from(`jpeg ${background}`);
const incoming = (data: Buffer) => ({
  sessionId: 1,
  data: data.toString("base64"),
  metadata: { deviceWidth: 4, deviceHeight: 4 },
});

it.skipIf(!mediaBinary)(
  "includes the settled keyframe when before, response and hitch pairs fill the grid",
  async () => {
    const blue = await flatJpeg(400, 250, [0, 0, 255]);
    const red = await flatJpeg(400, 250, [255, 0, 0]);
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
    const strip = await measurementFilmstrip(candidates, measurement, testImages());
    expect(strip).toBeDefined();
    const decoded = await decodedPixels(Buffer.from(strip?.data ?? "", "base64"));
    const at = (x: number, y: number) => [
      ...decoded.data.subarray((y * decoded.width + x) * 4, (y * decoded.width + x) * 4 + 3),
    ];
    expect([decoded.width, decoded.height]).toEqual([1600, 556]);
    // The last tile is the settled keyframe, red.
    const pixel = at(1400, 400);
    expect(pixel[0]).toBeGreaterThan(200);
    expect(pixel[2]).toBeLessThan(50);
    // Its caption is drawn on the label strip below it, and the strip's own ground stays dark.
    const caption = Array.from({ length: 200 }, (_, x) => at(1208 + x, 250 + 278 + 12)).filter(
      (p) => (p[0] ?? 0) > 150,
    );
    expect(caption.length).toBeGreaterThan(5);
    expect(at(1590, 550).every((c) => c < 60)).toBe(true);
  },
);

it("without ace-media there is no filmstrip, and nothing fails", async () => {
  const measurement = InteractionMeasurement.parse({
    source: "browser-trace",
    target: { kind: "browser-tab", threadId: "thread" },
    windowMs: 100,
    refreshHz: 60,
    frames: 6,
    hitches: [],
    verdict: "smooth",
    confidence: "high",
    notes: [],
  });
  expect(
    await measurementFilmstrip([{ atMs: 0, data: "AAAA" }], measurement, undefined),
  ).toBeUndefined();
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
